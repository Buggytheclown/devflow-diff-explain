import type { HostId, PublishResult, Verdict } from '@sherpa/protocol';

import type { DraftDestination } from '../app/review-state.js';
import type { MessageKey, Translate } from '../i18n/index.js';
import { READ_ONLY_REASON } from '../iterations/read-only.tsx';
import type { ConnectionState } from '../store.js';

/** Режим сплит-кнопки Ship; Request changes — отдельная кнопка. */
export type ShipMode = Extract<Verdict, 'ship' | 'sticky_ship' | 'comment'>;

/** Строки меню Ship в порядке показа. */
export const SHIP_MENU_MODES: readonly ShipMode[] = ['ship', 'sticky_ship', 'comment'];

/** Ключи следствия публикации: все параметризованы числом черновиков. */
export type PublishConsequenceKey = Extract<
    MessageKey,
    | 'ship.consequence.comment'
    | 'ship.consequence.commentAgent'
    | 'ship.consequence.ship'
    | 'ship.consequence.requestChanges'
    | 'ship.consequence.shipAgent'
    | 'ship.consequence.requestChangesAgent'
>;

export interface PublishGuardInput {
    /** Причины выключенной кнопки — текст, а не ключи: их собирают в подсказку прямо на месте. */
    readonly t: Translate;
    readonly connection: ConnectionState;
    readonly pendingComposer: boolean;
    /**
     * Черновики в буфере сервера: хост их ещё не принял, публиковать нечего —
     * ship ждёт, пока они доедут (docs/design/SPEC-elements.md §4.5).
     */
    readonly bufferedDrafts?: number;
    readonly publishing: boolean;
    /** После провала разрешён только явный повтор того же вердикта. */
    readonly failure?: boolean;
    /** Вкладка смотрит прошлую итерацию: шипать можно только активную. */
    readonly readOnlyIteration?: boolean;
    /** Причина режима чтения из контекста; по умолчанию — про активную итерацию. */
    readonly readOnlyReason?: string;
}

export interface FailedPublicationComment {
    readonly commentId: HostId;
    readonly message: string;
    readonly body: string | null;
}

export interface PublicationFailure {
    readonly verdict: Verdict;
    readonly failedCount: number;
    readonly comments: readonly FailedPublicationComment[];
    readonly message: string | null;
}

/** Причина выключенного вердикта одна и та же для кнопок, шорткатов и палитры. */
export function publishDisabledReason(input: PublishGuardInput): string | null {
    if (input.readOnlyIteration === true) {
        return input.readOnlyReason ?? input.t(READ_ONLY_REASON);
    }
    if (input.publishing) {
        return input.t('ship.disabled.publishing');
    }
    if (input.connection === 'reconnecting' || input.connection === 'fatal') {
        return input.t('ship.disabled.offline');
    }
    if (input.pendingComposer) {
        return input.t('ship.disabled.pending');
    }
    const buffered = input.bufferedDrafts ?? 0;
    if (buffered > 0) {
        return input.t('ship.disabled.buffered', buffered);
    }
    if (input.failure === true) {
        return input.t('ship.disabled.retry');
    }
    return null;
}

/** Режимы сплит-кнопки, которые хост примет на этом PR; меню у кнопки есть, когда их больше одного. */
export function shipModesOf(publishVerdicts: readonly Verdict[]): ShipMode[] {
    return SHIP_MENU_MODES.filter((mode) => publishVerdicts.includes(mode));
}

/**
 * Действующий режим сплит-кнопки: сохранённый, если он среди режимов PR; иначе ship, затем comment,
 * затем первый доступный; null — хост на этом PR ни одного режима кнопки не принимает.
 */
export function availableShipMode(saved: ShipMode, modes: readonly ShipMode[]): ShipMode | null {
    if (modes.includes(saved)) {
        return saved;
    }
    if (modes.includes('ship')) {
        return 'ship';
    }
    return modes.includes('comment') ? 'comment' : (modes[0] ?? null);
}

/** Режим сплит-кнопки, которым опубликован вердикт; его запоминают настройки. */
export function shipModeOf(verdict: Verdict): ShipMode | null {
    switch (verdict) {
        case 'ship':
        case 'sticky_ship':
        case 'comment':
            return verdict;
        case 'request_changes':
            return null;
        default:
            return unreachableVerdict(verdict);
    }
}

