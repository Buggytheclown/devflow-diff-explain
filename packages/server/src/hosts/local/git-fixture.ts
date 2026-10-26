import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Временный git-репозиторий для тестов бэкенда: живой `git` во временном каталоге, никогда
 * внутри чекаута arc. Подготовка идёт в изолированном окружении и с явными конфигами, чтобы
 * настройки машины не решали, что получится; сам бэкенд зовётся как в продакшене — без них.
 */

/** Окружение подготовки: пользовательский и системный конфиги в него не попадают. */
const SETUP_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Конфиги подготовки: без них `git` на чужой машине откажется коммитить или назовёт ветку иначе. */
const SETUP_CONFIG = [
    '-c',
    'user.name=Sherpa Tester',
    '-c',
    'user.email=sherpa@example.com',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'init.defaultBranch=main',
] as const;

/** Есть ли `git` на машине: без него git-тесты пропускаются целиком. */
export const gitAvailable = ((): boolean => {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

export class GitFixture {
    /** Корень репозитория, приведённый через realpath: на macOS `/var` — симлинк. */
    readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    /** Команда подготовки; её вывод возвращается текстом, отказ роняет тест. */
    git(...args: readonly string[]): string {
        // stderr перехвачен: `git` пишет туда и обычные сообщения вроде «Switched to a new branch».
        return execFileSync('git', [...SETUP_CONFIG, ...args], {
            cwd: this.root,
            env: SETUP_ENV,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    write(rootPath: string, content: string | Buffer): void {
        const absolute = path.join(this.root, rootPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }

    remove(rootPath: string): void {
        fs.rmSync(path.join(this.root, rootPath), { force: true });
    }

    /** Всё рабочее дерево в индекс и коммит; возвращает sha. */
    commitAll(message: string): string {
        this.git('add', '-A');
        this.git('commit', '-m', message);
        return this.git('rev-parse', 'HEAD').trim();
    }

    cleanup(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

/** Пустой репозиторий во временном каталоге системы. */
export function makeGitRepo(prefix = 'sherpa-git-'): GitFixture {
    const root = tempRoot(prefix);
    const fixture = new GitFixture(root);
    fixture.git('init');
    // Имя автора — в конфиге репозитория: его читает и бэкенд, логин не зависит от машины.
    fixture.git('config', 'user.name', 'Sherpa Tester');
    return fixture;
}

/**
 * Копия готового репозитория вместе с историей. Один запуск `git` стоит около ста миллисекунд,
 * поэтому набору, которому нужно одно и то же дерево на каждый тест, дешевле копировать каталог,
 * чем заводить репозиторий заново.
 */
export function copyGitRepo(template: GitFixture, prefix = 'sherpa-git-'): GitFixture {
    const root = tempRoot(prefix);
    fs.cpSync(template.root, root, { recursive: true });
    return new GitFixture(root);
}

function tempRoot(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
