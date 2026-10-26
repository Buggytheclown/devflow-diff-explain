import type { Iteration, Locale, RouteSnapshot, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';

/**
 * Что смотрит вкладка: текущее состояние PR, прошлый снапшот маршрута, итерация без
 * маршрута или срез между двумя итерациями. Выбор клиентский — он живёт во
 * фрагменте URL, сервер про «текущий вид» не спрашивают (контракт `uiReviewDiffRequestSchema`).
 *
 * Разрешение выбора — чистая функция: на вход список снапшотов, итерации, текущий маршрут
 * и то, что App уже знает об активной итерации; на выход — параметры ручек, режим чтения
 * и подпись индикатора.
 */

export type Viewing =
    | { readonly kind: 'current' }
    | { readonly kind: 'snapshot'; readonly snapshotId: string }
    | { readonly kind: 'diff'; readonly diffId: string }
    /** Срез между итерациями: `base` — старшая итерация, `head` — более новая, не обязательно активная. */
    | { readonly kind: 'slice'; readonly base: string; readonly head: string };

export const VIEWING_CURRENT: Viewing = { kind: 'current' };

/** Параметры ручки диффа для среза: их же UI держит во фрагменте адреса. */
export interface ViewingSlice {
    readonly base: string;
    readonly head: string;
}

/**
 * Несколько параметров в адресе — `snapshot` главнее среза, срез главнее `diff`: выборы
 * взаимоисключающи. Срез без одной из половин игнорируется целиком.
 */
export function parseViewing(
    snapshotId: string | null,
    diffId: string | null,
    base: string | null = null,
    head: string | null = null,
): Viewing {
    if (snapshotId !== null && snapshotId !== '') {
        return { kind: 'snapshot', snapshotId };
    }
    if (base !== null && base !== '' && head !== null && head !== '') {
        return { kind: 'slice', base, head };
    }
    return diffId !== null && diffId !== '' ? { kind: 'diff', diffId } : VIEWING_CURRENT;
}

export interface ViewingFragment {
    readonly snapshot: string | null;
    readonly diff: string | null;
    readonly base: string | null;
    readonly head: string | null;
}

/** Что писать во фрагмент: `current` в адрес не попадает. */
export function viewingFragment(viewing: Viewing): ViewingFragment {
    const empty: ViewingFragment = { snapshot: null, diff: null, base: null, head: null };
    if (viewing.kind === 'snapshot') {
        return { ...empty, snapshot: viewing.snapshotId };
    }
    if (viewing.kind === 'diff') {
        return { ...empty, diff: viewing.diffId };
    }
    return viewing.kind === 'slice' ? { ...empty, base: viewing.base, head: viewing.head } : empty;
}

/**
 * Правка фрагмента при смене выбора: ключи якорей другого диффа снимаются — файл, сторона,
 * строки, тред и остановка указывают на то, чего в новом выборе может не быть.
 */
export function viewingFragmentPatch(
    viewing: Viewing,
    previous: Viewing,
): Readonly<Record<string, string | null>> {
    const fragment: Readonly<Record<string, string | null>> = { ...viewingFragment(viewing) };
    if (sameViewing(viewing, previous)) {
        return fragment;
    }
    return { ...fragment, file: null, side: null, line: null, end: null, thread: null, stop: null };
}

export function sameViewing(left: Viewing, right: Viewing): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === 'snapshot' && right.kind === 'snapshot') {
        return left.snapshotId === right.snapshotId;
    }
    if (left.kind === 'diff' && right.kind === 'diff') {
        return left.diffId === right.diffId;
    }
    if (left.kind === 'slice' && right.kind === 'slice') {
        return left.base === right.base && left.head === right.head;
    }
    return true;
}

/** Подпись индикатора: `текущий` / `устарел` / `коммита больше нет в PR` / `без маршрута` / `срез`. */
export type ViewingStatus = 'current' | 'stale' | 'gone' | 'noRoute' | 'slice';

export type ViewingLabel =
    | { readonly kind: 'snapshot' | 'diff'; readonly commit: string; readonly status: ViewingStatus }
    /** У среза две стороны: `commit` — голова среза, `baseCommit` — то, с чего смотрим. */
    | {
          readonly kind: 'slice';
          readonly commit: string;
          readonly baseCommit: string;
          readonly status: 'slice';
      };

