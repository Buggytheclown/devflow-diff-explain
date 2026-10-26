import type {
    RouteAnchor,
    RouteSectionResult,
    RouteSkeletonResult,
    RouteSnapshot,
    RouteStop,
    RouteTestClaim,
    RouteTestClaimKind,
    UiRouteState,
} from '@sherpa/protocol';

import { hashHex, makeFileId } from '../patch.js';
import { MEDIUM_BASE_COMMIT, MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT } from './medium.js';

/**
 * Маршрут для фикстуры `medium` — тот же PR «Enforce the 30-minute edit window…» (`docs/design/README.md §1–2`).
 * Данные детерминированные: галерея состояний, e2e и голден-корпус валидатора обязаны
 * видеть одни и те же числа.
 *
 * План — 7 стопов: 01–02 high, 03 medium, 04 medium (поведенческий дайджест тестов), 05–06 low,
 * 07 — синтетическое «Прочее» (id `other`, tier `other`, пустые якоря;
 * его содержимое — непокрытые диапазоны — UI считает сам).
 *
 * Полоса дизайн-хендоффа («862 changed lines · 96% explained · 34 lines not explained») снята
 * до картинок: якоря по-прежнему покрывают те же 828 изменённых строк, но добавленная `countdown-icon.svg`
 * маршруту не видна (картинки — всегда «Прочее»), и её 6 строк патча идут в непокрытые. Итого 868
 * изменённых строк, непокрыты 40 в четырёх файлах — `CODEOWNERS` (5), `ci.yml` (12), хвост
 * сгенерированной `psp-schema.ts` (17) и svg (6).
 * В статистике покрытия UI из них 38 (`psp-schema.ts` 15): две пустые строки её хвоста вне
 * якорей выпадают из счёта по правилу пробельных строк.
 * По тирам: high 196, medium 327, low 305 строк (дизайнерские 188/348/292 — та же пропорция полосы).
 * Все числа пересчитываются из патчей диффа тестом `route.test.ts`, а не берутся на веру.
 *
 * Якорь покрывает только изменённые строки одной стороны: контекст внутрь диапазона не попадает,
 * поэтому у файла с мелкими правками якорей много (по одному на слитный кусок правки).
 */

export const SNAPSHOT_ID = 'route-medium-9f3c1ab';
const CREATED_AT = '2026-08-20T09:04:12.000Z';

/** Пути файлов диффа `medium`, на которые ссылаются якоря. */
export const P = {
    window: 'services/orders/src/domain/edit-window.ts',
    clock: 'services/orders/src/infra/clock.ts',
    policy: 'services/orders/src/domain/policies/edit-policy.ts',
    order: 'services/orders/src/domain/order.ts',
    handlers: 'services/orders/src/api/handlers.ts',
    schemas: 'services/orders/src/api/schemas.ts',
    pciAudit: 'services/orders/src/payments/pci-audit.ts',
    cardToken: 'services/orders/src/payments/card-token.ts',
    logging: 'services/orders/src/infra/logging.ts',
    pspSchema: 'services/orders/src/payments/generated/psp-schema.ts',
    docs: 'services/orders/docs/edit-window.md',
    readme: 'services/orders/README.md',
    lock: 'pnpm-lock.yaml',
    policyTest: 'services/orders/src/domain/__tests__/edit-policy.test.ts',
    windowTest: 'services/orders/src/domain/__tests__/edit-window.test.ts',
    handlersTest: 'services/orders/src/api/__tests__/handlers.test.ts',
} as const;

/**
 * Файла в диффе нет: тест-файлы импортируют из него хелперы, но сам он не менялся.
 * Утверждения дайджеста, заякоренные сюда, валидатор отбрасывает (`docs/design/SPEC-elements.md §4.3`).
 */
const FACTORIES_PATH = 'services/orders/src/domain/__tests__/factories.ts';

function at(path: string, side: 'old' | 'new', start: number, end: number, collapsed = false): RouteAnchor {
    return { fileId: makeFileId(MEDIUM_DIFF_ID, path), path, side, start, end, collapsed };
}

