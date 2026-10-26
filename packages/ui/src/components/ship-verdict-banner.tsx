import type { ReviewerVerdict } from '@sherpa/protocol';

import { useFormat, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import './ship-verdict-banner.css';

/**
 * «Кто-то шипнул раньше» (docs/design/SPEC-elements.md §4.5): чужой ship не отменяет ревью —
 * черновики всё равно опубликуются, — но знать об этом ревьюер должен до того, как нажмёт
 * свою кнопку.
 *
 * Времени вердикта хосты не отдают, поэтому «когда» считается от момента, в который вкладка
 * увидела вердикт в снапшоте меты. Первый снапшот — базовая линия: всё, что было до открытия
 * вкладки, новостью не является.
 */

export interface ShipVerdictEvent {
    readonly login: string;
    readonly displayName: string | null;
    /** Момент, в который вкладка заметила вердикт. */
    readonly observedAt: number;
}

/**
 * Новый чужой ship в снапшоте меты. `previous: null` — первый снапшот за эту сессию вкладки,
 * событий из него не бывает.
 */
export function newShipVerdict(
    previous: readonly ReviewerVerdict[] | null,
    next: readonly ReviewerVerdict[],
    observedAt: number,
): ShipVerdictEvent | null {
    if (previous === null) {
        return null;
    }
    const shipped = new Set(previous.filter(isShip).map((verdict) => verdict.user.login));
    const fresh = next.filter(isShip).find((verdict) => !shipped.has(verdict.user.login));
    return fresh === undefined
        ? null
        : { login: fresh.user.login, displayName: fresh.user.displayName, observedAt };
}

/**
 * Что вкладка уже знает о вердиктах. `ownShipPending` — своя публикация ждёт своего же
 * вердикта в снапшоте: логина ревьюера у UI нет, и отличить свой ship от чужого нечем.
 */
export interface ShipVerdictWatch {
    readonly seen: readonly ReviewerVerdict[] | null;
    readonly ownShipPending: boolean;
}

export const INITIAL_SHIP_VERDICT_WATCH: ShipVerdictWatch = { seen: null, ownShipPending: false };

/**
 * Новый снапшот вердиктов: что запомнить и о чём сказать ревьюеру. Первый ship после своей
 * публикации — свой, и новостью он не является; цена — чужой ship, приехавший тем же
 * снапшотом, что и наш, останется незамеченным.
 */
export function observeShipVerdicts(
    watch: ShipVerdictWatch,
    verdicts: readonly ReviewerVerdict[],
    observedAt: number,
): { readonly watch: ShipVerdictWatch; readonly event: ShipVerdictEvent | null } {
    const event = newShipVerdict(watch.seen, verdicts, observedAt);
    if (event === null) {
        return { watch: { ...watch, seen: verdicts }, event: null };
    }
    if (watch.ownShipPending) {
        return { watch: { seen: verdicts, ownShipPending: false }, event: null };
    }
    return { watch: { ...watch, seen: verdicts }, event };
}

function isShip(verdict: ReviewerVerdict): boolean {
    return verdict.verdict === 'ship' || verdict.verdict === 'sticky_ship';
}

export function ShipVerdictBanner({
    event,
    now,
    onDismiss,
}: {
    readonly event: ShipVerdictEvent;
    readonly now: number;
    readonly onDismiss: () => void;
}) {
    const t = useT();
    const format = useFormat();
    const when = format.relativeTime(new Date(event.observedAt).toISOString(), now);
    return (
        <div className="ship-verdict-banner" role="status">
            <Icon name="thumb" size={14} className="ship-verdict-banner__icon" />
            <div className="ship-verdict-banner__body">
                {t('ship.verdict.banner', event.displayName ?? event.login, when)}
            </div>
            <button
                type="button"
                className="ctl ctl--toolbar-icon ship-verdict-banner__dismiss"
                aria-label={t('ship.verdict.dismiss')}
                title={t('ship.verdict.dismiss.title')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
