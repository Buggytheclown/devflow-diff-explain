import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitFixture } from './git-fixture.js';
import { gitAvailable, makeGitRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import type { LocalVcs } from './vcs.js';
import { commandRunnerIn } from './vcs.js';

/**
 * Бэкенд `git` на живом `git` во временном репозитории: команды и разбор их вывода.
 * Репозиторий готовится в изолированном окружении, а сам бэкенд зовётся как в продакшене —
 * с тем конфигом, который есть на машине.
 */

/** Каждый сценарий — с десяток запусков `git`: пятисекундного потолка по умолчанию мало. */
const TIMEOUT_MS = 30_000;

describe.skipIf(!gitAvailable)('бэкенд git', { timeout: TIMEOUT_MS }, () => {
    let repo: GitFixture;

    beforeEach(() => {
        repo = makeGitRepo();
    });

    afterEach(() => {
        repo.cleanup();
    });

    /** Бэкенд, разговаривающий с каталогом проекта (по умолчанию — корень репозитория). */
    function open(projectDir: string = repo.root): LocalVcs {
        return gitVcs(commandRunnerIn('git', projectDir));
    }

    /** Базовый коммит на `main` и ветка `feature` поверх него. */
    function seedBranch(): string {
        repo.write('src/a.ts', 'const a = 1;\n');
        repo.write('README.md', '# app\n');
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        return base;
    }

    it('корень, ветка, HEAD и логин чекаута', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const head = repo.commitAll('work');
        const vcs = open();

        expect(await vcs.root()).toBe(repo.root);
        const info = await vcs.info();
        expect(info).toEqual({ branch: 'feature', head, login: 'Sherpa Tester' });
    });

    // Ревью заведено на ветку: отсоединённая голова — отказ, а не ветка с именем HEAD.
    it('отсоединённая голова — понятный отказ', async () => {
        seedBranch();
        repo.git('checkout', '--detach');

        await expect(open().info()).rejects.toThrow('detached HEAD');
    });

    it('база по умолчанию — ветка, на которую смотрит origin/HEAD', async () => {
        seedBranch();
        // Пульта нет и сети не нужно: ссылки заводятся прямо в репозитории.
        repo.git('update-ref', 'refs/remotes/origin/main', 'main');
        repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

        expect(await open().defaultBaseRef()).toBe('origin/main');
    });

    it('без origin база по умолчанию — местная main, иначе master', async () => {
        seedBranch();
        expect(await open().defaultBaseRef()).toBe('main');

        repo.git('branch', '-m', 'main', 'master');
        expect(await open().defaultBaseRef()).toBe('master');
    });

    it('ни origin, ни main, ни master — отказ с просьбой назвать базу', async () => {
        seedBranch();
        repo.git('branch', '-m', 'main', 'develop');

        await expect(open().defaultBaseRef()).rejects.toThrow('pass `--base <ref>`');
    });

    it('merge-base и явная база разрешаются в коммиты', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const head = repo.commitAll('work');
        const vcs = open();

        expect(await vcs.mergeBase('main')).toBe(base);
        expect(await vcs.revParse('main')).toBe(base);
        expect(await vcs.revParse('HEAD')).toBe(head);
        await expect(vcs.revParse('no-such-ref')).rejects.toThrow('failed');
    });

    // База против рабочего дерева: закоммиченное после базы, staged и unstaged — одним патчем.
    it('дифф считает коммит после базы вместе с правками рабочего дерева', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        repo.commitAll('work');
        repo.write('src/a.ts', 'const a = 3;\n');
        const vcs = open();

        const patch = await vcs.diff(base);
        expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
        expect(patch).toContain('-const a = 1;');
        expect(patch).toContain('+const a = 3;');
        expect(await vcs.nameStatus(base)).toEqual([{ changeType: 'modify', path: 'src/a.ts', oldPath: null }]);
    });

    it('staged add, удаление и неотслеживаемый файл', async () => {
        const base = seedBranch();
        repo.write('src/fresh.ts', 'export const fresh = 1;\n');
        repo.git('add', 'src/fresh.ts');
        repo.remove('README.md');
        repo.write('notes.md', 'local only\n');
        const vcs = open();

        const status = await vcs.status(repo.root);
        expect(status.changed.map((entry) => entry.path).sort()).toEqual(['README.md', 'src/fresh.ts']);
        expect(status.untracked).toEqual(['notes.md']);
        expect((await vcs.nameStatus(base)).sort((left, right) => left.path.localeCompare(right.path))).toEqual([
            { changeType: 'delete', path: 'README.md', oldPath: null },
            { changeType: 'add', path: 'src/fresh.ts', oldPath: null },
        ]);
    });

    // Раскрытие каталогов и правила игнорирования остаются за git — своего обхода у снимка нет.
    it('игнорируемое через .gitignore в статус не попадает', async () => {
        seedBranch();
        repo.write('.gitignore', 'node_modules/\ndist/\n');
        repo.commitAll('ignore rules');
        repo.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
        repo.write('dist/app.js', 'console.log(1);\n');
        repo.write('src/new/deep.ts', 'export const deep = 1;\n');

        expect((await open().status(repo.root)).untracked).toEqual(['src/new/deep.ts']);
    });

    it('вложенный репозиторий среди неотслеживаемых отбрасывается', async () => {
        seedBranch();
        repo.write('vendor/lib/index.js', 'module.exports = 1;\n');
        repo.git('-C', 'vendor/lib', 'init');
        repo.write('src/new.ts', 'export const fresh = 1;\n');

        expect((await open().status(repo.root)).untracked).toEqual(['src/new.ts']);
    });

    it('пути с пробелом и не-ASCII едут как есть', async () => {
        const base = seedBranch();
        repo.write('docs/мои заметки.md', '# заметки\n');
        repo.git('add', '--', 'docs/мои заметки.md');
        const vcs = open();

        expect((await vcs.status(repo.root)).changed.map((entry) => entry.path)).toEqual([
            'docs/мои заметки.md',
        ]);
        expect(await vcs.nameStatus(base)).toEqual([
            { changeType: 'add', path: 'docs/мои заметки.md', oldPath: null },
        ]);
        expect(await vcs.diff(base)).toContain('diff --git a/docs/мои заметки.md b/docs/мои заметки.md');
    });

    // Конфиг машины — не наше дело, но разбор вывода он ломать не должен.
    it('пользовательские diff.noprefix и core.quotePath разбор не ломают', async () => {
        const base = seedBranch();
        repo.git('config', 'diff.noprefix', 'true');
        repo.git('config', 'core.quotePath', 'true');
        repo.write('src/файл.ts', 'export const value = 1;\n');
        repo.git('add', '--', 'src/файл.ts');
        const vcs = open();

        expect(await vcs.diff(base)).toContain('diff --git a/src/файл.ts b/src/файл.ts');
        expect(await vcs.nameStatus(base)).toEqual([
            { changeType: 'add', path: 'src/файл.ts', oldPath: null },
        ]);
        expect((await vcs.status(repo.root)).changed.map((entry) => entry.path)).toEqual(['src/файл.ts']);
    });

    it('каталог проекта — подкаталог репозитория', async () => {
        repo.write('app/src/a.ts', 'const a = 1;\n');
        repo.write('other/b.ts', 'const b = 1;\n');
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('app/src/a.ts', 'const a = 2;\n');
        repo.write('other/b.ts', 'const b = 2;\n');
        repo.write('app/notes.md', 'local\n');
        const projectDir = path.join(repo.root, 'app');
        const vcs = open(projectDir);

        // Пути статуса — от корня репозитория, состав — только каталог проекта.
        const status = await vcs.status(projectDir);
        expect(status.changed.map((entry) => entry.path)).toEqual(['app/src/a.ts']);
        expect(status.untracked).toEqual(['app/notes.md']);
        // Пути диффа — от каталога проекта.
        expect(await vcs.nameStatus(base)).toEqual([{ changeType: 'modify', path: 'src/a.ts', oldPath: null }]);
        expect(await vcs.diff(base)).toContain('diff --git a/src/a.ts b/src/a.ts');
    });

    it('show отдаёт старую сторону, а отказ — ошибку, а не пустоту', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const vcs = open();

        expect((await vcs.show(base, 'src/a.ts')).toString('utf8')).toBe('const a = 1;\n');
        await expect(vcs.show(base, 'src/gone.ts')).rejects.toThrow('failed');
    });

    it('двоичный файл едет блобом байт в байт', async () => {
        const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01]);
        repo.write('assets/logo.png', image);
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('assets/logo.png', Buffer.concat([image, Buffer.from([0x02])]));
        const vcs = open();

        expect(await vcs.show(base, 'assets/logo.png')).toEqual(image);
        expect(await vcs.diff(base)).toContain('Binary files a/assets/logo.png and b/assets/logo.png differ');
        expect(fs.existsSync(path.join(repo.root, 'assets/logo.png'))).toBe(true);
    });
});
