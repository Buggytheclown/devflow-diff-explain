import type { FileDiff, Lens } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';

/**
 * Единая модель фильтра файлов (docs/design/README.md §Filters,
 * docs/design/SPEC-elements.md §2.7): одна и та же модель кормит
 * тулбарный селект, чипы левой панели, дерево файлов и список карточек.
 *
 * Список расширяем: `all` и `generated` считает UI сам, всё остальное приезжает линзами хоста.
 * Незнакомая линза будущего хоста появляется в фильтре, когда пересекается с текущим PR.
 */

/** Синтетический фильтр «всё»: не линза, членство ничем не ограничено. */
export const ALL_FILTER_ID = 'all';
/** Синтетический фильтр по `FileDiff.generated` — признак приходит от правил ревью, не эвристикой. */
export const GENERATED_FILTER_ID = 'generated';
export const MINE_FILTER_ID = 'mine';
export const PCI_FILTER_ID = 'pci';

/**
 * Подписи известных линз: подпись наша, а `Lens.label` приезжает
 * от адаптера по-английски. Незнакомый id показывается с хостовым лейблом как есть.
 *
 * «Моих файлов» здесь нет: их подпись называет источник зон (a.yaml, CODEOWNERS) и берёт
 * его параметром — см. `label`.
 */
const KNOWN_LABELS: Readonly<Record<string, MessageKey>> = {
    [ALL_FILTER_ID]: 'lens.all',
    [PCI_FILTER_ID]: 'lens.pci',
    [GENERATED_FILTER_ID]: 'lens.generated',
};

/** Короткая подпись для чипа в левой панели: там одна узкая колонка на все фильтры сразу. */
const SHORT_LABELS: Readonly<Record<string, MessageKey>> = {
    [ALL_FILTER_ID]: 'lens.all.short',
    [MINE_FILTER_ID]: 'lens.mine.short',
    [PCI_FILTER_ID]: 'lens.pci.short',
    [GENERATED_FILTER_ID]: 'lens.generated.short',
};

export interface FileFilter {
    readonly id: string;
    readonly label: string;
    /** Подпись для тесного чипа; у незнакомых линз совпадает с `label`. */
    readonly shortLabel: string;
    /** Живой счётчик по текущему диффу — членство, а не размер линзы. */
    readonly count: number;
    /** Выключенный пункт всегда объясняет, почему он выключен (docs/design/SPEC-elements.md §1.1). */
    readonly available: boolean;
    readonly note: string | null;
    /** Файлы фильтра; null у `all` — пропускает всё. */
    readonly fileIds: ReadonlySet<string> | null;
}

export interface FileFiltersInput {
    readonly files: readonly FileDiff[];
    /** Линза «мои файлы»; null — у хоста нет понятия ownership. */
    readonly ownership: Lens | null;
    readonly extra: readonly Lens[];
    /** Подписи фильтров уезжают в `title` и в чипы готовыми строками. */
    readonly t: Translate;
    /**
     * Чем хост называет источник зон (`UiReviewLensesResponse.ownershipSource`): им подписаны
     * «мои файлы». Без него подпись без источника.
     */
    readonly zoneSource?: string | null;
}

/**
 * Порядок фильтров docs/design/README.md §Filters: всё → мои → линзы хоста в порядке хоста → машинные.
 * Дубли по id отбрасываются: `all`/`generated` — за UI, хост их не переопределяет.
 *
 * Нулевые не-ownership линзы хоста и синтетическая `generated` в состав не попадают.
 * Ownership остаётся: без зоны — с причиной хоста, без своих файлов — с причиной UI.
 * Преселекта нет ни при каком составе: даже когда все файлы мои и счётчик «моих» совпал
 * со счётчиком «всех» (docs/design/SPEC-elements.md §4.2), выбран остаётся `all`.
 */
