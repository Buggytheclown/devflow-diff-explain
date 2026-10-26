import type { PublishResult, ReviewerVerdict, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { publishReview } from '../api.js';
import { isShipVerdict } from '../components/review-action-model.js';
import type { ShipVerdictEvent, ShipVerdictWatch } from '../components/ship-verdict-banner.tsx';
import { INITIAL_SHIP_VERDICT_WATCH, observeShipVerdicts } from '../components/ship-verdict-banner.tsx';

export interface UseShipVerdictResult {
    readonly shipVerdict: ShipVerdictEvent | null;
    readonly shipVerdictNow: number;
    readonly setShipVerdict: (event: ShipVerdictEvent | null) => void;
    readonly publishHere: (verdict: Verdict) => Promise<PublishResult>;
}

/**
 * Чужой шип: вердикты приезжают в снапшоте меты, времени у них нет — момент
 * замечаем сами. Первый снапшот за сессию вкладки — базовая линия, баннера по нему нет.
 */
export function useShipVerdict(
    verdicts: readonly ReviewerVerdict[] | null,
    token: string,
): UseShipVerdictResult {
    const verdictWatch = useRef<ShipVerdictWatch>(INITIAL_SHIP_VERDICT_WATCH);
    const [shipVerdict, setShipVerdict] = useState<ShipVerdictEvent | null>(null);
    const [shipVerdictNow, setShipVerdictNow] = useState(() => Date.now());
    useEffect(() => {
        if (verdicts === null) {
            return;
        }
        const observed = observeShipVerdicts(verdictWatch.current, verdicts, Date.now());
        verdictWatch.current = observed.watch;
        if (observed.event !== null) {
            setShipVerdict(observed.event);
            setShipVerdictNow(observed.event.observedAt);
        }
    }, [verdicts]);
    const publishHere = useCallback(
        async (verdict: Verdict): Promise<PublishResult> => {
            const result = await publishReview(token, verdict);
            if (isShipVerdict(verdict)) {
                // Свой вердикт вот-вот появится в мете: баннером о нём сообщать некому.
                verdictWatch.current = { ...verdictWatch.current, ownShipPending: true };
            }
            return result;
        },
        [token],
    );
    // «только что» через минуту становится «N мин назад»: время в баннере обновляется само.
    useEffect(() => {
        if (shipVerdict === null) {
            return;
        }
        const timer = window.setInterval(() => {
            setShipVerdictNow(Date.now());
        }, 60_000);
        return () => {
            window.clearInterval(timer);
        };
    }, [shipVerdict]);

    return { shipVerdict, shipVerdictNow, setShipVerdict, publishHere };
}
