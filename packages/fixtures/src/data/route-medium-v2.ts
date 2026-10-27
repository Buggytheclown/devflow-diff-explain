import type {
    RouteAnchor,
    RouteSectionResult,
    RouteSkeletonResult,
    RouteSnapshot,
    RouteStop,
    RouteStopChange,
    UiRouteState,
} from '@sherpa/protocol';

import { hashHex, makeFileId } from '../patch.js';
import { MEDIUM_BASE_COMMIT, MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT_V2 } from './medium.js';
import type { DigestEntry, StopSpec } from './route-medium.js';
import {
    acceptedClaims,
    canonical,
    droppedCount,
    makeMediumBrokenResults,
    makeMediumSkeletonResult,
    MODEL_STOPS,
    otherStop,
    P,
    rawAnchors,
    rawClaims,
    SNAPSHOT_ID,
    SUMMARY_PARTS,
    TOUR_ORDER,
    UNCOVERED_PAYMENTS,
} from './route-medium.js';

/**
 * Маршрут той же фикстуры `medium` после второго пуша (`docs/architecture.md`): план тот же, но три стопа
 * пересобраны — 02 и 03 изменились, 06 собран заново. Прогресс перенесён с первого снапшота:
 * три стопа из шести с якорями остались просмотренными.
 *
 * Якоря пересчитаны под вторую итерацию: `edit-policy.ts` и `handlers.ts` подросли на несколько
 * строк, `card-token.ts` из PR ушёл, `api/rejection-status.ts` появился.
 */

const SNAPSHOT_ID_V2 = 'route-medium-a71d4e2';
const CREATED_AT_V2 = '2026-08-21T11:12:40.000Z';

/**
 * Сколько отмеченных стопов первого захода пережили пуш. Знаменатель — стопы с якорями:
 * шесть модельных, «Прочее» перенос накрыть не может. Изменились три — остались три.
 */
const CARRIED = { kept: 3, total: 6, zeroReason: null } as const;

/**
 * Выжимка второго захода: пересобран только абзац про внешний контракт — появился сборщик тела
 * отказа, а маскирование PAN ушло из PR вместе с `card-token.ts`. Остальные абзацы пуш не задел.
 */
const SUMMARY_V2 = SUMMARY_PARTS.map((part, index) =>
    index === 1
        ? 'Внешний контракт стал шире: `patchOrder` валидирует тело схемой и отвечает 409 или 400 с человеческим объяснением, `getEditWindow` отдаёт решение целиком, а тело отказа собирает новый `api/rejection-status.ts` — остаток времени приезжает только для закрытого окна. Записи PCI-аудита получили остаток времени и момент записи, а сгенерированная схема PSP переехала с `pan` на `token`; маскирование PAN уехало из PR вместе с `card-token.ts`.'
        : part,
).join('\n\n');

/** Замыслы стопов в плане второго захода: у 03 из перечисления ушла платёжная часть. */
const INTENT_V2: Record<string, string> = {
    s03: 'HTTP-контракт ручек, новый сборщик тела отказа, схемы запроса и ответа, записи PCI-аудита и документ с правилами.',
};

/** Дайджест второго захода: непокрытым остался только `recordedAt` — маскировать PAN в PR уже нечего. */
function digestV2(entries: readonly DigestEntry[]): DigestEntry[] {
    return entries.map((entry) =>
        entry === UNCOVERED_PAYMENTS
            ? {
                  ...entry,
                  text: 'Поле recordedAt в записях PCI-аудита не покрыто — тестов на платёжный контур в диффе нет.',
              }
            : entry,
    );
}

function at(path: string, side: 'old' | 'new', start: number, end: number, collapsed = false): RouteAnchor {
    return { fileId: makeFileId(MEDIUM_DIFF_ID_V2, path), path, side, start, end, collapsed };
}

/** Неизменившийся стоп: те же диапазоны, но `fileId` резолвится против новой итерации. */
function reanchor(anchors: readonly RouteAnchor[]): RouteAnchor[] {
    return anchors.map((anchor) => ({ ...anchor, fileId: makeFileId(MEDIUM_DIFF_ID_V2, anchor.path) }));
}

interface StopChangeSpec {
    kind: RouteStopChange['kind'];
    reason: string;
    threadIds?: string[];
    paragraph: string;
    anchors: RouteAnchor[];
}

/**
 * Что второй пуш сделал с каждым затронутым стопом. `changed` — задета часть диапазонов,
 * `new` — все: лок пересобран целиком, от прежнего блока не осталось ни строки. У лока в v2
 * размечена только сторона `new`: base у итераций общий, старая сторона переносится тождественно,
 * и якорь на ней сделал бы стоп `changed`.
 */