export interface ResolvedViewing {
    /** Нормализованный выбор: неизвестный id заменён на `current`. */
    readonly viewing: Viewing;
    /** Параметр `diffId` ручек диффа и прогресса; null — активная итерация, без параметра. */
    readonly diffId: string | null;
    /** Параметр `snapshot` ручки маршрута; null — текущее состояние маршрута. */
    readonly snapshotId: string | null;
    readonly readOnly: boolean;
    readonly gone: boolean;
    readonly label: ViewingLabel | null;
    /** Момент выбранного снапшота или итерации; null — неизвестен. */
    readonly createdAt: string | null;
    /** Выбор не нашёлся ни в списке, ни в текущем состоянии: адрес пора чистить. */
    readonly unknown: boolean;
    /** Список снапшотов ещё не приехал: параметров не знаем, данные не грузим. */
    readonly pending: boolean;
    /** Вкладка «Маршрут» показывает итерацию, маршрута для которой нет. */
    readonly routeless: boolean;
    /** Вкладка смотрит срез: дифф грузится ручкой `base`/`head`, прогресса и линз у него нет. */
    readonly slice: ViewingSlice | null;
}

export interface ViewingInput {
    readonly viewing: Viewing;
    /** Снапшоты PR в порядке появления; при отказе ручки — список из одного текущего. */
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Маршрут, который сейчас загружен: при выборе `current`/`diff` — текущий. */
    readonly route: UiRouteState | null;
    /**
     * Активная итерация, если её уже видели. Знание об активной итерации собирается из ответов
     * без параметров и не зависит от того, что смотрит вкладка: иначе выбор прошлой итерации
     * стирал бы то, по чему сам же и разрешается.
     */
    readonly activeDiffId: string | null;
    /** Коммит активной итерации из того же источника, что и `activeDiffId`. */
    readonly activeCommit: string | null;
    /** Список снапшотов уже отвечал (в том числе отказом). */
    readonly snapshotsLoaded: boolean;
    /** Ручки без параметров уже отвечали (в том числе отказом): активная итерация известна. */
    readonly activeLoaded: boolean;
}

const CURRENT_BASE = {
    diffId: null,
    snapshotId: null,
    readOnly: false,
    gone: false,
    unknown: false,
    pending: false,
    routeless: false,
    slice: null,
} as const;

export function resolveViewing(input: ViewingInput): ResolvedViewing {
    const currentLabel = labelOfCurrentRoute(input.route);
    const current: ResolvedViewing = {
        ...CURRENT_BASE,
        viewing: VIEWING_CURRENT,
        label: currentLabel,
        createdAt: input.route?.snapshot?.createdAt ?? null,
    };
    if (input.viewing.kind === 'current') {
        return current;
    }
    // Пока не приехали список снапшотов и факты об активной итерации, решать нечего: без них
    // выбор из адреса не отличить от неизвестного, а режим чтения — от активной итерации.
    if (!input.snapshotsLoaded || !input.activeLoaded) {
        return { ...current, viewing: input.viewing, pending: true };
    }

    const active = activeIterationDiffId(input);
    if (input.viewing.kind === 'slice') {
        return resolveSlice(input.viewing, input, active, current);
    }
    if (input.viewing.kind === 'snapshot') {
        const { snapshotId } = input.viewing;
        const summary = input.snapshots.find((candidate) => candidate.snapshotId === snapshotId) ?? null;
        if (summary === null) {
            return { ...current, unknown: true };
        }
        // Текущий снапшот выбором не отличается от `current`: те же ручки без параметров.
        if (summary.status === 'current') {
            return { ...current, viewing: input.viewing };
        }
        return {
            viewing: input.viewing,
            diffId: summary.diffId,
            snapshotId,
            readOnly: active === null || summary.diffId !== active,
            gone: summary.status === 'gone',
            label: { kind: 'snapshot', commit: summary.commit, status: summary.status },
            createdAt: summary.createdAt,
            unknown: false,
            pending: false,
            routeless: false,
            slice: null,
        };
    }

    const { diffId } = input.viewing;
    const iteration = input.iterations.find((candidate) => candidate.diffId === diffId) ?? null;
    const commit = commitOfDiff(diffId, input);
    if (commit === null) {
        return { ...current, unknown: true };
    }
    // Маршрут для итерации без параметров: текущий снапшот либо на ней построен, либо нет.
    const routeSnapshot = input.route?.snapshot ?? null;
    const onRoute = routeSnapshot !== null && routeSnapshot.diffId === diffId;
    // Активная итерация читается теми же ручками без параметров: параметр только заставил бы
    // перезагрузить уже загруженное. Выбор при этом остаётся в адресе — подпись про итерацию.
    const isActive = active !== null && diffId === active;
    return {
        viewing: input.viewing,
        diffId: isActive ? null : diffId,
        snapshotId: null,
        readOnly: !isActive,
        gone: iteration?.status === 'gone',
        label: onRoute
            ? { kind: 'snapshot', commit: routeSnapshot.commit, status: input.route?.stale == null ? 'current' : 'stale' }
            : { kind: 'diff', commit, status: 'noRoute' },
        createdAt: iteration?.createdAt ?? null,
        unknown: false,
        pending: false,
        routeless: !onRoute,
        slice: null,
    };
}