function claim(
    kind: RouteTestClaimKind,
    text: string,
    anchor: { path: string; line: number } | null,
): RouteTestClaim {
    return {
        kind,
        text,
        anchor:
            anchor === null
                ? null
                : { fileId: makeFileId(MEDIUM_DIFF_ID, anchor.path), path: anchor.path, line: anchor.line },
    };
}

/**
 * Утверждение дайджеста в том виде, как его отдала модель: якорь — путь и строка тестового файла.
 * `dropped: true` — валидатор его отбросит, потому что якорь ведёт в файл вне диффа; в снапшот
 * такое утверждение не попадает и учитывается только счётчиком `droppedClaims`.
 */
export interface DigestEntry {
    kind: RouteTestClaimKind;
    text: string;
    test: { path: string; line: number } | null;
    dropped?: true;
}

/**
 * Стоп плана модели: то, что приезжает скелетом (title, tier, intent) плюс заполнение секцией.
 * `intent` — черновой замысел для задач заполнения, в UI не показывается.
 */
export interface StopSpec {
    id: string;
    planIndex: number;
    tier: 'high' | 'medium' | 'low';
    title: string;
    intent: string;
    paragraph: string;
    bridge: string | null;
    anchors: RouteAnchor[];
    /** Дайджест как его отдала модель; снапшот и `droppedClaims` считаются отсюда. */
    digest: DigestEntry[];
    validationNotes: string[];
}

/** Утверждение про платёжный контур: у второй итерации свой текст (`card-token.ts` ушёл из PR). */
export const UNCOVERED_PAYMENTS: DigestEntry = {
    kind: 'uncovered',
    text: 'Маскирование PAN в логе reauthorize и поле recordedAt в записях PCI-аудита не покрыты — тестов на платёжный контур в диффе нет.',
    test: null,
};

/**
 * Дайджест стопа 04: модель отдала 14 утверждений, валидатор принял 12 —
 * 6 `new`, 2 `changed`, 2 `weakened`, 2 `uncovered`. Отброшены два: якорь ведёт
 * в `__tests__/factories.ts`, которого в диффе нет.
 * У `uncovered` якоря на тест нет по построению: одно указывает на код без покрытия,
 * второе — вообще без якоря (в диффе нет файла, в который его можно было бы поставить).
 */
const DIGEST: DigestEntry[] = [
    {
        kind: 'new',
        text: 'Окно открыто сразу после оформления заказа — `isOpen` истинно.',
        test: { path: P.windowTest, line: 10 },
    },
    {
        kind: 'new',
        text: 'Через 30 минут и одну миллисекунду окно закрыто.',
        test: { path: P.windowTest, line: 17 },
    },
    {
        kind: 'new',
        text: 'У экспресс-слота (`scheduled: false`) окна нет вовсе.',
        test: { path: P.windowTest, line: 24 },
    },
    {
        kind: 'new',
        text: 'Заказ для случаев открытого окна собирается фабрикой makeOrder с запланированным слотом по умолчанию.',
        test: { path: FACTORIES_PATH, line: 12 },
        dropped: true,
    },
    {
        kind: 'new',
        text: 'Отправка курьеру закрывает окно досрочно, с причиной `dispatch`.',
        test: { path: P.windowTest, line: 44 },
    },
    {
        kind: 'new',
        text: 'Отправка позже дедлайна окно не закрывает — выигрывает дедлайн.',
        test: { path: P.windowTest, line: 57 },
    },
    {
        kind: 'new',
        text: 'Свежие продукты укорачивают окно до 10 минут, аптека — до 5, в смешанной корзине выигрывает самое короткое.',
        test: { path: P.windowTest, line: 64 },
    },
    {
        kind: 'changed',
        text: 'Закрытое окно отвечает 409 и телом {error, remainingMs}; раньше тот же тест ждал 400 на «заказ без слота».',
        test: { path: P.handlersTest, line: 19 },
    },
    {
        kind: 'changed',
        text: 'Фабрика makeSlot научилась отдавать экспресс-слот — на нём проверяется отсутствие окна.',
        test: { path: FACTORIES_PATH, line: 24 },
        dropped: true,
    },
    {
        kind: 'changed',
        text: 'Аудит принятой правки сверяется по содержимому записи (kind, orderId), а не по длине массива.',
        test: { path: P.handlersTest, line: 76 },
    },
    {
        kind: 'weakened',
        text: 'Тест «reports the remaining time while the window is open» проверяет только статус 204 — остаток времени в ответе не утверждается, хотя обещан именем.',
        test: { path: P.handlersTest, line: 25 },
    },
    {
        kind: 'weakened',
        text: 'Экспресс-заказ сверяется только по полю reason: соседние случаи сравнивают решение целиком, здесь allowed не утверждается.',
        test: { path: P.policyTest, line: 42 },
    },
    {
        kind: 'uncovered',
        text: 'Формулировка для экспресс-доставки («Express delivery cannot be rescheduled») не проверена: explain разобран только для закрытого окна.',
        test: { path: P.window, line: 92 },
    },
    UNCOVERED_PAYMENTS,
];

