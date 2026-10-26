import { fileContentOf, fixtureIteration, LONG_LINE_FILE_PATH } from '@sherpa/fixtures';
import type { FixtureName } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffGap, DiffHunk } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { toParseRequest } from '../../diff/model.js';
import { lineKey } from '../../diff-view/selection.js';
import { readStateOf } from '../../progress/read-state.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createSessionStore } from '../../session/session-store.js';
import { DiffFileList } from '../../diff-view/file-list.tsx';
import type { ExpandDirection, FileExpansion } from '../../diff-view/expand.js';
import { gapKeyOf, hiddenLinesOf } from '../../diff-view/expand.js';
import type { DiffMode, DiffViewStore } from '../../diff-view/store.js';
import { createDiffViewStore, fileCollapseReason } from '../../diff-view/store.js';
import '../../diff-view/diff-view.css';

/**
 * Состояния дифф-рендера для галереи. Всё считается
 * из фикстур синхронно: ни сервера, ни воркера, ни таймеров — открытие состояния даёт один
 * и тот же кадр при каждом прогоне.
 */

type ExpansionPreset = 'step' | 'remainder' | 'all';

interface CardStateProps {
    readonly fixture: FixtureName;
    readonly path: string;
    readonly mode?: DiffMode;
    readonly expansion?: ExpansionPreset;
    readonly viewed?: boolean;
    /** Явный ручной выбор: true — свернуть, false — развернуть. */
    readonly collapsed?: boolean;
    /** Машинный файл: ручная развёртка → viewed → un-pin, итогом снова развёрнут. */
    readonly restoreAfterUnmark?: boolean;
    /** Выделенный диапазон: номер ханка в файле и строки внутри него. */
    readonly selection?: { hunk: number; from: number; to: number };
    /** Файл открыт вопреки свёртке по размеру. */
    readonly opened?: boolean;
    /** Карточка оставлена на экране вопреки фильтру (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /** Стартовая подсказка карточки: так рисуется провал записи, которого без клика не бывает. */
    readonly hint?: Feedback;
    readonly gapError?: boolean;
    /** Подмена путей файла фикстуры: длинные пути для шапки карточки, самих файлов с такими путями в фикстурах нет. */
    readonly override?: Partial<Pick<FileDiff, 'path' | 'oldPath'>>;
    /** Файл не из фикстуры, а собранный галереей; фикстура тогда даёт только возможности хоста. */
    readonly synthetic?: FileDiff;
}

const EMPTY_EXPANSION: FileExpansion = new Map();