/**
 * Срез между итерациями: оба края годятся в срез (`sliceIndex`), база старше головы — значит,
 * база из списка, голова из списка или активная. Любой другой набор в адресе — мусор (итерацию
 * переписал force-push, адрес пришёл из чужой вкладки): выбор снимается так же, как неизвестный
 * снапшот, и вкладка падает в активную.
 */
function resolveSlice(
    viewing: { readonly kind: 'slice'; readonly base: string; readonly head: string },
    input: ViewingInput,
    active: string | null,
    current: ResolvedViewing,
): ResolvedViewing {
    const { base, head } = viewing;
    const baseIndex = sliceIndex(input.iterations, active, base);
    const headIndex = sliceIndex(input.iterations, active, head);
    const baseIteration = input.iterations.find((candidate) => candidate.diffId === base) ?? null;
    const headCommit = commitOfDiff(head, input);
    if (
        baseIndex === null ||
        headIndex === null ||
        baseIndex >= headIndex ||
        baseIteration === null ||
        headCommit === null
    ) {
        return { ...current, unknown: true };
    }
    return {
        viewing,
        diffId: head,
        snapshotId: null,
        readOnly: true,
        gone: false,
        label: { kind: 'slice', commit: headCommit, baseCommit: baseIteration.headCommit, status: 'slice' },
        createdAt: baseIteration.createdAt,
        unknown: false,
        pending: false,
        // Маршрут для среза не строится: это «что нового» без ИИ (docs/product.md §3, принцип 1).
        routeless: true,
        slice: { base, head },
    };
}

/**
 * Место итерации среди краёв среза, от старых к новым: индекс в списке итераций (сервер отдаёт
 * его от старых к новым), активная вне списка — самая новая. null — краем среза не бывает:
 * ушедшая (на неё Арканум отвечает 400) или неизвестная.
 */
function sliceIndex(iterations: readonly Iteration[], active: string | null, diffId: string): number | null {
    const index = iterations.findIndex((iteration) => iteration.diffId === diffId);
    if (index === -1) {
        return diffId === active ? iterations.length : null;
    }
    return iterations[index]?.status === 'gone' ? null : index;
}

/**
 * Активная итерация: список итераций, дальше — то, что известно из текущего маршрута
 * (`stale.prDiffId` или итерация его снапшота), дальше — дифф, приехавший без параметров.
 */
export function activeIterationDiffId(
    input: Pick<ViewingInput, 'iterations' | 'activeDiffId'>,
): string | null {
    return input.iterations.find((iteration) => iteration.status === 'active')?.diffId ?? input.activeDiffId;
}

/**
 * Коммит выбранной итерации: из списка итераций, из снапшота на ней, из фактов об активной
 * итерации или из `stale` текущего маршрута. Факты об активной итерации важнее маршрута из
 * состояния вкладки: маршрут перезагружается вместе со сменой выбора, а факты — нет.
 */