export function buildFileFilters({
    files,
    ownership,
    extra,
    t,
    zoneSource = null,
}: FileFiltersInput): readonly FileFilter[] {
    const byPath = new Map<string, string>();
    for (const file of files) {
        byPath.set(file.path, file.fileId);
    }

    const filters: FileFilter[] = [
        {
            id: ALL_FILTER_ID,
            label: label(ALL_FILTER_ID, 'All files', t, zoneSource),
            shortLabel: shortLabel(ALL_FILTER_ID, 'All files', t),
            count: files.length,
            available: true,
            note: null,
            fileIds: null,
        },
    ];

    const seen = new Set([ALL_FILTER_ID, GENERATED_FILTER_ID]);
    if (ownership !== null && !seen.has(ownership.id)) {
        seen.add(ownership.id);
        filters.push(fromOwnershipLens(ownership, byPath, t, zoneSource));
    }

    for (const item of extra) {
        if (seen.has(item.id)) {
            continue;
        }
        seen.add(item.id);
        const filter = fromLens(item, byPath, t, zoneSource);
        if (filter.count > 0) {
            filters.push(filter);
        }
    }

    const generated = new Set(files.filter((file) => file.generated).map((file) => file.fileId));
    if (generated.size > 0) {
        filters.push({
            id: GENERATED_FILTER_ID,
            label: label(GENERATED_FILTER_ID, 'Generated files', t, zoneSource),
            shortLabel: shortLabel(GENERATED_FILTER_ID, 'Generated files', t),
            count: generated.size,
            available: true,
            note: null,
            fileIds: generated,
        });
    }

    return filters;
}

function fromOwnershipLens(
    source: Lens,
    byPath: ReadonlyMap<string, string>,
    t: Translate,
    zoneSource: string | null,
): FileFilter {
    const filter = fromLens(source, byPath, t, zoneSource);
    if (!source.available || filter.count > 0) {
        return filter;
    }
    return {
        ...filter,
        available: false,
        note: t('lens.mine.empty'),
    };
}

function fromLens(
    source: Lens,
    byPath: ReadonlyMap<string, string>,
    t: Translate,
    zoneSource: string | null,
): FileFilter {
    const fileIds = new Set<string>();
    for (const path of source.paths) {
        const fileId = byPath.get(path);
        if (fileId !== undefined) {
            fileIds.add(fileId);
        }
    }

    return {
        id: source.id,
        label: label(source.id, source.label, t, zoneSource),
        shortLabel: shortLabel(source.id, source.label, t),
        count: fileIds.size,
        available: source.available,
        note: source.note,
        fileIds,
    };
}

function label(id: string, hostLabel: string, t: Translate, zoneSource: string | null): string {
    if (id === MINE_FILTER_ID) {
        return t('lens.mine', zoneSource);
    }
    const known = KNOWN_LABELS[id];
    return known === undefined ? hostLabel : t(known);
}

function shortLabel(id: string, hostLabel: string, t: Translate): string {
    const known = SHORT_LABELS[id] ?? KNOWN_LABELS[id];
    return known === undefined ? hostLabel : t(known);
}

/** Фильтр по id; неизвестный или выключенный id откатывается к «всем файлам». */
export function selectFilter(filters: readonly FileFilter[], id: string | null): FileFilter {
    const found = filters.find((filter) => filter.id === id);
    const all = filters.find((filter) => filter.id === ALL_FILTER_ID);
    if (all === undefined) {
        throw new Error('the filter model has no synthetic "all"');
    }
    return found?.available === true ? found : all;
}

/** Фильтр по id среди состава, который рендерят панель и селект. */
export function findFilter(filters: readonly FileFilter[], id: string): FileFilter | null {
    return filters.find((filter) => filter.id === id) ?? null;
}

export function filterFiles(files: readonly FileDiff[], filter: FileFilter): readonly FileDiff[] {
    const { fileIds } = filter;
    return fileIds === null ? files : files.filter((file) => fileIds.has(file.fileId));
}

/** Числа для баннера аудит-скоупа (docs/design/README.md §Filters): «N файлов — M из K изменённых строк». */
export interface FilterStats {
    readonly files: number;
    readonly changedLines: number;
    readonly totalFiles: number;
    readonly totalChangedLines: number;
}

export function filterStats(files: readonly FileDiff[], filter: FileFilter): FilterStats {
    const inside = filterFiles(files, filter);
    return {
        files: inside.length,
        changedLines: changedLines(inside),
        totalFiles: files.length,
        totalChangedLines: changedLines(files),
    };
}

function changedLines(files: readonly FileDiff[]): number {
    return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

/**
 * Значение параметра `filter` во фрагменте URL: у «всех файлов» параметра нет вовсе —
 * ссылка на дефолтный вид не должна отличаться от ссылки без фильтра.
 */
export function filterFragmentValue(id: string): string | null {
    return id === ALL_FILTER_ID ? null : id;
}

/**
 * Пустой результат объясняет себя (docs/design/SPEC-elements.md §2.7): у хоста для этого есть `note`,
 * а если её нет — UI говорит своими словами.
 */
export function zeroResultText(filter: FileFilter, t: Translate): string {
    return filter.note ?? t('lens.zeroResult', filter.label);
}
