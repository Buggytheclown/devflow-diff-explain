import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatUiUrl, isDirectory, readOption, resolveUiDir, UI_BUILD_HINT } from './launch.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** Разбор аргументов дев-запуска и поиск собранного UI. */
describe('запуск сервера', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        await removeTempSherpaDir(tempDir);
    });

    describe('чтение опции', () => {
        it('отдаёт значение, идущее за флагом', () => {
            expect(readOption(['--pr', 'arcanum-42', '--ui', 'dist'], '--pr')).toBe('arcanum-42');
            expect(readOption(['--pr', 'arcanum-42', '--ui', 'dist'], '--ui')).toBe('dist');
        });

        it('флаг последним аргументом — значения нет', () => {
            expect(readOption(['--pr'], '--pr')).toBeNull();
            expect(readOption(['--ui', 'dist', '--pr'], '--pr')).toBeNull();
        });

        it('флага нет вовсе — null', () => {
            expect(readOption([], '--pr')).toBeNull();
            expect(readOption(['--ui', 'dist'], '--pr')).toBeNull();
        });

        it('из повторов берёт первый', () => {
            expect(readOption(['--pr', 'первый', '--pr', 'второй'], '--pr')).toBe('первый');
        });
    });

    describe('ссылка UI', () => {
        it('ставит IPv6-адрес в квадратные скобки', () => {
            expect(formatUiUrl(4317, 'токен', '::1')).toBe('UI: http://[::1]:4317/#t=токен');
        });
    });

    describe('каталог UI', () => {
        it('несуществующий --ui — ошибка с абсолютным путём и подсказкой сборки', async () => {
            const missing = path.join(tempDir, 'нет-такого');

            await expect(resolveUiDir(missing)).rejects.toThrow(UI_BUILD_HINT);
            await expect(resolveUiDir(missing)).rejects.toThrow(missing);
        });

        it('в ошибке абсолютный путь, а не то, что напечатали в командной строке', async () => {
            // Относительное имя рядом с cwd: каталога нет, а абсолютная форма в него не входит.
            const relative = 'нет-такого-каталога-ui';
            const absolute = path.resolve(relative);
            expect(await isDirectory(absolute)).toBe(false);

            await expect(resolveUiDir(relative)).rejects.toThrow(absolute);
        });

        it('относительный --ui резолвится от текущего каталога', async () => {
            const uiDir = path.join(tempDir, 'dist');
            await fs.mkdir(uiDir);
            const relative = path.relative(process.cwd(), uiDir);

            expect(path.isAbsolute(relative)).toBe(false);
            await expect(resolveUiDir(relative)).resolves.toBe(uiDir);
        });

        it('существующий --ui отдаётся как есть', async () => {
            const uiDir = path.join(tempDir, 'ui-dist');
            await fs.mkdir(uiDir);

            await expect(resolveUiDir(uiDir)).resolves.toBe(uiDir);
        });
    });

    describe('проверка каталога', () => {
        it('каталог — да, файл и отсутствующий путь — нет', async () => {
            const dir = path.join(tempDir, 'каталог');
            const file = path.join(tempDir, 'файл.txt');
            await fs.mkdir(dir);
            await fs.writeFile(file, 'не каталог');

            await expect(isDirectory(dir)).resolves.toBe(true);
            await expect(isDirectory(file)).resolves.toBe(false);
            await expect(isDirectory(path.join(tempDir, 'нет-такого'))).resolves.toBe(false);
        });
    });

    describe('ссылка на UI', () => {
        it('кладёт токен во фрагмент — на сервер он не уходит', () => {
            expect(formatUiUrl(41234, 'secret-token')).toBe('UI: http://127.0.0.1:41234/#t=secret-token');
        });
    });
});