const CHANGED: Record<string, StopChangeSpec> = {
    s02: {
        kind: 'changed',
        reason: 'Автор закрыл замечание линтера: в `switch` появилась ветка `default`, а список причин отказа стал константой `EDIT_REJECTIONS`.',
        paragraph:
            '`EditPolicy` по-прежнему получает `EditWindow` и возвращает решение с машинным кодом отказа, но список кодов стал явной константой `EDIT_REJECTIONS`, а `switch` закрыт веткой `default` с проверкой на `never`. В `Order` ничего не изменилось: поля `slot` и `scheduled` обязательны, дублирующий флаг `editable` по-прежнему удалён. Следствие: новый код отказа теперь нельзя добавить молча — компилятор потребует разобрать его в политике.',
        anchors: [
            at(P.policy, 'old', 2, 2),
            at(P.policy, 'new', 2, 2),
            at(P.policy, 'old', 6, 6),
            at(P.policy, 'new', 6, 6),
            at(P.policy, 'new', 8, 11),
            at(P.policy, 'old', 25, 25),
            at(P.policy, 'new', 29, 29),
            at(P.policy, 'old', 28, 34),
            at(P.policy, 'new', 32, 49),
            at(P.policy, 'new', 51, 62),
            at(P.order, 'old', 16, 16),
            at(P.order, 'new', 16, 18),
            at(P.order, 'old', 37, 38),
            at(P.order, 'new', 39, 40),
            at(P.order, 'new', 42, 46),
            at(P.order, 'new', 62, 76),
        ],
    },
    s03: {
        kind: 'changed',
        reason: 'По замечанию Айрис остаток времени уехал в `api/rejection-status.ts` и возвращается только для `edit-window-closed`; маскирование PAN ушло из PR вместе с `card-token.ts`, аудит и схема PSP остались.',
        threadIds: ['4820242'],
        paragraph:
            'Тело отказа собирает новый `api/rejection-status.ts`: `remainingMs` возвращается только для `edit-window-closed`, у остальных причин его в ответе больше нет. Ручки `patchOrder` и `getEditWindow` по-прежнему валидируют тело схемой, записи PCI-аудита получают `recordedAt`, а сгенерированная схема PSP осталась на v4 с `token` вместо `pan`; из платёжной части PR ушло только маскирование PAN в логе `reauthorize` — вместе с `card-token.ts`. Следствие: контракт ответа стал точнее, а PCI-периметр PR сузился до аудита и сгенерированной схемы.',
        anchors: [
            at(P.handlers, 'old', 2, 2),
            at(P.handlers, 'new', 2, 5),
            at(P.handlers, 'old', 5, 5),
            at(P.handlers, 'new', 8, 10),
            at(P.handlers, 'old', 42, 45),
            at(P.handlers, 'new', 47, 52),
            at(P.handlers, 'old', 49, 49),
            at(P.handlers, 'new', 56, 57),
            at(P.handlers, 'old', 70, 70),
            at(P.handlers, 'new', 78, 89),
            at('services/orders/src/api/rejection-status.ts', 'new', 1, 19),
            at(P.schemas, 'old', 9, 9),
            at(P.schemas, 'new', 9, 11),
            at(P.schemas, 'new', 14, 15),
            at(P.schemas, 'new', 30, 38),
            at(P.pciAudit, 'old', 18, 18),
            at(P.pciAudit, 'new', 18, 24),
            at(P.pciAudit, 'old', 21, 22),
            at(P.pciAudit, 'new', 27, 33),
            at(P.logging, 'old', 31, 31),
            at(P.logging, 'new', 31, 31),
            at(P.logging, 'old', 34, 37),
            at(P.logging, 'new', 34, 37),
            at(P.logging, 'new', 52, 53),
            at(P.logging, 'new', 55, 61),
            at(P.pspSchema, 'new', 3, 3),
            at(P.pspSchema, 'new', 7, 8),
            at(P.docs, 'new', 1, 52),
        ],
    },
    s06: {
        kind: 'new',
        reason: 'Лок пересобран заново: от прежнего блока не осталось ни одной строки, читать построчно снова нечего.',
        paragraph:
            '`pnpm-lock.yaml` пересобран второй раз подряд, и от блока прошлого захода не осталось ни одной строки — весь диапазон стопа новый. Следствие: сравнивать его с прошлым снапшотом бесполезно, размечена только новая сторона и та помечена свёрнутой.',
        anchors: [at(P.lock, 'new', 15, 231, true)],
    },
};

/**
 * Стопы, у которых пуш не задел ни одного якоря, но текст устарел: `card-token.ts` ушёл из PR,
 * и непокрытого тестами маскирования PAN в нём больше нет (в дайджесте это правит `digestV2`).
 * Классификации у таких стопов нет.
 */
