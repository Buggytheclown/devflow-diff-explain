import { describe, expect, it, vi } from 'vitest';

import { browserCommand, openBrowser } from './browser.js';

const UI_URL = 'http://127.0.0.1:4317/#t=Ab_cd-12';

describe('системный opener', () => {
    it('выбирает open, xdg-open и start по платформе', () => {
        expect(browserCommand('darwin', UI_URL)).toEqual({ command: 'open', args: [UI_URL] });
        expect(browserCommand('linux', UI_URL)).toEqual({ command: 'xdg-open', args: [UI_URL] });
        expect(browserCommand('win32', UI_URL)).toEqual({
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', 'start', '', UI_URL],
        });
        expect(browserCommand('freebsd', UI_URL)).toBeNull();
    });

    it('спавнит opener отвязанно через инъекцию, не открывая браузер в тесте', () => {
        const unref = vi.fn();
        const once = vi.fn();
        const spawnBrowser = vi.fn(() => ({ once, unref }));

        openBrowser({ uiUrl: UI_URL, platform: 'darwin', spawnBrowser });

        expect(spawnBrowser).toHaveBeenCalledWith('open', [UI_URL], { detached: true, stdio: 'ignore' });
        expect(once).toHaveBeenCalledWith('error', expect.any(Function));
        expect(unref).toHaveBeenCalledOnce();
    });

    it('ошибка spawn и неизвестная платформа остаются тихим запасным путём', () => {
        expect(() => {
            openBrowser({
                uiUrl: UI_URL,
                platform: 'linux',
                spawnBrowser: () => {
                    throw new Error('нет xdg-open');
                },
            });
        }).not.toThrow();
        expect(() => {
            openBrowser({ uiUrl: UI_URL, platform: 'aix' });
        }).not.toThrow();
    });
});
