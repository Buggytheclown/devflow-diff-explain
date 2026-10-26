import type { FileContent, FileDiff, UiFileProgress, UiSeenRange } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { changedLinesOf, changeSeenRanges, readStateOf } from '../progress/read-state.js';
import type { ExpandDirection, FileExpansion, GapKey } from './expand.js';
import { expandAllGaps, expandGap } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';

/**
 * Состояние дифф-вью вне React-дерева (docs/architecture.md §1): что уже разобрано воркером, что раскрыто,
 * что прочитано и что выделено. Снапшот неизменяем, React читает его через `useSyncExternalStore`.
 *
 * Прогресс чтения живёт здесь двумя слоями: `progress` — явные записи ревьюера (истина
 * сервера), `readState` — посчитанное от них и от самого файла состояние, которое рисуют карточка
 * и дерево. Запись в ручку и откат — дело вью: стор в сеть не ходит.
 */

export type DiffMode = 'unified' | 'split';
export type FileCollapseReason = 'viewed' | 'manual' | 'generated';

/** Ниже этой ширины side-by-side недоступен (docs/design/SPEC-elements.md §2.6). */
export const SPLIT_MIN_WIDTH = 1100;

export interface DiffViewSnapshot {
    /** Выбор пользователя; на узком экране он остаётся, а рендер уходит в unified. */
    readonly diffMode: DiffMode;
    /** Доступной ширины хватает на side-by-side. */
    readonly splitAvailable: boolean;
    /** Режим, в котором рисуются карточки прямо сейчас. */
    readonly effectiveMode: DiffMode;
    readonly models: ReadonlyMap<string, DiffFileModel>;
    /** Содержимое файлов для «Expand context»; значение null — у файла его нет. */
    readonly content: ReadonlyMap<string, FileContent | null>;
    readonly expansion: ReadonlyMap<string, FileExpansion>;
    /** Явные записи прогресса по fileId; отсутствие записи — состояние по умолчанию. */
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    /** Эффективный read-state каждого файла диффа (docs/design/SPEC-elements.md §2.12). */
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Ручная развёртка вопреки generated-дефолту. */
    readonly collapseExpanded: ReadonlySet<string>;
    /** Временная развёртка просмотренного файла из строки-сводки. */
    readonly collapseExpandedViewed: ReadonlySet<string>;
    /** Ручная свёртка обычного файла. */
    readonly collapseCollapsed: ReadonlySet<string>;
    /** Явный выбор ревьюера для персиста: true — свернуть, false — развернуть. */
    readonly collapsePreferences: ReadonlyMap<string, boolean>;
    /** Файлы, которые ревьюер открыл вручную, несмотря на свёртку по размеру (docs/design/SPEC-elements.md §2.13). */
    readonly opened: ReadonlySet<string>;
    /** Whitespace-only строки, которые ревьюер явно раскрыл. */
    readonly whitespaceShown: ReadonlySet<string>;
    /** Markdown-файлы, которые ревьюер читает документом, а не кодом. */
    readonly markdownShown: ReadonlySet<string>;
    readonly selection: LineSelection | null;
    /** Между настоящим началом протяжки и отпусканием кнопки мыши. */
    readonly selectionDragging: boolean;
}

