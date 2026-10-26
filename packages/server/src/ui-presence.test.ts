import { UI_GONE_GRACE_SECONDS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UiPresence } from './ui-presence.js';

const START = new Date('2026-08-31T12:00:00.000Z');

describe('присутствие UI', () => {
    let now: Date;
    let presence: UiPresence;

    beforeEach(() => {
        now = START;
        presence = new UiPresence({ now: () => now });
    });

    afterEach(() => {
        presence.close();
    });

    function advanceSeconds(seconds: number): void {
        now = new Date(now.getTime() + seconds * 1000);
        presence.checkNow();
    }

    it('UI не открывали — uiGone не наступает никогда', () => {
        advanceSeconds(UI_GONE_GRACE_SECONDS * 10);

        expect(presence.connectionCount).toBe(0);
        expect(presence.uiGone).toBe(false);
    });

    it('возврат до истечения грейса отменяет уход бесследно', () => {
        const disconnect = presence.connect();
        disconnect();
        advanceSeconds(UI_GONE_GRACE_SECONDS - 1);
        expect(presence.uiGone).toBe(false);

        const disconnectAgain = presence.connect();
        advanceSeconds(2);
        expect(presence.uiGone).toBe(false);

        disconnectAgain();
        advanceSeconds(UI_GONE_GRACE_SECONDS - 1);
        expect(presence.uiGone).toBe(false);
        advanceSeconds(1);
        expect(presence.uiGone).toBe(true);
    });

    it('несколько вкладок: грейс начинается после закрытия последней', () => {
        const disconnectFirst = presence.connect();
        const disconnectSecond = presence.connect();
        expect(presence.connectionCount).toBe(2);

        disconnectFirst();
        advanceSeconds(UI_GONE_GRACE_SECONDS * 2);
        expect(presence.uiGone).toBe(false);

        disconnectSecond();
        advanceSeconds(UI_GONE_GRACE_SECONDS);
        expect(presence.uiGone).toBe(true);
    });

    it('повторное подключение после uiGone возвращает живое состояние', () => {
        const disconnect = presence.connect();
        disconnect();
        advanceSeconds(UI_GONE_GRACE_SECONDS);
        expect(presence.uiGone).toBe(true);

        presence.connect();

        expect(presence.connectionCount).toBe(1);
        expect(presence.uiGone).toBe(false);
    });
});
