import { describe, expect, it } from 'vitest';

import { checkNodeVersion, MIN_NODE_MAJOR, MIN_NODE_MINOR } from './runtime.js';

const MIN_VERSION = `${String(MIN_NODE_MAJOR)}.${String(MIN_NODE_MINOR)}`;

describe('проверка версии рантайма', () => {
    it('пропускает поддерживаемые версии', () => {
        expect(checkNodeVersion(`${MIN_VERSION}.0`)).toBeNull();
        expect(checkNodeVersion('23.4.0')).toBeNull();
        expect(checkNodeVersion('v24.11.1')).toBeNull();
    });

    it('объясняет человеку, что делать, на слишком старой версии', () => {
        expect(checkNodeVersion('18.20.4')).toContain('18.20.4');

        // Порог с минором: node:sqlite без флага появился именно в 22.13.
        const tooOldMinor = checkNodeVersion('22.12.0');
        expect(tooOldMinor).toContain(MIN_VERSION);
        expect(tooOldMinor).toContain('22.12.0');
    });

    it('отсекает 23.0–23.3: линейка старше порога, но node:sqlite там ещё за флагом', () => {
        expect(checkNodeVersion('23.0.0')).toContain('23.0.0');
        expect(checkNodeVersion('v23.3.0')).toContain('23.3.0');
    });

    it('не блокирует запуск при нераспознанной версии', () => {
        expect(checkNodeVersion(undefined)).toBeNull();
        expect(checkNodeVersion('')).toBeNull();
    });
});