/** Принятые валидатором утверждения: у отброшенных якорь ведёт в файл вне диффа. */
export function acceptedClaims(entries: readonly DigestEntry[]): RouteTestClaim[] {
    return entries
        .filter((entry) => entry.dropped !== true)
        .map((entry) => claim(entry.kind, entry.text, entry.test));
}

export function droppedCount(entries: readonly DigestEntry[]): number {
    return entries.filter((entry) => entry.dropped === true).length;
}

/** Стопы, которые придумала модель. «Прочее» синтезирует сервер и в скелете его нет. */
export const MODEL_STOPS: StopSpec[] = [
    {
        id: 's01',
        planIndex: 1,
        tier: 'high',
        title: 'Окно редактирования стало доменным понятием',
        intent: 'Новый класс EditWindow и инжектируемый Clock: где живёт правило 30 минут и почему оно тестируемо.',
        paragraph: [
            'Появился класс `EditWindow` и инжектируемый источник времени `Clock`: окно открывается в момент оформления заказа и закрывается через `EDIT_WINDOW_MS`, а отправка курьером закрывает его досрочно.',
            '',
            'Категории укорачивают окно:',
            '- свежие продукты — 10 минут',
            '- аптека — 5 минут',
            '- остальное — общие 30 минут',
            '',
            'В корзине выигрывает **самое короткое** окно. Следствие: «можно ли ещё править заказ» считается ровно в одном месте и зависит от часов, которые в тестах подменяет [`FrozenClock`](#file-services/orders/src/infra/clock.ts). Порядок выката — в [#2281](https://github.com/quillmart/quillmart/issues/2281).',
        ].join('\n'),
        bridge: 'Дальше — как политика редактирования перестала считать часы сама.',
        anchors: [at(P.window, 'new', 1, 94), at(P.clock, 'new', 1, 33)],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's02',
        planIndex: 2,
        tier: 'high',
        title: 'Политика решает по `EditWindow`, а не по часам',
        intent: 'EditPolicy переехала на EditWindow и машинные коды отказа; модель заказа стала строгой.',
        paragraph:
            '`EditPolicy` больше не принимает число часов — она получает `EditWindow` и возвращает решение с машинным кодом отказа (`edit-window-closed`, `already-dispatched`, `not-scheduled`) вместо свободной строки. В `Order` поля `slot` и `scheduled` стали обязательными, появились `items` и `dispatchedAt`, а дублирующий флаг `editable` исчез. Следствие: каждый вызывающий обязан разобрать три причины отказа, и прочитать «editable» мимо политики больше нельзя.',
        bridge: 'Ниже — что из этого увидел внешний мир: коды ответов, аудит и документация.',
        anchors: [
            at(P.policy, 'old', 2, 2),
            at(P.policy, 'new', 2, 2),
            at(P.policy, 'old', 6, 6),
            at(P.policy, 'new', 6, 6),
            at(P.policy, 'new', 8, 9),
            at(P.policy, 'old', 25, 25),
            at(P.policy, 'new', 27, 27),
            at(P.policy, 'old', 28, 34),
            at(P.policy, 'new', 30, 43),
            at(P.policy, 'new', 45, 56),
            at(P.order, 'old', 16, 16),
            at(P.order, 'new', 16, 18),
            at(P.order, 'old', 37, 38),
            at(P.order, 'new', 39, 40),
            at(P.order, 'new', 42, 46),
            at(P.order, 'new', 62, 76),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's03',
        planIndex: 3,
        tier: 'medium',
        title: 'Периметр: коды отказов, аудит и записанные правила',
        intent: 'HTTP-контракт ручек, схемы запроса и ответа, записи PCI-аудита, маскирование PAN и новый документ с правилами.',
        paragraph: [
            'Ручки `patchOrder` и `getEditWindow` теперь валидируют тело схемой и отдают остаток времени вместе с человеческим объяснением. Код отказа отображается в HTTP-статус:',
            '',
            '1. `edit-window-closed` — 409',
            '2. `already-dispatched` — 409',
            '3. `not-scheduled` — 400',
            '',
            'Записи PCI-аудита получили `remainingMs` и `recordedAt`, лог `reauthorize` маскирует PAN, а переезд на PSP v4 заменил в запросе `pan` на `token`. Следствие: контракт ответа стал шире и целиком описан в новом `docs/edit-window.md`, а клиентский обратный отсчёт официально справочный — сервер пересчитывает окно сам.',
        ].join('\n'),
        bridge: 'Проверку всего этого модель собрала в дайджест следующего стопа.',
        anchors: [
            at(P.handlers, 'old', 2, 2),
            at(P.handlers, 'new', 2, 4),
            at(P.handlers, 'old', 5, 5),
            at(P.handlers, 'new', 7, 9),
            at(P.handlers, 'old', 42, 45),
            at(P.handlers, 'new', 46, 54),
            at(P.handlers, 'old', 49, 49),
            at(P.handlers, 'new', 58, 59),
            at(P.handlers, 'old', 70, 70),
            at(P.handlers, 'new', 80, 91),
            at(P.schemas, 'old', 9, 9),
            at(P.schemas, 'new', 9, 11),
            at(P.schemas, 'new', 14, 15),
            at(P.schemas, 'new', 30, 38),
            at(P.pciAudit, 'old', 18, 18),
            at(P.pciAudit, 'new', 18, 24),
            at(P.pciAudit, 'old', 21, 22),
            at(P.pciAudit, 'new', 27, 33),
            at(P.cardToken, 'old', 45, 45),
            at(P.cardToken, 'new', 45, 49),
            at(P.cardToken, 'old', 47, 47),
            at(P.cardToken, 'new', 51, 51),
            at(P.cardToken, 'new', 53, 56),
            at(P.logging, 'old', 31, 31),
            at(P.logging, 'new', 31, 31),
            at(P.logging, 'old', 34, 37),
            at(P.logging, 'new', 34, 37),
            at(P.logging, 'new', 52, 53),
            at(P.logging, 'new', 55, 61),
            // Из сгенерированной схемы PSP размечена только замена поля `pan` на `token`;
            // хвост файла остаётся в «Прочем» — так и было задумано.
            at(P.pspSchema, 'new', 3, 3),
            at(P.pspSchema, 'new', 7, 8),
            at(P.docs, 'new', 1, 52),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's04',
        planIndex: 4,
        tier: 'medium',
        title: 'Поведение под тестами: 12 утверждений',
        intent: 'Поведенческий дайджест: что закреплено тестами окна, политики и ручек, где утверждение ослабло и где поведение осталось без проверки.',
        paragraph:
            'Тесты окна написаны с нуля, тесты политики и ручек переписаны под новые коды отказа: закреплены граница в 30 минут, досрочная отправка, экспресс без окна и категорийные переопределения. Два утверждения проверяют меньше, чем обещают именем, а маскирование PAN и запись `recordedAt` не покрыты вовсе. Следствие: поведение окна держится на тестах, а платёжная часть правки — только на чтении кода.',
        bridge: 'Остаток диффа — сопровождение: README и обновление зависимостей.',
        anchors: [
            at(P.policyTest, 'old', 5, 5),
            at(P.policyTest, 'new', 5, 7),
            at(P.policyTest, 'old', 7, 7),
            at(P.policyTest, 'new', 9, 10),
            at(P.policyTest, 'new', 28, 54),
            at(P.windowTest, 'new', 1, 92),
            at(P.handlersTest, 'old', 19, 21),
            at(P.handlersTest, 'new', 19, 27),
            at(P.handlersTest, 'new', 29, 51),
            at(P.handlersTest, 'old', 47, 47),
            at(P.handlersTest, 'new', 76, 85),
        ],
        digest: DIGEST,
        validationNotes: [
            `Два утверждения отброшены: якорь вёл в \`${FACTORIES_PATH}\`, которого нет в этом диффе.`,
        ],
    },
    {
        id: 's05',
        planIndex: 5,
        tier: 'low',
        title: '`README.md` догоняет новую раскладку домена',
        intent: 'Раздел про домен и раздел про тесты: новые файлы, ушедший конфиг, правило про FrozenClock.',
        paragraph:
            'Раздел про домен называет `edit-window.ts` и `infra/clock.ts` и перестал ссылаться на конфиг `checkout.edit_window_hours`, а раздел про тесты требует `FrozenClock` вместо `Date.now()` в `domain/`. Следствие: правило про часы и команда запуска тестов окна лежат там, где их ищут первыми.',
        bridge: 'Последнее — машинные строки лок-файла.',
        anchors: [
            at(P.readme, 'old', 25, 26),
            at(P.readme, 'new', 25, 27),
            at(P.readme, 'old', 42, 42),
            at(P.readme, 'new', 43, 52),
            at(P.docs, 'new', 53, 115),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's06',
        planIndex: 6,
        tier: 'low',
        title: 'Обновление лок-файла',
        intent: 'Машинный шум переезда на PSP v4: лок пересобран целиком, читать построчно нечего.',
        paragraph:
            '`pnpm-lock.yaml` пересобран целиком: 217 добавленных строк против 9 удалённых — машинный след переезда на PSP v4. Следствие: построчно читать нечего, важен только факт пересборки тем же менеджером пакетов, поэтому оба якоря помечены свёрнутыми.',
        bridge: null,
        anchors: [at(P.lock, 'old', 15, 23, true), at(P.lock, 'new', 15, 231, true)],
        digest: [],
        validationNotes: [],
    },
];

/** Абзацы выжимки по отдельности: второй заход пересобирает только тот, что описывает контракт. */
export const SUMMARY_PARTS = [
    'PR вводит 30-минутное окно редактирования запланированной доставки как доменное понятие. Появились `EditWindow` и инжектируемый `Clock`; `EditPolicy` перестала считать часы сама и возвращает машинный код отказа, а модель заказа лишилась необязательных полей и дублирующего флага `editable`.',
    [
        'Внешний контракт стал шире — он собран в [периметре](#stop-3):',
        '- `patchOrder` валидирует тело схемой и отвечает 409 или 400 с остатком времени и человеческим объяснением;',
        '- `getEditWindow` отдаёт решение целиком;',
        '- записи PCI-аудита получили остаток времени и момент записи, PAN в логе `reauthorize` маскируется.',
        '',
        'Сгенерированная схема PSP переехала с `pan` на `token`: **старое поле больше не уходит** в запросе.',
    ].join('\n'),
    'Правила описаны в новом [`docs/edit-window.md`](#file-services/orders/docs/edit-window.md) вместе с порядком выката за флагом `checkout_edit_window`. Тесты окна написаны с нуля, тесты политики и ручек переписаны; вне маршрута остались правила владельцев `CODEOWNERS`, машинный `ci.yml` и хвост сгенерированной схемы PSP.',
];

export const SUMMARY = SUMMARY_PARTS.join('\n\n');

/**
 * Порядок полного тура: точка входа (периметр и правила) → определения (окно, политика)
 * → следствия (README, зависимости) → верификация (дайджест тестов), «Прочее» последним.
 */
export const TOUR_ORDER = ['s03', 's01', 's02', 's05', 's06', 's04', 'other'];

/** Синтетическое «Прочее»: заголовок задаёт сервер, содержимое считает UI по непокрытым диапазонам. */
export function otherStop(): RouteStop {
    return {
        id: 'other',
        planIndex: MODEL_STOPS.length + 1,
        tier: 'other',
        title: 'Прочее — модель не разместила эти строки',
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

export function filledStop(spec: StopSpec): RouteStop {
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
        change: null,
    };
}

/** Плановый слот до заполнения: заголовок и номер уже зафиксированы скелетом, содержимого нет. */
function plannedStop(spec: StopSpec, status: 'queued' | 'filling'): RouteStop {
    return {
        id: spec.id,
        planIndex: spec.planIndex,
        tier: spec.tier,
        title: spec.title,
        status,
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

/** Канонический JSON: ключи по алфавиту, чтобы отпечаток не зависел от порядка полей в литералах. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function snapshot(stops: RouteStop[], hashed: boolean): RouteSnapshot {
    const base: RouteSnapshot = {
        snapshotId: SNAPSHOT_ID,
        commit: MEDIUM_HEAD_COMMIT,
        baseCommit: MEDIUM_BASE_COMMIT,
        diffId: MEDIUM_DIFF_ID,
        createdAt: CREATED_AT,
        provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: null },
        previousSnapshotId: null,
        carried: null,
        summary: SUMMARY,
        stops,
        tourOrder: TOUR_ORDER,
        contentHash: null,
    };
    // Хеш считается по готовому снапшоту и только по нему — в фазе filling его нет.
    return hashed ? { ...base, contentHash: hashHex(canonical(base), 16) } : base;
}

function readySnapshot(): RouteSnapshot {
    return snapshot([...MODEL_STOPS.map(filledStop), otherStop()], true);
}

/**
 * Частично заполненный маршрут ровно как в `docs/design/README.md §7`: готовы 01, 02 и 05 — «3 of 7 ready»,
 * огоньки не слева направо; 06 в работе, 03 и 04 ждут очереди, «Прочее» готово сразу.
 */
function fillingSnapshot(): RouteSnapshot {
    const ready = new Set(['s01', 's02', 's05']);
    const stops = MODEL_STOPS.map((spec) => {
        if (ready.has(spec.id)) {
            return filledStop(spec);
        }
        return plannedStop(spec, spec.id === 's06' ? 'filling' : 'queued');
    });
    return snapshot([...stops, otherStop()], false);
}

/**
 * Сырой вывод модели, на котором валидатор остановил генерацию: два стопа ссылаются на файл,
 * которого нет в диффе. Показывается в «Open raw output» (`docs/design/README.md §12`) — это вывод модели,
 * а не отчёт валидатора.
 */
const FAILED_RAW_OUTPUT = `{
  "summary": "PR вводит 30-минутное окно редактирования запланированной доставки…",
  "stops": [
    {
      "planIndex": 1,
      "paragraph": "Состояние заказа переехало в отдельный модуль…",
      "anchors": [
        { "path": "services/orders/src/domain/order-state.ts", "side": "new", "start": 1, "end": 64 }
      ]
    },
    {
      "planIndex": 2,
      "paragraph": "Политика редактирования читает состояние заказа…",
      "anchors": [
        { "path": "services/orders/src/domain/order-state.ts", "side": "new", "start": 66, "end": 91 },
        { "path": "services/orders/src/domain/policies/edit-policy.ts", "side": "new", "start": 30, "end": 43 }
      ]
    }
  ]
}`;

/** Состояния маршрута фикстуры `medium` для галереи: по одному на фазу `uiRoutePhaseSchema`. */
export function makeMediumRouteStates(): Record<'none' | 'reading' | 'filling' | 'ready' | 'failed', UiRouteState> {
    return {
        none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
        reading: { phase: 'reading', smallPr: false, snapshot: null, failure: null, stale: null },
        filling: { phase: 'filling', smallPr: false, snapshot: fillingSnapshot(), failure: null, stale: null },
        ready: { phase: 'ready', smallPr: false, snapshot: readySnapshot(), failure: null, stale: null },
        failed: {
            phase: 'failed',
            smallPr: false,
            snapshot: null,
            stale: null,
            failure: {
                message:
                    'Генерация остановлена на валидации: 2 стопа ссылаются на services/orders/src/domain/order-state.ts, которого нет в этом диффе.',
                rawOutput: FAILED_RAW_OUTPUT,
            },
        },
    };
}

/** Скелет глазами модели: «Прочего» в нём нет — его синтезирует сервер при приёме. */
export function makeMediumSkeletonResult(): RouteSkeletonResult {
    return {
        summary: SUMMARY,
        stops: MODEL_STOPS.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
        // Тот же тур, что и в снапшоте, но плановыми номерами и без синтетического «Прочего».
        tourOrder: TOUR_ORDER.filter((id) => id !== 'other').map((id) => {
            const spec = MODEL_STOPS.find((candidate) => candidate.id === id);
            if (spec === undefined) {
                throw new Error(`tourOrder ссылается на стоп ${id}, которого нет в плане`);
            }
            return spec.planIndex;
        }),
    };
}

/** Якоря модель отдаёт по `path` — `fileId` резолвит валидатор против активной итерации. */
export function rawAnchors(spec: StopSpec): RouteSectionResult['stops'][number]['anchors'] {
    return spec.anchors.map(({ path, side, start, end, collapsed }) =>
        collapsed ? { path, side, start, end, collapsed } : { path, side, start, end },
    );
}

/**
 * Дайджест целиком, как его отдала модель, — вместе с утверждениями, которые валидатор отбросит:
 * счётчик `droppedClaims` в снапшоте должен родиться отсюда, а не быть вписан руками.
 */
export function rawClaims(entries: readonly DigestEntry[]): NonNullable<RouteSectionResult['stops'][number]['tests']> {
    // У `uncovered` в `testPath` приезжает якорь на код: тестового якоря у такого утверждения нет.
    return entries.map((entry) =>
        entry.test === null
            ? { kind: entry.kind, text: entry.text }
            : { kind: entry.kind, text: entry.text, testPath: entry.test.path, testLine: entry.test.line },
    );
}

function sectionOf(spec: StopSpec): RouteSectionResult {
    return {
        stops: [
            {
                planIndex: spec.planIndex,
                paragraph: spec.paragraph,
                ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                anchors: rawAnchors(spec),
                ...(spec.digest.length === 0 ? {} : { tests: rawClaims(spec.digest) }),
            },
        ],
    };
}

/** По одной секции на каждый стоп плана, в план-порядке: fake-воркер e2e сдаёт их по очереди. */
export function makeMediumSectionResults(): RouteSectionResult[] {
    return MODEL_STOPS.map(sectionOf);
}

/**
 * Битые выводы модели для негативных тестов валидатора. Схемам протокола они
 * удовлетворяют — ломается именно семантика, поэтому через `parse` при сборке их не гоняют.
 */
export function makeMediumBrokenResults(): {
    sectionUnknownFile: RouteSectionResult;
    sectionRangeOutsideChanges: RouteSectionResult;
    skeletonTourOrderNotPermutation: RouteSkeletonResult;
} {
    return {
        sectionUnknownFile: {
            stops: [
                {
                    planIndex: 3,
                    paragraph: 'Состояние заказа переехало в отдельный модуль и политика читает его оттуда.',
                    anchors: [
                        { path: 'services/orders/src/domain/order-state.ts', side: 'new', start: 1, end: 64 },
                    ],
                },
            ],
        },
        sectionRangeOutsideChanges: {
            stops: [
                {
                    planIndex: 5,
                    paragraph: 'README описывает новую раскладку домена.',
                    // В файле 52 строки, и ни одна из них не менялась в этом диапазоне.
                    anchors: [{ path: P.readme, side: 'new', start: 400, end: 420 }],
                },
            ],
        },
        skeletonTourOrderNotPermutation: {
            ...makeMediumSkeletonResult(),
            // Стоп 3 назван дважды, стоп 4 не назван вовсе.
            tourOrder: [3, 1, 2, 5, 6, 3],
        },
    };
}