function commitOfDiff(diffId: string, input: ViewingInput): string | null {
    const iteration = input.iterations.find((candidate) => candidate.diffId === diffId);
    if (iteration !== undefined) {
        return iteration.headCommit;
    }
    const summary = input.snapshots.find((candidate) => candidate.diffId === diffId);
    if (summary !== undefined) {
        return summary.commit;
    }
    if (input.activeDiffId === diffId && input.activeCommit !== null) {
        return input.activeCommit;
    }
    const stale = input.route?.stale ?? null;
    if (stale !== null && stale.prDiffId === diffId) {
        return stale.prCommit;
    }
    return input.route?.snapshot?.diffId === diffId ? input.route.snapshot.commit : null;
}

/** Индикатор текущего состояния: `устарел`, пока PR ушёл вперёд от снапшота (docs/design/README.md §1). */
function labelOfCurrentRoute(route: UiRouteState | null): ViewingLabel | null {
    const snapshot = route?.snapshot ?? null;
    if (snapshot === null) {
        return null;
    }
    return { kind: 'snapshot', commit: snapshot.commit, status: route?.stale == null ? 'current' : 'stale' };
}

/**
 * Список снапшотов, когда ручка `reviewSnapshots` не ответила (сервер её ещё не умеет):
 * один текущий снапшот, собранный из состояния маршрута. Прошлые снапшоты такому UI
 * недоступны — выбор из адреса окажется неизвестным и снимется.
 */
export function fallbackSnapshots(snapshot: RouteSnapshot | null): readonly UiSnapshotSummary[] {
    if (snapshot === null) {
        return [];
    }
    return [
        {
            snapshotId: snapshot.snapshotId,
            diffId: snapshot.diffId,
            commit: snapshot.commit,
            baseCommit: snapshot.baseCommit,
            createdAt: snapshot.createdAt,
            provenance: snapshot.provenance,
            previousSnapshotId: snapshot.previousSnapshotId,
            status: 'current',
        },
    ];
}

/** Строка пикера: одна на снапшот и по одной на итерацию без снапшота. */
export interface PickerRow {
    readonly kind: 'snapshot' | 'diff';
    /** `snapshotId` или `diffId` — то, что уезжает в выбор и в `data-*` для e2e. */
    readonly id: string;
    readonly diffId: string;
    readonly commit: string;
    /** Короткий идентификатор коммита, различимый в пределах меню (`shortCommits`). */
    readonly short: string;
    /** null — момент неизвестен (итерация из `stale`). */
    readonly createdAt: string | null;
    readonly model: string | null;
    readonly harness: string | null;
    /** Язык генерации снапшота; null — итерация без маршрута или снапшот, записанный до появления языка. */
    readonly locale: Locale | null;
    readonly status: ViewingStatus | 'activeIteration' | 'previousIteration';
    /** Текущий снапшот PR (`current` на сервере): его отмечает выбор без параметров, даже когда подпись — «устарел». */
    readonly latest: boolean;
    /** Коммит строку не различает: в меню есть другая с тем же — время печатается точным. */
    readonly ambiguous: boolean;
    readonly viewing: Viewing;
}

export interface PickerRowsInput {
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Активная итерация PR из фактов App; она не зависит от того, что смотрит вкладка. */
    readonly activeIteration: { readonly diffId: string; readonly commit: string } | null;
    /**
     * Хост умеет итерации (`pr.capabilities.iterations`): без этого ручка среза отвечает 400,
     * и Shift+клик срез не строит.
     */
    readonly interdiff?: boolean;
}

export interface PickerRows {
    /**
     * Снапшоты и итерации без маршрута одним списком: первой — активная итерация (со снапшотом,
     * если он на ней построен), дальше от новых к старым по времени итерации. Снапшот стоит
     * рядом со своей итерацией; несколько снапшотов одной итерации — новыми сверху.
     */
    readonly iterations: readonly PickerRow[];
    /** Итерации, годные в края среза, и их порядок (`sliceIndex`). Пусто, когда хост срезов не умеет. */
    readonly sliceOrder: ReadonlyMap<string, number>;
}

