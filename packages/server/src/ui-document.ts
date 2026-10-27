import type { UiSettings } from '@sherpa/protocol';

import type { StaticAssets } from './static.js';

/**
 * Состояние документа в отдаваемом `index.html`. Тема и размер текста подставляются на момент
 * запроса: дожидаться ответа `GET /api/ui/settings` нельзя — это второй кадр в другой теме
 * (решение `docs/architecture.md`, 2026-09-12). Режим `auto` подставить нечем, системную тему знает
 * только браузер, поэтому для него в `<head>` встраивается короткий скрипт — он ставит атрибут
 * до подключения стилей, а дальше тему ведёт UI (`settings/document-settings.tsx`).
 */

/** Настройки, которые видны в первом кадре. */
export type DocumentSettings = Pick<UiSettings, 'theme' | 'arcanum' | 'textSize'>;

const HTML_OPEN_TAG = /<html\b[^>]*>/i;
const HEAD_OPEN_TAG = /<head\b[^>]*>/i;
const DOCUMENT_ATTRIBUTES = /\s+data-(?:theme|textsize)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** Тот же запрос читает рантайм UI (`settings/document-settings.tsx`). */
function autoThemeScript(arcanum: boolean): string {
    const themes = arcanum ? '"arcanum-dark":"arcanum-light"' : '"dark":"light"';
    return '<script>document.documentElement.setAttribute("data-theme",' +
        `window.matchMedia("(prefers-color-scheme: dark)").matches?${themes})</script>`;
}

/** Статика UI, в которой `index.html` отдаётся с подставленным состоянием документа. */
export function withDocumentSettings(assets: StaticAssets, readSettings: () => DocumentSettings): StaticAssets {
    return {
        read: async (pathname) => {
            const asset = await assets.read(pathname);
            if (asset === null || !isIndexDocument(pathname)) {
                return asset;
            }
            const html = injectDocumentSettings(asset.content.toString('utf8'), readSettings());
            return { content: Buffer.from(html, 'utf8'), contentType: asset.contentType };
        },
    };
}

/**
 * Ставит `data-theme` (только для явной темы) и `data-textsize` на `<html>`, а в режиме `auto`
 * добавляет скрипт первым в `<head>`. Документ без `<html>` остаётся как есть: подставлять некуда.
 */
export function injectDocumentSettings(html: string, settings: DocumentSettings): string {
    const tag = HTML_OPEN_TAG.exec(html);
    if (tag === null) {
        return html;
    }

    const attributes = [`data-textsize="${settings.textSize}"`];
    if (settings.theme !== 'auto') {
        attributes.push(`data-theme="${settings.arcanum ? 'arcanum-' : ''}${settings.theme}"`);
    }
    const withAttributes = html.replace(HTML_OPEN_TAG, () => rewriteHtmlTag(tag[0], attributes));
    return settings.theme === 'auto' ? withAutoThemeScript(withAttributes, settings.arcanum) : withAttributes;
}

function isIndexDocument(pathname: string): boolean {
    return pathname === '/' || pathname === '/index.html';
}

/** Свои атрибуты заменяют прежние: повторная подстановка не должна оставлять два `data-theme`. */
function rewriteHtmlTag(tag: string, attributes: readonly string[]): string {
    const stripped = tag.slice(0, -1).replace(DOCUMENT_ATTRIBUTES, '').trimEnd();
    return `${stripped} ${attributes.join(' ')}>`;
}

/** Скрипт идёт первым в `<head>`: он обязан отработать до стилей, иначе первый кадр перекрасится. */
function withAutoThemeScript(html: string, arcanum: boolean): string {
    const script = autoThemeScript(arcanum);
    const head = HEAD_OPEN_TAG.exec(html);
    if (head !== null) {
        return html.replace(HEAD_OPEN_TAG, () => `${head[0]}${script}`);
    }
    // `<head>` в документе не обязателен: браузер откроет его сам, и скрипт окажется внутри.
    return html.replace(HTML_OPEN_TAG, (tag) => `${tag}${script}`);
}
