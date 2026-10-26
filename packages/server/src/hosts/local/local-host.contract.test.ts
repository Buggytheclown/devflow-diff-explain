import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';

import { arcVcs } from './arc-vcs.js';
import { FakeArc } from './fake-arc.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';

/**
 * Контрактный набор `ReviewHost` на локальном хосте с бэкендом `arc`: подставной `arc` поверх
 * настоящего временного каталога. «Пуш» здесь — правка файла в рабочем дереве и принудительный
 * опрос. Тот же набор на настоящем `git` — `local-git-host.contract.test.ts`.
 */

const PROJECT_PREFIX = 'app';
const TOUCHED_FILE = 'src/service.ts';

/** Таймер опроса в тестах не нужен: снимок двигает только `refresh`. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

const checkouts: string[] = [];
const fakes = new WeakMap<LocalHost, FakeArc>();

afterAll(() => {
    for (const dir of checkouts.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeHost(verdicts: string | null = null): LocalHost {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-'));
    checkouts.push(root);

    const fake = new FakeArc({ root, prefix: PROJECT_PREFIX });
    seed(fake);

    const host = new LocalHost({
        prKey: 'local-arc-app-0badc0de',
        vcs: arcVcs(fake.runner),
        projectDir: fake.projectDir,
        base: null,
        branch: fake.branch,
        verdicts,
        threads: memoryThreadsStore(),
        iterations: memoryIterationsStore(),
        pollIntervalMs: POLL_INTERVAL_MS,
    });
    fakes.set(host, fake);
    return host;
}

/** Рабочее дерево со всеми видами файлов: правка, добавление, удаление, картинка, неотслеживаемые. */
function seed(fake: FakeArc): void {
    const base = ['export function serve() {', '    const port = 8080;', '    listen(port);', '    log("up");', '}'];
    fake.commit(`${PROJECT_PREFIX}/${TOUCHED_FILE}`, `${base.join('\n')}\n`);
    fake.writeDisk(
        `${PROJECT_PREFIX}/${TOUCHED_FILE}`,
        `${['export function serve() {', '    const port = 9090;', '    listen(port);', '    log("up");', '}'].join('\n')}\n`,
    );

    fake.commit(`${PROJECT_PREFIX}/src/legacy.ts`, 'export const legacy = true;\n');
    fake.removeDisk(`${PROJECT_PREFIX}/src/legacy.ts`);

    fake.added.add(`${PROJECT_PREFIX}/src/fresh.ts`);
    fake.writeDisk(`${PROJECT_PREFIX}/src/fresh.ts`, 'export const fresh = 1;\n');

    // Картинка: стороны читаются из базы и с диска, блобы адресуются содержимым.
    fake.commit(`${PROJECT_PREFIX}/assets/logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    fake.writeDisk(`${PROJECT_PREFIX}/assets/logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

    fake.writeDisk(`${PROJECT_PREFIX}/notes.md`, '# notes\n\nlocal only\n');
    fake.writeDisk(`${PROJECT_PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x02]));

    // Файл вне каталога проекта: в дифф он попасть не должен.
    fake.commit('other/outside.ts', 'export const outside = 1;\n');
    fake.writeDisk('other/outside.ts', 'export const outside = 2;\n');
}

/** «Пуш» локального хоста: правка файла в рабочем дереве и принудительный опрос. */
async function advance(host: LocalHost): Promise<void> {
    const fake = fakes.get(host);
    if (fake === undefined) {
        throw new Error('фейковый arc для хоста не найден');
    }
    fake.writeDisk(
        `${PROJECT_PREFIX}/${TOUCHED_FILE}`,
        `${['export function serve() {', '    const port = 7070;', '    listen(port);', '    log("up");', '}'].join('\n')}\n`,
    );
    await host.refresh();
}

/** Логин фейкового чекаута по умолчанию. */
const VIEWER = 'reviewer';

describeReviewHostContract('LocalHost/arc', () => makeHost(), { viewer: VIEWER, advance });

// Режим `--verdicts`: тот же контракт, но публикация — Request changes и Ship вместо Comment.
describeReviewHostContract('LocalHost/arc --verdicts', () => makeHost('on ship, commit and open a PR'), {
    viewer: VIEWER,
    advance,
});