/** Строка до подписей, которые считаются по всему меню разом: короткий id и различимость. */
type RawRow = Omit<PickerRow, 'short' | 'ambiguous'>;

/**
 * Строки пикера. Пустой список итераций всё равно даёт строку активной, если снапшота на ней
 * нет: её `diffId` и коммит известны из маршрута без параметров (сервер может прислать
 * `iterations: []`).
 */
export function pickerRows(input: PickerRowsInput): PickerRows {
    const active = input.activeIteration;
    const snapshots = [...input.snapshots].reverse().map(
        (summary): RawRow => ({
            kind: 'snapshot',
            id: summary.snapshotId,
            diffId: summary.diffId,
            commit: summary.commit,
            createdAt: summary.createdAt,
            model: summary.provenance.model,
            harness: summary.provenance.harness,
            locale: summary.provenance.locale,
            // Текущий снапшот прошлой итерации устарел так же, как в индикаторе: PR ушёл вперёд.
            status:
                summary.status === 'current' && active !== null && summary.diffId !== active.diffId
                    ? 'stale'
                    : summary.status,
            latest: summary.status === 'current',
            viewing: { kind: 'snapshot', snapshotId: summary.snapshotId },
        }),
    );

    const withSnapshot = new Set(input.snapshots.map((summary) => summary.diffId));
    const routeless = input.iterations
        .filter((iteration) => !withSnapshot.has(iteration.diffId))
        .map(
            (iteration): RawRow => ({
                kind: 'diff',
                id: iteration.diffId,
                diffId: iteration.diffId,
                commit: iteration.headCommit,
                createdAt: iteration.createdAt,
                model: null,
                harness: null,
                locale: null,
                status:
                    iteration.status === 'active'
                        ? 'activeIteration'
                        : iteration.status === 'gone'
                          ? 'gone'
                          : 'previousIteration',
                latest: false,
                viewing: { kind: 'diff', diffId: iteration.diffId },
            }),
        )
        .reverse();

    if (routeless.length === 0 && active !== null && !withSnapshot.has(active.diffId)) {
        routeless.push({
            kind: 'diff',
            id: active.diffId,
            diffId: active.diffId,
            commit: active.commit,
            createdAt: null,
            model: null,
            harness: null,
            locale: null,
            status: 'activeIteration',
            latest: false,
            viewing: { kind: 'diff', diffId: active.diffId },
        });
    }

    const activeDiffId =
        input.iterations.find((iteration) => iteration.status === 'active')?.diffId ?? active?.diffId ?? null;
    const timeline = orderedTimeline([...snapshots, ...routeless], input, activeDiffId);
    // Короткие идентификаторы считаются по всему меню разом: различимы они должны быть в нём.
    const short = shortCommits(timeline.map((row) => row.commit));
    // Коммит, на который в меню приходится не одна строка, их не различает: такие показывают
    // точное время вместо округлённого (у итераций без маршрута его до сих пор не было вовсе).
    const perCommit = new Map<string, number>();
    for (const row of timeline) {
        perCommit.set(row.commit, (perCommit.get(row.commit) ?? 0) + 1);
    }
    const dressed = (row: RawRow): PickerRow => ({
        ...row,
        short: short.get(row.commit) ?? row.commit,
        ambiguous: (perCommit.get(row.commit) ?? 0) > 1,
    });
    return {
        iterations: timeline.map(dressed),
        sliceOrder: sliceOrder(input, activeDiffId),
    };
}

function sliceOrder(input: PickerRowsInput, activeDiffId: string | null): ReadonlyMap<string, number> {
    const order = new Map<string, number>();
    if (input.interdiff !== true) {
        return order;
    }
    const candidates = input.iterations.map((iteration) => iteration.diffId);
    if (activeDiffId !== null) {
        candidates.push(activeDiffId);
    }
    for (const diffId of candidates) {
        const index = sliceIndex(input.iterations, activeDiffId, diffId);
        if (index !== null) {
            order.set(diffId, index);
        }
    }
    return order;
}