export interface DiffViewStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => DiffViewSnapshot;
    readonly setDiffMode: (mode: DiffMode) => void;
    readonly setAvailableWidth: (width: number) => void;
    readonly setModel: (fileId: string, model: DiffFileModel) => void;
    readonly setContent: (fileId: string, content: FileContent | null) => void;
    /** Направленно раскрыть одну перемычку. */
    readonly expandGap: (fileId: string, gapKey: GapKey, direction: ExpandDirection, amount?: number) => void;
    /** Раскрыть все исходные и видимые после transform пропуски файла целиком. */
    readonly expandFile: (fileId: string, visibleGapKeys?: readonly GapKey[]) => void;
    /** Прогресс с сервера целиком: он старше всего, что стор насчитал сам. */
    readonly setProgress: (files: readonly UiFileProgress[]) => void;
    /** Оптимистичная отметка: запись появляется сразу, ручку зовёт вью. */
    readonly markViewed: (fileId: string, viewed: boolean) => void;
    /** Откат оптимистичной отметки: `null` — записи до неё не было. */
    readonly restoreProgress: (fileId: string, record: UiFileProgress | null) => void;
    /**
     * Оптимистичная отметка файла внутри остановки: диапазоны карточки добавляются к записи файла
     * или вычитаются из неё, признак `viewed` не меняется.
     */
    readonly applySeenRanges: (fileId: string, change: 'add' | 'remove', ranges: readonly UiSeenRange[]) => void;
    /** Тогл ручной свёртки с той же формулой слоёв, что у остановок маршрута (docs/design/SPEC-elements.md §2.9). */
    readonly toggleFileCollapse: (fileId: string) => void;
    /**
     * Явный выбор свёртки целиком: состояние PR приехало с сервера позже создания стора.
     * Прежний выбор заменяется, потому что серверное значение и есть он же — просто полное.
     */
    readonly setCollapsePreferences: (collapsed: ReadonlyMap<string, boolean>) => void;
    /** Подготовить свёрнутый файл к переходу из дерева, ссылки или поиска. */
    readonly revealFile: (fileId: string) => void;
    readonly openFile: (fileId: string) => void;
    readonly showWhitespace: (fileId: string) => void;
    /** Переключить документ/код; выделение в этом файле сбрасывается — его строки рисовал прежний режим. */
    readonly toggleMarkdown: (fileId: string) => void;
    readonly beginSelection: () => void;
    readonly startSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    readonly extendSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    /**
     * Расширение по движению мыши: работает только между `beginSelection` и `finishSelection`.
     * Иначе любое зажатое движение над строками — выделение текста в коде или в поповере —
     * тянуло бы живое выделение от старого якоря.
     */
    readonly dragSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    readonly finishSelection: () => void;
    readonly selectText: (selection: LineSelection) => void;
    readonly clearSelection: () => void;
}

export interface DiffViewStoreOptions {
    /** Файлы диффа: из них берутся `generated`, отметка хоста и число изменённых строк. */
    readonly files: readonly FileDiff[];
    /** Стартовый прогресс с сервера; без него — одни умолчания. */
    readonly progress?: readonly UiFileProgress[];
    /** Стартовый режим диффа из глобальных настроек (`~/.sherpa/settings.json`). */
    readonly diffMode?: DiffMode;
    /** Смена режима ревьюером: персист — дело вью, стор в сеть не ходит. */
    readonly onDiffModeChange?: (mode: DiffMode) => void;
    /** Явный ручной выбор свёртки, уже прочитанный из per-PR storage. */
    readonly collapsed?: ReadonlyMap<string, boolean>;
}

type FileCollapseSnapshot = Pick<
    DiffViewSnapshot,
    'readState' | 'collapseExpanded' | 'collapseExpandedViewed' | 'collapseCollapsed'
>;

/** Итоговая причина свёртки по формуле docs/design/SPEC-elements.md §2.9; свёртка >2000 строк считается отдельно. */
export function fileCollapseReason(snapshot: FileCollapseSnapshot, file: FileDiff): FileCollapseReason | null {
    const read = snapshot.readState.get(file.fileId) ?? readStateOf({ file, record: null });
    return collapseReasonOf(snapshot, file, read, snapshot.collapseExpandedViewed.has(file.fileId));
}

/**
 * Та же формула для заданного read-state: карточка файла в остановке сворачивается как
 * просмотренная по своим строкам, а не по всему файлу. `viewedOpen` — временная развёртка просмотренной.
 */
export function collapseReasonOf(
    snapshot: Pick<DiffViewSnapshot, 'collapseExpanded' | 'collapseCollapsed'>,
    file: FileDiff,
    read: FileReadState,
    viewedOpen: boolean,
): FileCollapseReason | null {
    if (viewedCollapsible(read)) {
        return viewedOpen ? null : 'viewed';
    }
    if (snapshot.collapseCollapsed.has(file.fileId)) {
        return 'manual';
    }
    if (file.generated && !snapshot.collapseExpanded.has(file.fileId)) {
        return 'generated';
    }
    return null;
}