/** Вердикт одобряет PR: по своему шипу гасится баннер чужого. */
export function isShipVerdict(verdict: Verdict): boolean {
    switch (verdict) {
        case 'ship':
        case 'sticky_ship':
            return true;
        case 'comment':
        case 'request_changes':
            return false;
        default:
            return unreachableVerdict(verdict);
    }
}

/** Подпись режима на главной части и в строке меню. */
export function shipModeLabelKey(mode: ShipMode): 'ship.mode.ship' | 'ship.mode.sticky' | 'ship.mode.comment' {
    switch (mode) {
        case 'ship':
            return 'ship.mode.ship';
        case 'sticky_ship':
            return 'ship.mode.sticky';
        case 'comment':
            return 'ship.mode.comment';
        default:
            return unreachableVerdict(mode);
    }
}

/** Почему строку меню нельзя выбрать. Публикации без вердикта ещё и нечего нести без черновиков. */
export function shipOptionDisabledKey(
    mode: ShipMode,
    modes: readonly ShipMode[],
    drafts: number,
    destination: DraftDestination,
):
    | 'ship.mode.ship.unavailable'
    | 'ship.mode.sticky.unavailable'
    | 'ship.mode.comment.unavailable'
    | NoDraftsKey
    | null {
    switch (mode) {
        case 'ship':
            return modes.includes(mode) ? null : 'ship.mode.ship.unavailable';
        case 'sticky_ship':
            return modes.includes(mode) ? null : 'ship.mode.sticky.unavailable';
        case 'comment':
            if (!modes.includes(mode)) {
                return 'ship.mode.comment.unavailable';
            }
            return drafts === 0 ? noDraftsKey(destination) : null;
        default:
            return unreachableVerdict(mode);
    }
}

type NoDraftsKey = 'ship.noDrafts' | 'ship.noDraftsForAgent';

/** «Нет черновиков» — тем, куда они ушли бы. */
export function noDraftsKey(destination: DraftDestination): NoDraftsKey {
    switch (destination) {
        case 'pr':
            return 'ship.noDrafts';
        case 'agent':
            return 'ship.noDraftsForAgent';
        default:
            return unreachableDestination(destination);
    }
}

/** Счётчик черновиков на панели — тем, куда они уйдут. */
export function draftsCounterKey(destination: DraftDestination): 'ship.drafts' | 'ship.draftsToAgent' {
    switch (destination) {
        case 'pr':
            return 'ship.drafts';
        case 'agent':
            return 'ship.draftsToAgent';
        default:
            return unreachableDestination(destination);
    }
}

/**
 * Следствие команды видно до запуска в палитре и в подсказке кнопки. Реестр шорткатов хранит
 * ключ, а число черновиков едет отдельным аргументом — палитра переводит ключ сама.
 */
export function publishConsequenceKey(verdict: Verdict, destination: DraftDestination): PublishConsequenceKey {
    switch (verdict) {
        case 'comment':
            return destination === 'agent' ? 'ship.consequence.commentAgent' : 'ship.consequence.comment';
        case 'ship':
        case 'sticky_ship':
            return destination === 'agent' ? 'ship.consequence.shipAgent' : 'ship.consequence.ship';
        case 'request_changes':
            return destination === 'agent' ? 'ship.consequence.requestChangesAgent' : 'ship.consequence.requestChanges';
        default:
            return unreachableVerdict(verdict);
    }
}

export function unreachableVerdict(verdict: never): never {
    throw new Error(`unknown verdict ${String(verdict)}`);
}

function unreachableDestination(destination: never): never {
    throw new Error(`unknown draft destination ${String(destination)}`);
}

export function partialPublicationFailure(
    verdict: Verdict,
    result: PublishResult,
    bodies: ReadonlyMap<HostId, string>,
    t: Translate,
): PublicationFailure | null {
    if (result.verdictApplied) {
        return null;
    }
    return {
        verdict,
        failedCount: result.failed.length,
        comments: result.failed.map((failure) => ({
            ...failure,
            body: bodies.get(failure.commentId) ?? null,
        })),
        message: result.failed.length === 0 ? t('ship.error.verdict') : null,
    };
}

export function requestPublicationFailure(verdict: Verdict, drafts: number, error: unknown): PublicationFailure {
    return {
        verdict,
        failedCount: drafts,
        comments: [],
        message: error instanceof Error ? error.message : String(error),
    };
}