/** Строка годится в край среза: хост умеет срезы, итерация не ушла, и сравнить её есть с чем. */
export function canBeSliceEdge(rows: PickerRows, row: PickerRow): boolean {
    return rows.sliceOrder.size >= 2 && rows.sliceOrder.has(row.diffId);
}

/** Первый край, который всё ещё годится в срез: строки могли обновиться, пока он был выбран. */
export function liveSliceEdge(rows: PickerRows, edge: string | null): string | null {
    return edge !== null && rows.sliceOrder.has(edge) ? edge : null;
}

/** Срез между двумя итерациями: старшая — база, более новая — голова. null — срезом пара не бывает. */
export function sliceBetween(
    rows: PickerRows,
    first: string,
    second: string,
): Extract<Viewing, { kind: 'slice' }> | null {
    const firstOrder = rows.sliceOrder.get(first);
    const secondOrder = rows.sliceOrder.get(second);
    if (firstOrder === undefined || secondOrder === undefined || firstOrder === secondOrder) {
        return null;
    }
    return firstOrder < secondOrder
        ? { kind: 'slice', base: first, head: second }
        : { kind: 'slice', base: second, head: first };
}

/** Что делает клик по строке: выбирает вид (меню закрывается) или ставит и снимает первый край среза. */
export type RowAction =
    | { readonly kind: 'select'; readonly viewing: Viewing }
    | { readonly kind: 'edge'; readonly edge: string | null };

/**
 * Клик по строке пикера. Срез, как в Аркануме, выбирается в два шага: Shift+клик ставит первый
 * край, следующий клик по другой итерации — с Shift или без — строит срез, клик по итерации
 * первого края его снимает. Строка, которая краем быть не может, выбирается обычным кликом —
 * и без первого края, и с ним.
 */
export function rowAction(rows: PickerRows, edge: string | null, row: PickerRow, shift: boolean): RowAction {
    const first = liveSliceEdge(rows, edge);
    if (first !== null) {
        if (row.diffId === first) {
            return { kind: 'edge', edge: null };
        }
        return { kind: 'select', viewing: sliceBetween(rows, first, row.diffId) ?? row.viewing };
    }
    if (shift && canBeSliceEdge(rows, row)) {
        return { kind: 'edge', edge: row.diffId };
    }
    return { kind: 'select', viewing: row.viewing };
}

export interface SliceRowMark {
    readonly part: 'edge' | 'inside';
    /** Подпись края активного среза — на первой строке группы итерации, как галка выбора. */
    readonly role: 'base' | 'head' | null;
}

/**
 * Диапазон среза на строках пикера. Пока выбран первый край — он сам, а с курсором на строке
 * другой годной итерации — превью будущего среза; превью заменяет отметку активного среза.
 * Без первого края отмечен срез, который смотрит вкладка, с подписями базы и головы.
 */
export function sliceMarks(
    rows: PickerRows,
    viewing: Viewing,
    edge: string | null,
    cursor: PickerRow | null,
): ReadonlyMap<PickerRow, SliceRowMark> {
    const first = liveSliceEdge(rows, edge);
    if (first !== null) {
        const preview = cursor === null ? null : sliceBetween(rows, first, cursor.diffId);
        return preview === null
            ? rangeMarks(rows, first, first, false)
            : rangeMarks(rows, preview.base, preview.head, false);
    }
    return viewing.kind === 'slice' ? rangeMarks(rows, viewing.base, viewing.head, true) : new Map();
}

/** Строки, чья итерация по `sliceOrder` лежит между краями включительно, — со снапшотами тех же итераций. */
function rangeMarks(
    rows: PickerRows,
    base: string,
    head: string,
    roles: boolean,
): ReadonlyMap<PickerRow, SliceRowMark> {
    const marks = new Map<PickerRow, SliceRowMark>();
    const low = rows.sliceOrder.get(base);
    const high = rows.sliceOrder.get(head);
    if (low === undefined || high === undefined) {
        return marks;
    }
    const labelled = new Set<string>();
    for (const row of rows.iterations) {
        const order = rows.sliceOrder.get(row.diffId);
        if (order === undefined || order < low || order > high) {
            continue;
        }
        if (row.diffId !== base && row.diffId !== head) {
            marks.set(row, { part: 'inside', role: null });
            continue;
        }
        const role = roles && !labelled.has(row.diffId) ? (row.diffId === base ? 'base' : 'head') : null;
        labelled.add(row.diffId);
        marks.set(row, { part: 'edge', role });
    }
    return marks;
}