const REPHRASED: Record<string, string> = {
    s04: 'Тесты окна написаны с нуля, тесты политики и ручек переписаны под новые коды отказа: закреплены граница в 30 минут, досрочная отправка, экспресс без окна и категорийные переопределения. Два утверждения проверяют меньше, чем обещают именем, а запись `recordedAt` в PCI-аудите не покрыта вовсе. Следствие: поведение окна держится на тестах, а записи аудита — только на чтении кода.',
};

function changeOf(id: string): RouteStopChange | null {
    const spec = CHANGED[id];
    if (spec === undefined) {
        return null;
    }
    return { kind: spec.kind, reason: spec.reason, threadIds: spec.threadIds ?? [] };
}

/** Стоп второго захода: у затронутых — свои якоря и абзац, у остальных те же, но с новыми `fileId`. */
function stopSpecV2(spec: StopSpec): StopSpec {
    const base: StopSpec = {
        ...spec,
        intent: INTENT_V2[spec.id] ?? spec.intent,
        digest: digestV2(spec.digest),
    };
    const changed = CHANGED[spec.id];
    if (changed === undefined) {
        const rephrased = REPHRASED[spec.id];
        return {
            ...base,
            paragraph: rephrased ?? spec.paragraph,
            anchors: reanchor(spec.anchors),
        };
    }
    return { ...base, paragraph: changed.paragraph, anchors: changed.anchors };
}

const MODEL_STOPS_V2: StopSpec[] = MODEL_STOPS.map(stopSpecV2);

function filledStopV2(spec: StopSpec): RouteStop {
    return {
        id: spec.id,
        planIndex: spec.planIndex,
        tier: spec.tier,
        title: spec.title,
        status: 'ready',
        paragraph: spec.paragraph,
        bridge: spec.bridge,
        anchors: spec.anchors,
        tests: acceptedClaims(spec.digest),
        droppedClaims: droppedCount(spec.digest),
        validationNotes: spec.validationNotes,
        provenance: null,
        change: changeOf(spec.id),
    };
}

function readySnapshotV2(): RouteSnapshot {
    const base: RouteSnapshot = {
        snapshotId: SNAPSHOT_ID_V2,
        commit: MEDIUM_HEAD_COMMIT_V2,
        baseCommit: MEDIUM_BASE_COMMIT,
        diffId: MEDIUM_DIFF_ID_V2,
        createdAt: CREATED_AT_V2,
        provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: null },
        previousSnapshotId: SNAPSHOT_ID,
        carried: { ...CARRIED },
        summary: SUMMARY_V2,
        stops: [...MODEL_STOPS_V2.map(filledStopV2), otherStop()],
        tourOrder: TOUR_ORDER,
        contentHash: null,
    };
    return { ...base, contentHash: hashHex(canonical(base), 16) };
}

/** Готовый маршрут второго захода — состояние для галереи «Итерации». */
export function makeMediumSecondPassState(): UiRouteState {
    return {
        phase: 'ready',
        smallPr: false,
        snapshot: readySnapshotV2(),
        failure: null,
        // Маршрут построен по активной итерации — устаревания нет.
        stale: null,
    };
}

/** План второго захода тот же: пуш меняет содержимое стопов и выжимку, а не состав плана. */
export function makeMediumSkeletonResultV2(): RouteSkeletonResult {
    return {
        ...makeMediumSkeletonResult(),
        summary: SUMMARY_V2,
        stops: MODEL_STOPS_V2.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
    };
}

/**
 * Секции второго захода: у трёх затронутых стопов модель объясняет «why this stop changed»,
 * у остальных объяснения нет — валидатор такое поле у них и отбросил бы.
 */
export function makeMediumSectionResultsV2(): RouteSectionResult[] {
    return MODEL_STOPS_V2.map((spec) => {
        const changed = CHANGED[spec.id];
        return {
            stops: [
                {
                    planIndex: spec.planIndex,
                    paragraph: spec.paragraph,
                    ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                    ...(changed === undefined ? {} : { changeReason: changed.reason }),
                    ...(changed?.threadIds === undefined ? {} : { changeThreadIds: changed.threadIds }),
                    anchors: rawAnchors(spec),
                    ...(spec.digest.length === 0 ? {} : { tests: rawClaims(spec.digest) }),
                },
            ],
        };
    });
}

/** Битые выводы у второго захода те же: они про валидатор, а не про итерацию. */
export function makeMediumBrokenResultsV2(): ReturnType<typeof makeMediumBrokenResults> {
    return makeMediumBrokenResults();
}
