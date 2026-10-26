import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Раздача собранного UI. Статика — единственное, что отдаётся без токена: секретов в ней нет,
 * а токен браузер получает фрагментом URL и на сервер его не отправляет (docs/protocol.md §8).
 */

/** Готовый к отправке файл сборки UI. */
export interface StaticAsset {
    readonly content: Buffer;
    readonly contentType: string;
}

/**
 * Источник статики UI. Реализаций две: каталог сборки на диске (дев-запуск) и карта файлов,
 * зашитая в сервер-бандл на сборке (дистрибутив скилла). Роутер разницы не видит.
 */
export interface StaticAssets {
    /** `null` — такого файла в сборке UI нет. */
    readonly read: (pathname: string) => Promise<StaticAsset | null>;
}

/** Пути статики: корень отдаёт `index.html`, остальное — сборочные ассеты Vite. */
export function isStaticPath(pathname: string): boolean {
    return pathname === '/' || pathname.startsWith('/assets/');
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

export function contentTypeOf(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Статика с диска: дев-запуск сервера под tsx, каталог `packages/ui/dist`. */
export function directoryAssets(uiDir: string): StaticAssets {
    const root = path.resolve(uiDir);

    return {
        read: async (pathname) => {
            const relative = normalizeStaticPath(pathname);
            if (relative === null) {
                return null;
            }

            // `new URL` схлопывает `..` сам, но процентное кодирование доживает до сюда,
            // поэтому проверяем уже разрешённый путь.
            const file = path.resolve(root, `.${relative}`);
            if (!file.startsWith(root + path.sep)) {
                return null;
            }

            try {
                return { content: await fs.readFile(file), contentType: contentTypeOf(file) };
            } catch {
                return null;
            }
        },
    };
}

/**
 * Статика из памяти: карта «путь → base64», зашитая в сервер-бандл на сборке.
 * Дистрибутив скилла — два файла, каталога `ui/dist` рядом с ним нет.
 */
export function bundledAssets(files: Readonly<Record<string, string>>): StaticAssets {
    const decoded = new Map<string, StaticAsset>();
    for (const [pathname, base64] of Object.entries(files)) {
        decoded.set(pathname, { content: Buffer.from(base64, 'base64'), contentType: contentTypeOf(pathname) });
    }

    return {
        read: (pathname) => {
            const relative = normalizeStaticPath(pathname);
            return Promise.resolve(relative === null ? null : (decoded.get(relative) ?? null));
        },
    };
}

/** Отдаёт файл сборки; `false` — файла нет или путь ведёт наружу сборки (ответ шлёт роутер). */
export async function serveStatic(res: ServerResponse, assets: StaticAssets, pathname: string): Promise<boolean> {
    const asset = await assets.read(pathname);
    if (asset === null) {
        return false;
    }

    res.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': String(asset.content.byteLength),
        // Дев-петля: собранный UI меняется под тем же именем, кеш браузера тут только мешает.
        'cache-control': 'no-store',
    });
    res.end(asset.content);
    return true;
}

/** Путь запроса в путь внутри сборки UI (`/` → `/index.html`); `null` — путь не декодируется. */
function normalizeStaticPath(pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    return decoded === '/' ? '/index.html' : decoded;
}