/**
 * Порядок строк меню: активная итерация первой, дальше по времени итерации от новых к старым.
 * Снапшоты не живут отдельным разделом сверху — ревьюер ищет строку по итерации, а не по тому,
 * построен на ней маршрут или нет.
 */
function orderedTimeline(rows: readonly RawRow[], input: PickerRowsInput, activeDiffId: string | null): RawRow[] {
    const times = new Map(input.iterations.map((iteration) => [iteration.diffId, iteration.createdAt]));
    const groups = new Map<string, RawRow[]>();
    for (const row of rows) {
        const group = groups.get(row.diffId);
        if (group === undefined) {
            groups.set(row.diffId, [row]);
        } else {
            group.push(row);
        }
    }
    /** Время итерации; у неизвестной — самый поздний из её снапшотов, иначе конец списка. */
    const timeOf = (diffId: string, group: readonly RawRow[]): string | null =>
        times.get(diffId) ??
        group.map((row) => row.createdAt).filter((at) => at !== null).toSorted().at(-1) ??
        null;

    return [...groups.entries()]
        .map(([diffId, group]) => ({ diffId, group, time: timeOf(diffId, group) }))
        .toSorted((left, right) => {
            if (left.diffId === activeDiffId || right.diffId === activeDiffId) {
                return left.diffId === activeDiffId ? -1 : 1;
            }
            if (left.time === right.time) {
                return 0;
            }
            // Итерация без времени — самая старая: подставить ей «сейчас» значило бы поднять её наверх.
            return left.time === null ? 1 : right.time === null ? -1 : right.time.localeCompare(left.time);
        })
        .flatMap((entry) => entry.group);
}

/** Ниже семи символов коммиты не сокращаются: это подпись из хендоффа (docs/design/README.md §13). */
const SHORT_COMMIT = 7;
/** Длиннее этого префикс не растёт: общий хвост печатается через многоточие. */
const LONGEST_PREFIX = 12;
/** Хвост после многоточия короче не бывает: одного символа мало, чтобы его прочитали как id. */
const SHORTEST_SUFFIX = 4;

/**
 * Короткие идентификаторы коммитов в пределах одного меню: семь символов, как везде в UI,
 * а при совпадении — длиннее, до различимости, как короткие хеши в git.
 *
 * Идентификаторы с длинным общим началом (итерации локального ревью, записанные старой
 * формулой `<sha HEAD>+<8 hex>`, различаются только хвостом) префиксом не догнать — такие
 * строки показываются головой и хвостом через многоточие.
 */
export function shortCommits(commits: readonly string[]): ReadonlyMap<string, string> {
    const unique = [...new Set(commits)];
    const prefix = shortestUnique(unique, SHORT_COMMIT, (commit, length) => commit.slice(0, length));
    if (prefix !== null && prefix <= LONGEST_PREFIX) {
        return new Map(unique.map((commit) => [commit, commit.slice(0, prefix)]));
    }
    const suffix = shortestUnique(unique, SHORTEST_SUFFIX, (commit, length) => commit.slice(-length));
    if (suffix !== null && suffix <= LONGEST_PREFIX) {
        return new Map(
            unique.map((commit) => [commit, `${commit.slice(0, SHORT_COMMIT)}…${commit.slice(-suffix)}`]),
        );
    }
    return new Map(unique.map((commit) => [commit, commit.slice(0, prefix ?? commit.length)]));
}

/** Наименьшая длина от `shortest`, на которой все строки различимы; null — не различимы ни на какой. */
function shortestUnique(
    commits: readonly string[],
    shortest: number,
    cut: (commit: string, length: number) => string,
): number | null {
    const longest = Math.max(shortest, ...commits.map((commit) => commit.length));
    for (let length = shortest; length <= longest; length += 1) {
        if (new Set(commits.map((commit) => cut(commit, length))).size === commits.length) {
            return length;
        }
    }
    return null;
}