function fileOf(fixture: FixtureName, path: string): FileDiff {
    const file = fixtureIteration(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре ${fixture} нет файла ${path}`);
    }
    return file;
}

function applyExpansionPreset(
    store: DiffViewStore,
    fileId: string,
    model: ReturnType<typeof parseFileDiff>,
    content: FileContent,
    preset: Exclude<ExpansionPreset, 'all'>,
): void {
    const gaps = model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
    const gap = gaps.find((candidate) => {
        const hidden = hiddenLinesOf(candidate, content);
        return preset === 'step' ? hidden === null || hidden >= 20 : hidden !== null && hidden > 7;
    });
    if (gap === undefined) {
        return;
    }
    const direction: ExpandDirection = gap.edge === 'trailing' ? 'down' : 'up';
    const hidden = hiddenLinesOf(gap, content);
    const amount = preset === 'remainder' && hidden !== null ? hidden - 7 : undefined;
    store.expandGap(fileId, gapKeyOf(gap), direction, amount);
}

/** Карточка на фикстуре: стор заполняется сразу, поэтому первый кадр уже финальный. */
function CardState({
    fixture,
    path,
    mode = 'unified',
    expansion,
    viewed,
    collapsed,
    restoreAfterUnmark = false,
    selection,
    opened,
    keptInView = false,
    hint,
    gapError = false,
    override,
    synthetic,
}: CardStateProps) {
    const data = useMemo(() => fixtureIteration(fixture), [fixture]);
    const file = useMemo(
        () => synthetic ?? { ...fileOf(fixture, path), ...override },
        [fixture, path, override, synthetic],
    );
    const contentAvailable = data.pr.capabilities.fileContent;

    const store = useMemo(() => {
        const created = createDiffViewStore({
            files: [file],
            ...(collapsed === undefined ? {} : { collapsed: new Map([[file.fileId, collapsed]]) }),
        });
        const model = parseFileDiff(toParseRequest(file));
        const content = contentAvailable ? fileContentOf(file) : null;
        created.setModel(file.fileId, model);
        if (contentAvailable) {
            created.setContent(file.fileId, content);
        }
        created.setDiffMode(mode);
        if (expansion === 'all') {
            created.expandFile(file.fileId);
        } else if (expansion !== undefined && content !== null) {
            applyExpansionPreset(created, file.fileId, model, content, expansion);
        }
        if (restoreAfterUnmark) {
            created.revealFile(file.fileId);
            created.markViewed(file.fileId, true);
            created.revealFile(file.fileId);
            created.markViewed(file.fileId, false);
        } else if (viewed === true) {
            created.markViewed(file.fileId, true);
        }
        if (opened === true) {
            created.openFile(file.fileId);
        }
        if (selection !== undefined) {
            // Строка адресуется своими номерами в файле, поэтому ключи снимаются с модели.
            const model = created.getSnapshot().models.get(file.fileId);
            const blocks = model?.content.kind === 'text' ? model.content.blocks : [];
            const hunk = blocks.filter((block): block is DiffHunk => block.kind === 'hunk')[selection.hunk];
            const from = hunk?.lines[selection.from];
            const to = hunk?.lines[selection.to];
            const fromKey = from === undefined ? null : lineKey(from);
            const toKey = to === undefined ? null : lineKey(to);
            if (fromKey === null || toKey === null) {
                throw new Error(`в файле ${file.path} нет строк выделения`);
            }
            created.startSelection(file.fileId, fromKey);
            created.extendSelection(file.fileId, toKey);
        }
        return created;
    }, [collapsed, contentAvailable, expansion, file, mode, opened, restoreAfterUnmark, selection, viewed]);

    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const actions = useMemo(() => galleryActions(store), [store]);

    return (
        <FileCard
            file={file}
            model={snapshot.models.get(file.fileId) ?? null}
            mode={snapshot.effectiveMode}
            content={snapshot.content.get(file.fileId)}
            contentAvailable={contentAvailable}
            expansion={snapshot.expansion.get(file.fileId) ?? EMPTY_EXPANSION}
            read={snapshot.readState.get(file.fileId) ?? readStateOf({ file, record: null })}
            collapseReason={fileCollapseReason(snapshot, file)}
            onToggleCollapse={() => {
                store.toggleFileCollapse(file.fileId);
            }}
            opened={snapshot.opened.has(file.fileId)}
            showWhitespace={snapshot.whitespaceShown.has(file.fileId)}
            markdown={snapshot.markdownShown.has(file.fileId)}
            keptInView={keptInView}
            initialHint={hint ?? null}
            initialGapError={gapError}
            selection={snapshot.selection}
            actions={actions}
        />
    );
}

/** Виртуализированный список на большой фикстуре: 64 файла, разбор по мере прокрутки. */
function ListState({ fixture }: { fixture: FixtureName }) {
    const data = useMemo(() => fixtureIteration(fixture), [fixture]);
    const store = useMemo(() => createDiffViewStore({ files: data.diff.files }), [data]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

    // Список берёт высоту от внешнего скроллера, поэтому в галерее им служит стенд состояния.
    return (
        <div className="gallery__viewport" ref={setScrollElement}>
            <DiffFileList
                scrollElement={scrollElement}
                scrollPaddingStart={0}
                files={data.diff.files}
                store={store}
                contentAvailable={data.pr.capabilities.fileContent}
                // Парсер синхронный: воркер в галерее не нужен, кадр от него не зависит.
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                session={session}
                onViewed={(fileId, viewed) => {
                    store.markViewed(fileId, viewed);
                    return Promise.resolve(null);
                }}
            />
        </div>
    );
}

/** Провал разбора: первый заход «воркера» падает, повтор по кнопке проходит. */
function ParseErrorState({ fixture, path }: { fixture: FixtureName; path: string }) {
    const file = useMemo(() => fileOf(fixture, path), [fixture, path]);
    const store = useMemo(() => createDiffViewStore({ files: [file] }), [file]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const failed = useRef(new Set<string>());
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

    return (
        <div className="gallery__viewport" ref={setScrollElement}>
            <DiffFileList
                scrollElement={scrollElement}
                scrollPaddingStart={0}
                files={[file]}
                store={store}
                contentAvailable={false}
                parse={(candidate) => {
                    if (failed.current.has(candidate.fileId)) {
                        return Promise.resolve(parseFileDiff(toParseRequest(candidate)));
                    }
                    failed.current.add(candidate.fileId);
                    return Promise.reject(new Error('воркер не ответил'));
                }}
                loadContent={() => Promise.resolve(null)}
                session={session}
                onViewed={(fileId, viewed) => {
                    store.markViewed(fileId, viewed);
                    return Promise.resolve(null);
                }}
            />
        </div>
    );
}

/** Действия карточки без сервера: всё исполняется в сторе синхронно. */
export function galleryActions(store: DiffViewStore): FileCardActions {
    return {
        onViewed: (fileId, viewed) => {
            store.markViewed(fileId, viewed);
            return Promise.resolve(null);
        },
        onExpand: (fileId, request) => {
            if (request.kind === 'file') {
                store.expandFile(fileId, request.gapKeys);
            } else {
                store.expandGap(fileId, request.gapKey, request.direction, request.amount);
            }
            const snapshot = store.getSnapshot();
            return Promise.resolve({
                feedback: null,
                content: snapshot.content.get(fileId) ?? null,
                expansion: snapshot.expansion.get(fileId) ?? new Map(),
            });
        },
        onRetryParse: () => {
            // В галерее разбор синхронный и не падает — повторять нечего.
        },
        onOpenFile: store.openFile,
        onShowWhitespace: store.showWhitespace,
        onToggleMarkdown: store.toggleMarkdown,
        onSelectText: store.selectText,
        onClearSelection: store.clearSelection,
        onSelectStart: (fileId, key, side, extend) => {
            if (extend) {
                store.extendSelection(fileId, key, side);
            } else {
                store.startSelection(fileId, key, side);
            }
        },
        onSelectExtend: store.extendSelection,
    };
}

const EDIT_WINDOW = 'services/orders/src/domain/edit-window.ts';
const ORDER = 'services/orders/src/domain/order.ts';
const HANDLERS = 'services/orders/src/api/handlers.ts';
const CARD_TOKEN = 'services/orders/src/payments/card-token.ts';

/** Пути длиннее шапки: галерея показывает обрезку слева, фикстурных файлов с такими путями нет. */
const LONG_PATH = {
    path: 'services/orders/src/domain/scheduling/windows/expiration/adapters/legacy/internal/compat/rules/generated/v3/handlers/compliance/policies/order.ts',
};
const LONG_RENAME = {
    oldPath:
        'services/orders/src/infra/legacy/platform/time/providers/generated/v2/internal/adapters/system/compat/clock.ts',
    path: 'services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system/monotonic-clock.provider.ts',
};

/**
 * Правка за тысячной строкой: номера переходят с трёх разрядов на четыре внутри ханка,
 * а первый ханк держит двузначные — колонка одна на карточку. Файлов такой длины с правками
 * по обе стороны в фикстурах нет.
 */
const LEDGER: FileDiff = {
    ...fileOf('medium', ORDER),
    fileId: 'gallery-ledger',
    path: 'services/orders/src/billing/ledger.ts',
    additions: 4,
    deletions: 3,
    patch: [
        '@@ -12,3 +12,3 @@',
        ' const LEDGER_LIMIT = 500;',
        '-const LEDGER_TTL = 60;',
        '+const LEDGER_TTL = 90;',
        ' ',
        '@@ -996,7 +996,8 @@',
        ' export function settle(entry: LedgerEntry): Settlement {',
        '     const total = entry.lines.reduce(sum, 0);',
        '-    if (total > LEDGER_LIMIT) {',
        '-        return reject(entry);',
        '+    if (total > LEDGER_LIMIT && !entry.approved) {',
        "+        audit.record(entry, 'over-limit');",
        "+        return reject(entry, 'over-limit');",
        '     }',
        '     return accept(entry, total);',
        ' }',
        '',
    ].join('\n'),
};

/** Однозначные номера по обе стороны: колонка номеров не ужимается уже двух разрядов. */
const SHORT_FILE = 'services/orders/src/infra/time/clock.ts';

export interface DiffGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const DIFF_STATES: readonly DiffGalleryState[] = [
    {
        id: 'diff-unified',
        title: 'карточка, одной колонкой',
        render: () => <CardState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-split',
        title: 'карточка, бок о бок',
        render: () => <CardState fixture="medium" path={ORDER} mode="split" />,
    },
    {
        id: 'diff-gutter-short',
        title: 'номера строк в один разряд: колонка номеров на минимуме',
        render: () => <CardState fixture="edge" path={SHORT_FILE} />,
    },
    {
        id: 'diff-gutter-short-split',
        title: 'номера строк в один разряд, бок о бок',
        render: () => <CardState fixture="edge" path={SHORT_FILE} mode="split" />,
    },
    {
        id: 'diff-gutter-1000',
        title: 'номера за тысячу: колонка номеров шире, одна на карточку',
        render: () => <CardState fixture="medium" path={LEDGER.path} synthetic={LEDGER} />,
    },
    {
        id: 'diff-gutter-1000-split',
        title: 'номера за тысячу, бок о бок: ширина общая для половин',
        render: () => <CardState fixture="medium" path={LEDGER.path} synthetic={LEDGER} mode="split" />,
    },
    {
        id: 'diff-long-lines',
        title: 'длинные URL, минифицированный код и табы переносятся',
        render: () => <CardState fixture="large" path={LONG_LINE_FILE_PATH} />,
    },
    {
        id: 'diff-long-lines-split',
        title: 'длинные строки бок о бок, половины пары одной высоты',
        render: () => <CardState fixture="large" path={LONG_LINE_FILE_PATH} mode="split" />,
    },
    {
        id: 'diff-split-one-sided',
        title: 'бок о бок: односторонний файл во всю ширину',
        render: () => <CardState fixture="medium" path={EDIT_WINDOW} mode="split" />,
    },
    {
        id: 'diff-selection',
        title: 'выделенный диапазон',
        render: () => (
            <CardState fixture="medium" path={HANDLERS} selection={{ hunk: 1, from: 2, to: 6 }} />
        ),
    },
    {
        id: 'diff-selection-split',
        title: 'выделенный диапазон, бок о бок',
        render: () => (
            <CardState
                fixture="medium"
                path={HANDLERS}
                mode="split"
                selection={{ hunk: 1, from: 2, to: 6 }}
            />
        ),
    },
    {
        id: 'diff-viewed',
        title: 'свёрнут по отметке «Просмотрено»',
        render: () => <CardState fixture="medium" path={ORDER} viewed />,
    },
    {
        id: 'diff-collapsed-manual',
        title: 'свёрнут вручную кликом по шапке',
        render: () => <CardState fixture="medium" path={ORDER} collapsed />,
    },
    {
        id: 'diff-collapsed-generated',
        title: 'машинный файл свёрнут по умолчанию',
        render: () => <CardState fixture="medium" path="services/orders/src/payments/generated/psp-schema.ts" />,
    },
    {
        id: 'diff-unmark-restores-expansion',
        title: 'снятие отметки вернуло прежнюю развёртку машинного файла',
        render: () => (
            <CardState
                fixture="medium"
                path="services/orders/src/payments/generated/psp-schema.ts"
                restoreAfterUnmark
            />
        ),
    },
    {
        id: 'diff-expand',
        title: 'контекст раскрыт на 20 строк',
        render: () => <CardState fixture="medium" path={ORDER} expansion="step" />,
    },
    {
        id: 'diff-expand-all',
        title: 'контекст раскрыт целиком',
        render: () => <CardState fixture="medium" path={ORDER} expansion="all" />,
    },
    {
        id: 'diff-gap-idle',
        title: 'перемычка: покой',
        render: () => <CardState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-gap-remainder',
        title: 'перемычка: остаток меньше 20 строк',
        render: () => <CardState fixture="medium" path={ORDER} expansion="remainder" />,
    },
    {
        id: 'diff-gap-error',
        title: 'перемычка: ошибка догрузки',
        render: () => <CardState fixture="medium" path={ORDER} gapError />,
    },
    {
        id: 'diff-gap-directional',
        // Пропуски handlers.ts: внутренний на 34 строки даёт ↑ и ↓, на 16 — одну ↕, хвостовой на 30 — ↓.
        title: 'перемычка: направленные мишени ↑/↓ при пропуске от 20 строк',
        render: () => <CardState fixture="medium" path={HANDLERS} />,
    },
    {
        id: 'diff-gap-leading',
        // Первый ханк card-token.ts начинается с 44-й строки: раскрывать нечего, кроме как вверх.
        title: 'перемычка: головной пропуск от 20 строк — только ↑',
        render: () => <CardState fixture="medium" path={CARD_TOKEN} />,
    },
    {
        id: 'diff-expand-unavailable',
        title: 'контекст недоступен: хост не отдаёт содержимое',
        render: () => <CardState fixture="edge" path="services/orders/src/domain/order.ts" />,
    },
    {
        id: 'diff-rename',
        title: 'переименование',
        render: () => <CardState fixture="edge" path="services/orders/src/infra/time/clock.ts" />,
    },
    {
        id: 'diff-long-path',
        title: 'шапка: глубокий путь режется слева, имя целиком',
        render: () => <CardState fixture="medium" path={ORDER} override={LONG_PATH} />,
    },
    {
        id: 'diff-long-path-rename',
        title: 'шапка: переименование с длинными путями',
        render: () => (
            <CardState fixture="edge" path="services/orders/src/infra/time/clock.ts" override={LONG_RENAME} />
        ),
    },
    {
        id: 'diff-delete',
        title: 'удалённый файл',
        render: () => <CardState fixture="edge" path="services/orders/src/legacy/edit-window-v1.ts" />,
    },
    {
        id: 'diff-binary',
        title: 'двоичный файл',
        render: () => <CardState fixture="edge" path="services/orders/assets/edit-window-flow.png" />,
    },
    {
        id: 'diff-whitespace',
        title: 'только пробелы',
        render: () => <CardState fixture="edge" path="services/orders/src/api/schemas.ts" />,
    },
    {
        id: 'diff-mode-change',
        title: 'смена режима файла',
        render: () => <CardState fixture="edge" path="services/orders/scripts/rollout.sh" />,
    },
    {
        id: 'diff-collapsed',
        title: 'файл выше порога свёртки',
        render: () => (
            <CardState fixture="edge" path="services/orders/src/payments/generated/psp-client.ts" collapsed={false} />
        ),
    },
    {
        id: 'diff-collapsed-open',
        title: 'файл выше порога свёртки, открыт вручную',
        render: () => (
            <CardState
                fixture="edge"
                path="services/orders/src/payments/generated/psp-client.ts"
                collapsed={false}
                opened
            />
        ),
    },
    {
        id: 'diff-parse-error',
        title: 'дифф не разобрался, есть повтор',
        render: () => <ParseErrorState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-kept-in-view',
        title: 'оставлен на экране: карточка вне текущего фильтра',
        render: () => <CardState fixture="medium" path={ORDER} keptInView />,
    },
    {
        id: 'diff-viewed-not-saved',
        title: 'отметка не сохранилась: откат контрола и повтор',
        render: () => (
            // Провал записи без клика не рождается — карточка получает подсказку стартовой.
            <CardState
                fixture="medium"
                path={ORDER}
                hint={{ text: 'не сохранилось', retry: () => Promise.resolve(null) }}
            />
        ),
    },
    {
        id: 'diff-list-large',
        title: 'виртуализированный список, 64 файла, машинные свёрнуты',
        render: () => <ListState fixture="large" />,
    },
];
