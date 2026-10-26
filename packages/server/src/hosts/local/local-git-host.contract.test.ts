import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';

import type { GitFixture } from './git-fixture.js';
import { copyGitRepo, gitAvailable, makeGitRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';
import { commandRunnerIn } from './vcs.js';

/**
 * Контрактный набор `ReviewHost` на локальном хосте с бэкендом `git`: живой `git` во временном
 * репозитории. «Пуш» здесь — правка файла в рабочем дереве и принудительный опрос.
 */

const TOUCHED_FILE = 'src/service.ts';

/** Таймер опроса в тестах не нужен: снимок двигает только `refresh`. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

const repos: GitFixture[] = [];
const fixtures = new WeakMap<LocalHost, GitFixture>();

/** Рабочее дерево набора готовится один раз: каждому тесту достаётся его копия. */
let template: GitFixture | null = null;

afterAll(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
    template?.cleanup();
    template = null;
});

function makeHost(): LocalHost {
    template ??= seededTemplate();
    const repo = copyGitRepo(template, 'sherpa-git-contract-');
    repos.push(repo);

    const host = new LocalHost({
        prKey: 'local-git-app-0badc0de',
        vcs: gitVcs(commandRunnerIn('git', repo.root)),
        projectDir: repo.root,
        base: null,
        branch: 'feature',
        threads: memoryThreadsStore(),
        iterations: memoryIterationsStore(),
        pollIntervalMs: POLL_INTERVAL_MS,
    });
    fixtures.set(host, repo);
    return host;
}

/** Рабочее дерево со всеми видами файлов: правка, добавление, удаление, картинка, неотслеживаемые. */
function seededTemplate(): GitFixture {
    const repo = makeGitRepo('sherpa-git-template-');
    repo.write(TOUCHED_FILE, service(8080));
    repo.write('src/legacy.ts', 'export const legacy = true;\n');
    repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    repo.commitAll('base');
    repo.git('checkout', '-b', 'feature');

    repo.write(TOUCHED_FILE, service(9090));
    repo.remove('src/legacy.ts');
    repo.write('src/fresh.ts', 'export const fresh = 1;\n');
    repo.git('add', 'src/fresh.ts');
    repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
    repo.write('notes.md', '# notes\n\nlocal only\n');
    repo.write('cache.bin', Buffer.from([0x01, 0x00, 0x02]));
    // Базовая ветка названа через origin/HEAD: так база находится одной командой, без перебора.
    repo.git('update-ref', 'refs/remotes/origin/main', 'main');
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return repo;
}

function service(port: number): string {
    return `${['export function serve() {', `    const port = ${String(port)};`, '    listen(port);', '    log("up");', '}'].join('\n')}\n`;
}

describeReviewHostContract('LocalHost/git', makeHost, {
    // `user.name` из конфига временного репозитория (`git-fixture.ts`).
    viewer: 'Sherpa Tester',
    slow: true,
    skip: !gitAvailable,
    advance: async (host) => {
        const repo = fixtures.get(host);
        if (repo === undefined) {
            throw new Error('git-репозиторий для хоста не найден');
        }
        repo.write(TOUCHED_FILE, service(7070));
        await host.refresh();
    },
});
