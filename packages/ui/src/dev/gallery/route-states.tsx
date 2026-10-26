import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RegenerateBanner } from '../../views/route/other-card.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';

/**
 * Состояния вью маршрута — второй слой визуальной приёмки. Всё считается из фикстур
 * синхронно: модели диффа разбираются на месте, ручек нет, часы фиксированы. Открытие состояния
 * даёт один и тот же кадр.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
}

interface RouteStateProps {
    readonly snapshot?: RouteSnapshot;
    readonly filter?: string;
    readonly stops?: StopsState;
    /** Отметки остановок: в приложении их приносит сервер, в галерее — пропс. */
    readonly stopViewed?: readonly string[];
    readonly keptStopId?: string | null;
    /** Стартовый прогресс файлов: в приложении его приносит сервер. */
    readonly progress?: readonly UiFileProgress[];
}

function RouteState({
    snapshot = readySnapshot(),
    filter = 'all',
    stops = EMPTY_STOPS,
    stopViewed = [],
    keptStopId = null,
    progress = NO_PROGRESS,
}: RouteStateProps) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter, stops } }),
        [filter, stops],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files, progress });
        for (const file of DATA.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [progress]);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );
    const [underExplained, setUnderExplained] = useState(false);
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'route-under-explained',
                priority: 200,
                active: () => underExplained,
                render: () => <RegenerateBanner onGenerate={() => undefined} />,
            },
        ],
        [underExplained],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialKeptStopId={keptStopId}
                initialStopViewed={stopViewed}
                onUnderExplained={setUnderExplained}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

/**
 * Снапшот с урезанными якорями: непокрытого больше 40%, «Прочее» поднято в отдельную
 * остановку (docs/design/SPEC-elements.md §4.3).
 */
function underExplainedSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
        ),
    };
}

/** Якоря первой остановки уехали в файл, которого в диффе нет: дрейф (docs/design/SPEC-elements.md §2.9). */
function driftedSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01'
                ? { ...stop, anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'ушедший-файл' })) }
                : stop,
        ),
    };
}

/** Часть якорей остановки уехала: нотис встаёт над уцелевшими карточками (docs/design/SPEC-elements.md §2.9). */
function partialDriftSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's03'
                ? {
                      ...stop,
                      anchors: stop.anchors.map((anchor, index) =>
                          index === 0 ? { ...anchor, fileId: 'ушедший-файл' } : anchor,
                      ),
                  }
                : stop,
        ),
    };
}

/**
 * Остановка выше окна: длинное описание и все файлы маршрута в одной остановке. Прибитая
 * колонка обязана прокручиваться сама, не уводя за собой страницу.
 */
function tallStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    const anchors = snapshot.stops.flatMap((stop) => stop.anchors);
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01' ? { ...stop, paragraph: TALL_PARAGRAPH, anchors } : stop,
        ),
    };
}

/** Описание у верхней границы бюджета валидатора: столько текста ревьюер видит целиком. */
const TALL_PARAGRAPH = [
    'Появился класс `EditWindow` и инжектируемый источник времени `Clock`: окно открывается в момент оформления заказа, закрывается через `EDIT_WINDOW_MS` и досрочно — отправкой курьером.',
    '',
    'Категории укорачивают окно:',
    '- свежие продукты — 10 минут',
    '- аптека — 5 минут',
    '- алкоголь — окна нет вовсе',
    '- остальное — общие 30 минут',
    '',
    'В корзине выигрывает **самое короткое** окно, и ответ на вопрос «можно ли ещё править заказ» считается ровно в одном месте: в тестах часы подменяет [`FrozenClock`](#file-services/orders/src/infra/clock.ts), в проде — системные.',
    '',
    'Следствие: коды отказа разбирает [остановка 02](#stop-2), порядок выката описан в [#2281](https://github.com/quillmart/quillmart/issues/2281), а прежний конфиг `checkout.edit_window_hours` больше не читается никем.',
].join('\n');

/** Остановка без единого якоря: правая колонка обязана показать дашед-карточку, а не пустоту. */
function emptyStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, anchors: [] } : stop)),
    };
}

const NO_PROGRESS: readonly UiFileProgress[] = [];

/** Файл, разложенный по s03 (строки 1–52) и s05 (53–115): отмечена только карточка s03. */
function sharedFileProgress(): readonly UiFileProgress[] {
    const fileId = DATA.diff.files.find((file) => file.path === 'services/orders/docs/edit-window.md')?.fileId;
    if (fileId === undefined) {
        throw new Error('в фикстуре medium нет services/orders/docs/edit-window.md');
    }
    return [{ fileId, viewed: null, seenRanges: [{ side: 'new', start: 1, end: 52 }] }];
}

// Одна ссылка на все рендеры: стор диффа пересоздаётся по смене прогресса.
const SHARED_FILE_PROGRESS = sharedFileProgress();

function stopsState(patch: Partial<StopsState>): StopsState {
    return { ...EMPTY_STOPS, ...patch };
}

export interface RouteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const ROUTE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-triage',
        title: 'триаж целиком: 7 остановок фикстуры',
        render: () => <RouteState />,
    },
    {
        id: 'route-viewed',
        title: 'остановка просмотрена: заголовок и абзац приглушены, ханки схлопнуты',
        render: () => <RouteState stopViewed={['s01']} />,
    },
    {
        id: 'route-low-expanded',
        title: 'low-остановка раскрыта вручную (соседняя осталась свёрнутой)',
        render: () => <RouteState stops={stopsState({ expanded: new Set(['s05']) })} />,
    },
    {
        id: 'route-stop-file-viewed',
        title: 'файл в двух остановках: карточка в 03 отмечена и свёрнута, в 05 — нет',
        render: () => (
            <RouteState progress={SHARED_FILE_PROGRESS} stops={stopsState({ expanded: new Set(['s05']) })} />
        ),
    },
    {
        id: 'route-other-promoted',
        title: '«Прочее» поднято выше low + баннер о перегенерации',
        render: () => <RouteState snapshot={underExplainedSnapshot()} />,
    },
    {
        id: 'route-drift',
        title: 'дрейф якорей: остановка указывает на строки вне диффа',
        render: () => <RouteState snapshot={driftedSnapshot()} />,
    },
    {
        id: 'route-drift-partial',
        title: 'частичный дрейф: нотис над уцелевшими карточками остановки',
        render: () => <RouteState snapshot={partialDriftSnapshot()} />,
    },
    {
        id: 'route-empty-stop',
        title: 'остановка без ханков — дашед-карточка вместо пустоты',
        render: () => <RouteState snapshot={emptyStopSnapshot()} />,
    },
    {
        id: 'route-stop-markup',
        title: 'описание остановки с разметкой: абзацы, список, код, ссылки (03 — просмотрена)',
        render: () => <RouteState stopViewed={['s03']} />,
    },
    {
        id: 'route-stop-tall-side',
        title: 'остановка с длинным описанием и 12+ файлами: колонка прокручивается сама',
        render: () => <RouteState snapshot={tallStopSnapshot()} />,
    },
    {
        id: 'route-filter-kept',
        title: 'фильтр PCI DSS: остановка удержана на экране с пометкой',
        render: () => <RouteState filter="pci" keptStopId="s01" />,
    },
];