/**
 * Файл сворачивается как просмотренный. Generated-дефолт — аналог low-тира, а не отметки viewed:
 * явная развёртка обязана пережить un-pin.
 */
export function viewedCollapsible(read: FileReadState): boolean {
    return read.state === 'read' && !read.generatedDefault;
}

/**
 * Слои свёртки, посчитанные от явного выбора: ключ со значением true — ручная свёртка, false —
 * ручная развёртка. Обе стороны стора держат этот инвариант, поэтому выбор можно заменить целиком.
 */
function collapseSetsOf(preferences: ReadonlyMap<string, boolean>): {
    readonly collapseExpanded: Set<string>;
    readonly collapseCollapsed: Set<string>;
} {
    const collapseExpanded = new Set<string>();
    const collapseCollapsed = new Set<string>();
    for (const [fileId, collapsed] of preferences) {
        (collapsed ? collapseCollapsed : collapseExpanded).add(fileId);
    }
    return { collapseExpanded, collapseCollapsed };
}

function sameCollapsePreferences(next: ReadonlyMap<string, boolean>, current: ReadonlyMap<string, boolean>): boolean {
    return next.size === current.size && [...next].every(([fileId, collapsed]) => current.get(fileId) === collapsed);
}

export function createDiffViewStore(options: DiffViewStoreOptions): DiffViewStore {
    const listeners = new Set<() => void>();
    const diffMode = options.diffMode ?? 'unified';
    const filesById = new Map(options.files.map((file) => [file.fileId, file]));

    /**
     * Read-state одного файла. Изменённые строки модели нужны только там, где есть диапазоны:
     * без них покрытие считать не от чего, и разбирать модель ради этого незачем.
     */
    const computeReadState = (
        fileId: string,
        progress: ReadonlyMap<string, UiFileProgress>,
        models: ReadonlyMap<string, DiffFileModel>,
    ): FileReadState | null => {
        const file = filesById.get(fileId);
        if (file === undefined) {
            return null;
        }
        const record = progress.get(fileId) ?? null;
        const changed =
            record !== null && record.seenRanges.length > 0
                ? changedLinesOf(models.get(fileId) ?? null)
                : undefined;
        return readStateOf({ file, record, ...(changed === undefined ? {} : { changed }) });
    };

    const recomputeAll = (
        progress: ReadonlyMap<string, UiFileProgress>,
        models: ReadonlyMap<string, DiffFileModel>,
    ): Map<string, FileReadState> => {
        const next = new Map<string, FileReadState>();
        for (const fileId of filesById.keys()) {
            const state = computeReadState(fileId, progress, models);
            if (state !== null) {
                next.set(fileId, state);
            }
        }
        return next;
    };

    /** Пересчёт одного файла: у остальных состояния остаются теми же объектами (memo карточек). */
    const recomputeOne = (fileId: string, progress: ReadonlyMap<string, UiFileProgress>): Map<string, FileReadState> => {
        const next = new Map(snapshot.readState);
        const state = computeReadState(fileId, progress, snapshot.models);
        if (state !== null) {
            next.set(fileId, state);
        }
        return next;
    };

    const initialProgress = new Map((options.progress ?? []).map((record) => [record.fileId, record]));
    const collapsePreferences = new Map(options.collapsed ?? []);
    const { collapseExpanded, collapseCollapsed } = collapseSetsOf(collapsePreferences);
    let snapshot: DiffViewSnapshot = {
        diffMode,
        splitAvailable: true,
        effectiveMode: diffMode,
        models: new Map(),
        content: new Map(),
        expansion: new Map(),
        progress: initialProgress,
        readState: recomputeAll(initialProgress, new Map()),
        collapseExpanded,
        collapseExpandedViewed: new Set(),
        collapseCollapsed,
        collapsePreferences,
        opened: new Set(),
        whitespaceShown: new Set(),
        markdownShown: new Set(),
        selection: null,
        selectionDragging: false,
    };

    const update = (patch: Partial<DiffViewSnapshot>): void => {
        const next = { ...snapshot, ...patch };
        snapshot = { ...next, effectiveMode: next.splitAvailable ? next.diffMode : 'unified' };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const revealFile = (fileId: string): void => {
        const file = filesById.get(fileId);
        if (file === undefined) {
            return;
        }
        const reason = fileCollapseReason(snapshot, file);
        if (reason === null) {
            return;
        }
        if (reason === 'viewed') {
            update({ collapseExpandedViewed: new Set(snapshot.collapseExpandedViewed).add(fileId) });
            return;
        }

        const collapsed = new Set(snapshot.collapseCollapsed);
        collapsed.delete(fileId);
        update({
            collapseExpanded: new Set(snapshot.collapseExpanded).add(fileId),
            collapseCollapsed: collapsed,
            collapsePreferences: new Map(snapshot.collapsePreferences).set(fileId, false),
        });
    };

    const extendSelection = (fileId: string, key: LineKey, side?: 'old' | 'new'): void => {
        const current = snapshot.selection;
        const sameFile = current !== null && current.fileId === fileId;
        const anchor = sameFile ? current.anchor : key;
        const selectedSide = sameFile ? current.side : side;
        if (sameFile && current.focus === key) {
            return;
        }
        update({
            selection: {
                fileId,
                ...(selectedSide === undefined ? {} : { side: selectedSide }),
                anchor,
                focus: key,
            },
        });
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,

        setDiffMode: (mode) => {
            if (mode === snapshot.diffMode) {
                return;
            }
            update({ diffMode: mode });
            options.onDiffModeChange?.(mode);
        },

        setAvailableWidth: (width) => {
            const splitAvailable = width >= SPLIT_MIN_WIDTH;
            if (splitAvailable !== snapshot.splitAvailable) {
                update({ splitAvailable });
            }
        },

        setModel: (fileId, model) => {
            if (snapshot.models.get(fileId) === model) {
                return;
            }
            const models = new Map(snapshot.models).set(fileId, model);
            // Разбор меняет read-state только там, где покрытие считается по строкам модели.
            const recomputed =
                (snapshot.progress.get(fileId)?.seenRanges.length ?? 0) > 0
                    ? computeReadState(fileId, snapshot.progress, models)
                    : null;
            update({
                models,
                ...(recomputed === null ? {} : { readState: new Map(snapshot.readState).set(fileId, recomputed) }),
            });
        },

        setContent: (fileId, content) => {
            update({ content: new Map(snapshot.content).set(fileId, content) });
        },

        expandGap: (fileId, gapKey, direction, amount) => {
            const current = snapshot.expansion.get(fileId) ?? new Map();
            const next = expandGap(current, gapKey, direction, amount);
            update({ expansion: new Map(snapshot.expansion).set(fileId, next) });
        },

        expandFile: (fileId, visibleGapKeys = []) => {
            const model = snapshot.models.get(fileId);
            if (model === undefined) {
                return;
            }
            const current = snapshot.expansion.get(fileId) ?? new Map();
            const next = expandAllGaps(model, current, visibleGapKeys);
            update({ expansion: new Map(snapshot.expansion).set(fileId, next) });
        },

        setProgress: (files) => {
            const progress = new Map(files.map((record) => [record.fileId, record]));
            update({ progress, readState: recomputeAll(progress, snapshot.models) });
        },

        markViewed: (fileId, viewed) => {
            // Отметка меняет только флаг: диапазоны — отдельный слой, и ручка их не трогает.
            const seenRanges = snapshot.progress.get(fileId)?.seenRanges ?? [];
            const progress = new Map(snapshot.progress).set(fileId, { fileId, viewed, seenRanges });
            if (viewed) {
                update({ progress, readState: recomputeOne(fileId, progress) });
                return;
            }
            // Временная развёртка просмотренного файла живёт только пока стоит отметка.
            const expandedViewed = new Set(snapshot.collapseExpandedViewed);
            expandedViewed.delete(fileId);
            update({
                progress,
                readState: recomputeOne(fileId, progress),
                collapseExpandedViewed: expandedViewed,
            });
        },

        restoreProgress: (fileId, record) => {
            const progress = new Map(snapshot.progress);
            if (record === null) {
                progress.delete(fileId);
            } else {
                progress.set(fileId, record);
            }
            update({ progress, readState: recomputeOne(fileId, progress) });
        },

        applySeenRanges: (fileId, change, ranges) => {
            const record = snapshot.progress.get(fileId) ?? { fileId, viewed: null, seenRanges: [] };
            const progress = new Map(snapshot.progress).set(fileId, {
                ...record,
                seenRanges: changeSeenRanges(record.seenRanges, change, ranges),
            });
            if (change === 'add') {
                update({ progress, readState: recomputeOne(fileId, progress) });
                return;
            }
            const expandedViewed = new Set(snapshot.collapseExpandedViewed);
            expandedViewed.delete(fileId);
            update({
                progress,
                readState: recomputeOne(fileId, progress),
                collapseExpandedViewed: expandedViewed,
            });
        },

        toggleFileCollapse: (fileId) => {
            const file = filesById.get(fileId);
            if (file === undefined) {
                return;
            }
            if (fileCollapseReason(snapshot, file) !== null) {
                revealFile(fileId);
                return;
            }

            const read = snapshot.readState.get(fileId) ?? readStateOf({ file, record: null });
            if (viewedCollapsible(read)) {
                const expandedViewed = new Set(snapshot.collapseExpandedViewed);
                if (expandedViewed.delete(fileId)) {
                    update({ collapseExpandedViewed: expandedViewed });
                }
                return;
            }

            if (file.generated && snapshot.collapseExpanded.has(fileId)) {
                const expanded = new Set(snapshot.collapseExpanded);
                const preferences = new Map(snapshot.collapsePreferences);
                expanded.delete(fileId);
                preferences.delete(fileId);
                update({ collapseExpanded: expanded, collapsePreferences: preferences });
                return;
            }

            const expanded = new Set(snapshot.collapseExpanded);
            expanded.delete(fileId);
            update({
                collapseExpanded: expanded,
                collapseCollapsed: new Set(snapshot.collapseCollapsed).add(fileId),
                collapsePreferences: new Map(snapshot.collapsePreferences).set(fileId, true),
            });
        },

        setCollapsePreferences: (collapsed) => {
            if (sameCollapsePreferences(collapsed, snapshot.collapsePreferences)) {
                return;
            }
            const preferences = new Map(collapsed);
            update({ collapsePreferences: preferences, ...collapseSetsOf(preferences) });
        },

        revealFile,

        openFile: (fileId) => {
            if (snapshot.opened.has(fileId)) {
                return;
            }
            update({ opened: new Set(snapshot.opened).add(fileId) });
        },

        showWhitespace: (fileId) => {
            if (!snapshot.whitespaceShown.has(fileId)) {
                update({ whitespaceShown: new Set(snapshot.whitespaceShown).add(fileId) });
            }
        },

        toggleMarkdown: (fileId) => {
            const markdownShown = new Set(snapshot.markdownShown);
            if (!markdownShown.delete(fileId)) {
                markdownShown.add(fileId);
            }
            const ownSelection = snapshot.selection?.fileId === fileId;
            update({
                markdownShown,
                ...(ownSelection ? { selection: null, selectionDragging: false } : {}),
            });
        },

        beginSelection: () => {
            if (!snapshot.selectionDragging) {
                update({ selectionDragging: true });
            }
        },

        startSelection: (fileId, key, side) => {
            update({ selection: { fileId, ...(side === undefined ? {} : { side }), anchor: key, focus: key } });
        },

        extendSelection,

        dragSelection: (fileId, key, side) => {
            if (snapshot.selectionDragging) {
                extendSelection(fileId, key, side);
            }
        },

        finishSelection: () => {
            if (snapshot.selectionDragging) {
                update({ selectionDragging: false });
            }
        },

        selectText: (selection) => { update({ selection, selectionDragging: false }); },

        clearSelection: () => {
            if (snapshot.selection !== null || snapshot.selectionDragging) {
                update({ selection: null, selectionDragging: false });
            }
        },
    };
}
