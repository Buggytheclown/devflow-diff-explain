import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import type { StaticAssets } from './static.js';
import { injectDocumentSettings, withDocumentSettings } from './ui-document.js';

const INDEX = [
    '<!doctype html>',
    '<html lang="ru">',
    '    <head>',
    '        <meta charset="utf-8" />',
    '        <link rel="stylesheet" href="/assets/app.css" />',
    '    </head>',
    '    <body><div id="root"></div></body>',
    '</html>',
].join('\n');

describe('состояние документа в index.html', () => {
    it.each([
        ['dark', false, 'dark'],
        ['light', false, 'light'],
        ['dark', true, 'arcanum-dark'],
        ['light', true, 'arcanum-light'],
    ] as const)('явная тема %s, Arcanum=%s едет атрибутом без системного скрипта', (theme, arcanum, expected) => {
        const html = injectDocumentSettings(INDEX, { theme, arcanum, textSize: 'm' });

        expect(html).toContain(`<html lang="ru" data-textsize="m" data-theme="${expected}">`);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('prefers-color-scheme');
    });

    it('размер текста стоит на `<html>` при любой теме', () => {
        expect(injectDocumentSettings(INDEX, { theme: 'dark', arcanum: false, textSize: 'l' })).toContain('data-textsize="l"');
        expect(injectDocumentSettings(INDEX, { theme: 'auto', arcanum: true, textSize: 'l' })).toContain('data-textsize="l"');
    });

    it('auto: скрипт стоит первым в `<head>`, до подключения стилей', () => {
        const html = injectDocumentSettings(INDEX, { theme: 'auto', arcanum: false, textSize: 'm' });

        expect(html).not.toContain('data-theme=');
        expect(html).toContain('prefers-color-scheme: dark');
        expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<script>'));
    });

    it.each([
        [false, false, 'light'],
        [false, true, 'dark'],
        [true, false, 'arcanum-light'],
        [true, true, 'arcanum-dark'],
    ] as const)('Auto: Arcanum=%s, системная тёмная=%s разрешаются до CSS', (arcanum, dark, expected) => {
        const html = injectDocumentSettings(INDEX, { theme: 'auto', arcanum, textSize: 'm' });
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
        expect(script).toBeDefined();
        expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        const attributes: Record<string, string> = {};
        runInNewContext(script ?? '', {
            document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } } },
            window: { matchMedia: () => ({ matches: dark }) },
        });

        expect(attributes).toEqual({ 'data-theme': expected });
    });

    it('прежние атрибуты документа заменяются, а не удваиваются', () => {
        const stale = INDEX.replace('<html lang="ru">', '<html lang="ru" data-theme=\'dark\' data-textsize=l>');

        const html = injectDocumentSettings(stale, { theme: 'dark', arcanum: true, textSize: 'm' });

        expect(html).toContain('<html lang="ru" data-textsize="m" data-theme="arcanum-dark">');
        expect([...html.matchAll(/data-theme=/g)]).toHaveLength(1);
        expect([...html.matchAll(/data-textsize=/g)]).toHaveLength(1);
    });

    it('минимальный документ: регистр тегов и отсутствие `<head>` подстановку не ломают', () => {
        const upper = injectDocumentSettings('<!DOCTYPE HTML><HTML><BODY>x</BODY></HTML>', {
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
        });

        expect(upper).toContain('data-textsize="m"');
        // `<head>` браузер откроет сам, и скрипт окажется в нём — лишь бы он шёл до тела.
        expect(upper.indexOf('<script>')).toBeLessThan(upper.indexOf('<BODY>'));
    });

    it('документ без `<html>` остаётся как есть: подставлять некуда', () => {
        const raw = '<!doctype html><title>Sherpa</title>';

        expect(injectDocumentSettings(raw, { theme: 'light', arcanum: false, textSize: 'l' })).toBe(raw);
    });

    it('обёртка статики правит только index.html и читает настройки на каждый запрос', async () => {
        let theme: 'auto' | 'dark' | 'light' = 'light';
        const assets = withDocumentSettings(staticAssets({ '/index.html': INDEX, '/assets/app.css': 'body{}' }), () => ({
            theme,
            arcanum: false,
            textSize: 'm',
        }));

        const light = await assets.read('/');
        theme = 'dark';
        const dark = await assets.read('/index.html');
        const css = await assets.read('/assets/app.css');

        expect(light?.content.toString('utf8')).toContain('data-theme="light"');
        expect(dark?.content.toString('utf8')).toContain('data-theme="dark"');
        expect(light?.contentType).toContain('text/html');
        expect(css?.content.toString('utf8')).toBe('body{}');
        expect(await assets.read('/assets/missing.css')).toBeNull();
    });
});

/** Карта «путь внутри сборки → содержимое»: `read` тут уже получает нормализованный путь. */
function staticAssets(files: Readonly<Record<string, string>>): StaticAssets {
    return {
        read: (pathname) => {
            const file = files[pathname === '/' ? '/index.html' : pathname];
            return Promise.resolve(
                file === undefined
                    ? null
                    : {
                          content: Buffer.from(file, 'utf8'),
                          contentType: pathname.endsWith('.css')
                              ? 'text/css; charset=utf-8'
                              : 'text/html; charset=utf-8',
                      },
            );
        },
    };
}
