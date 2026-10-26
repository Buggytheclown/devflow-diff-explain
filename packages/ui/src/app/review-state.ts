/**
 * Состояние данных ревью на вкладке и чистые переходы между его ключами: смена PR, хоста
 * или выбранной итерации решается только здесь, без React.
 */
import type {
    Iteration,
    PrDiff,
    RouteSnapshot,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRoutePhase,
    UiRouteState,
    UiSnapshotSummary,
    UiTask,
} from '@sherpa/protocol';
import { LOCAL_VCS_KINDS, localHostName } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

/** Ручка генерации или отмены не отработала. Фаза — та, в которой ревьюер нажимал. */
export interface RouteActionFailure {
    readonly phase: UiRoutePhase | null;
    readonly message: string;
}

/** Список снапшотов PR; `list === null` при загруженном состоянии — ручки у сервера нет. */
export interface SnapshotsState {
    readonly key: string;
    readonly list: readonly UiSnapshotSummary[] | null;
    readonly loaded: boolean;
}

/**
 * Что известно об активной итерации PR. Собирается только из ответов без параметров и живёт
 * отдельно от данных вкладки: выбор прошлой итерации не должен стирать то, по чему он сам же
 * и разрешается (режим чтения, подписи, запасной список снапшотов).
 */
export interface ActiveFacts {
    readonly key: string;
    readonly diffId: string | null;
    readonly commit: string | null;
    readonly snapshot: RouteSnapshot | null;
    /** Маршрут без параметров уже отвечал — в том числе отказом. */
    readonly routeSettled: boolean;
}

export interface ReviewState {
    readonly key: string;
    /** Ключ выбранной итерации: дифф, прогресс и маршрут перечитываются при её смене. */
    readonly viewKey: string;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly route: UiRouteState | null;
    readonly diffError: string | null;
    readonly lensesError: string | null;
    readonly progressError: string | null;
    readonly threadsError: string | null;
    readonly routeError: string | null;
    readonly diffLoading: boolean;
    readonly lensesLoading: boolean;
    readonly progressLoading: boolean;
    readonly threadsLoading: boolean;
    readonly routeLoading: boolean;
}

const EMPTY_SLICE_LENSES: UiReviewLensesResponse = { ownership: null, extra: [], ownershipSource: null };

/** Заглушка прогресса среза числится за самим срезом: ответа сервера про него не бывает. */
function emptySliceProgress(diff: PrDiff | null): UiReviewProgressResponse {
    return { diffId: diff?.diffId ?? '', files: [], stops: [], progressRevision: 0 };
}

/**
 * Состояние вкладки в срезе: линзы, прогресс и треды заменены пустыми. Ручки для них
 * не зовутся вовсе — эти данные привязаны к `fileId` итерации, которых у среза нет.
 */
export function sliceReviewState(current: ReviewState): ReviewState {
    return {
        ...current,
        lenses: EMPTY_SLICE_LENSES,
        lensesError: null,
        lensesLoading: false,
        progress: emptySliceProgress(current.diff),
        progressError: null,
        progressLoading: false,
        threads: EMPTY_THREADS,
        threadsError: null,
        threadsLoading: false,
    };
}

export function emptyReviewState(key: string, viewKey: string, loading: boolean): ReviewState {
    return {
        key,
        viewKey,
        diff: null,
        lenses: null,
        progress: null,
        threads: null,
        route: null,
        diffError: null,
        lensesError: null,
        progressError: null,
        threadsError: null,
        routeError: null,
        diffLoading: loading,
        lensesLoading: loading,
        progressLoading: loading,
        threadsLoading: loading,
        routeLoading: loading,
    };
}

/**
 * Смена PR или хоста обнуляет всё; смена выбранной итерации — только дифф, прогресс и маршрут:
 * треды и линзы хостовые, они одни на PR. Прежние данные при этом не показываются как новые —
 * вью получает скелетон загрузки (docs/design/SPEC-elements.md §3).
 */
/**
 * Слои, общие на весь PR (линзы, треды): выбор итерации им безразличен, и переписывать им
 * `viewKey` нельзя — их ответ мог отстать от смены выбора и откатил бы уже загруженный дифф.
 */
export function sharedReviewState(current: ReviewState, key: string, viewKey: string): ReviewState {
    return current.key === key ? current : emptyReviewState(key, viewKey, true);
}

export function reviewStateForKeys(current: ReviewState, key: string, viewKey: string): ReviewState {
    if (current.key !== key) {
        return emptyReviewState(key, viewKey, true);
    }
    if (current.viewKey === viewKey) {
        return current;
    }
    return {
        ...current,
        viewKey,
        diff: null,
        progress: null,
        route: null,
        diffError: null,
        progressError: null,
        routeError: null,
        diffLoading: true,
        progressLoading: true,
        routeLoading: true,
    };
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const LOCAL_HOSTS: readonly string[] = LOCAL_VCS_KINDS.map(localHostName);

/**
 * Локальное ревью (`local-arc`, `local-git`) в `uiState.reviewHost`: PR здесь нет,
 * и про ушедшую итерацию, устаревший маршрут и доставку комментариев UI говорит своими словами.
 * Какая VCS за ним стоит, ревьюеру на экране знать незачем.
 */
export function isLocalHost(host: string | null): boolean {
    return host !== null && LOCAL_HOSTS.includes(host);
}

export function hostDisplayName(host: string, t: Translate): string {
    if (host === 'arcanum') {
        return t('host.arcanum');
    }
    if (isLocalHost(host)) {
        return t('host.local');
    }
    if (host === 'github') {
        return t('host.github');
    }
    return host === 'fixture' ? 'FixtureHost' : host;
}

/**
 * Подпись пункта меню файла, который открывает `blameUrl`: у Арканума и GitHub веб зовётся по имени,
 * у остальных хостов (фикстура, локальный чекаут без ссылки) — общими словами.
 */
export function fileWebActionLabel(host: string | null, t: Translate): string {
    if (host === 'arcanum') {
        return t('file.menu.openArcanum');
    }
    if (host === 'github') {
        return t('file.menu.openGithub');
    }
    return t('file.menu.openWeb');
}

/** Куда уходят опубликованные черновики: в PR хоста или задачей агенту (у локального ревью PR нет). */
export type DraftDestination = 'pr' | 'agent';

export function draftDestinationOf(reviewHost: string): DraftDestination {
    return isLocalHost(reviewHost) ? 'agent' : 'pr';
}

export function emptySnapshots(key: string): SnapshotsState {
    return { key, list: null, loaded: false };
}

export function emptyActiveFacts(key: string): ActiveFacts {
    return { key, diffId: null, commit: null, snapshot: null, routeSettled: false };
}

export const EMPTY_THREADS: readonly Thread[] = [];
export const EMPTY_ITERATIONS: readonly Iteration[] = [];
export const EMPTY_TASKS: readonly UiTask[] = [];
