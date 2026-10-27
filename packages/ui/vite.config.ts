import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

// Версия поставки одна на весь дистрибутив — поле `version` корневого package.json.
// Версия пакета UI источником не является.
const rootPackageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * Сборка UI. В прод-сборку идёт только `index.html`: `gallery.html` (галерея состояний)
 * и `dev.html` (демо echo-петли) — дев-страницы, они доступны в `vite dev` и не
 * раздувают бандл сервера.
 *
 * Шрифты приезжают npm-пакетом и попадают в `dist/assets` — в рантайме сеть не нужна.
 */
const proxy = devProxy();

export default defineConfig({
    plugins: [react()],
    define: { __SHERPA_VERSION__: JSON.stringify(rootPackageJson.version) },
    server: proxy === null ? {} : { proxy },
    // Дефолтные 5 с малы: сценарные тесты прогресса гоняют десятки перерисовок и на
    // загруженной машине (`pnpm -r test` держит все пакеты разом) упираются в таймаут,
    // хотя в одиночку идут 1–2 с. Зависший тест это по-прежнему ловит, просто позже.
    test: { testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 4,
    },
});

/**
 * Дев-прокси на живой сервер Шерпы: `dev.html` ходит в те же `/api`, что и главная.
 * Адрес берётся из `SHERPA_SERVER`, иначе — из манифеста запущенного сервера
 * (`~/.sherpa/servers/<ключ PR>.json`, docs/protocol.md §8): порт эфемерный, зашить его нельзя.
 * Сервер, поднятый уже после `vite dev`, требует перезапуска дев-сервера.
 */
function devProxy(): Record<string, ProxyOptions> | null {
    const target = process.env.SHERPA_SERVER ?? runningServerOrigin();
    return target === null ? null : { '/api': { target, changeOrigin: false } };
}

/** Первый живой манифест: в дев-режиме открытых PR обычно один. `null` — сервера нет. */
function runningServerOrigin(): string | null {
    const dir = path.join(homedir(), '.sherpa', 'servers');

    let names: readonly string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
        return null;
    }

    for (const name of names) {
        try {
            const manifest = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { port?: unknown };
            if (typeof manifest.port === 'number') {
                return `http://127.0.0.1:${String(manifest.port)}`;
            }
        } catch {
            // Битый или чужой файл — просто пропускаем.
        }
    }
    return null;
}
