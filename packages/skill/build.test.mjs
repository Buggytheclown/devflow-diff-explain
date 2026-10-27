import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distDir = join(packageRoot, 'dist');
const binDir = join(distDir, 'bin');
const cliPath = join(binDir, 'devflow-diff-explain.mjs');
const serverPath = join(binDir, 'devflow-diff-explain-server.mjs');
const uiRoot = resolve(packageRoot, '../ui');
/** Версия поставки — из корневого package.json: единственный источник на все три бандла. */
const releaseVersion = JSON.parse(readFileSync(join(packageRoot, '../../package.json'), 'utf8')).version;

// Сборка на весь файл: оба набора проверяют свежий `dist/`, даже когда запущен только один из них.
beforeAll(() => {
    // Сборка UI в цепочку не входит (модуль сервера зашивает готовый `ui/dist`), но `dist`
    // не хранится в git — на чистом чекауте собираем его здесь, иначе модулю нечего зашивать.
    if (!existsSync(join(uiRoot, 'dist', 'index.html'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}, 120_000);

describe('сборка пакета скилла', () => {
    // Именно `dist/` линкуется в харнес: лишний файл в нём — мусор в установленном скилле.
    it('dist/ — самодостаточный дистрибутив: SKILL.md, команда и модуль сервера в bin/', () => {
        expect(readdirSync(distDir).sort()).toEqual(['SKILL.md', 'bin', 'version.json']);
        expect(readdirSync(binDir).sort()).toEqual(['devflow-diff-explain-server.mjs', 'devflow-diff-explain.mjs']);
        expect(statSync(cliPath).isFile()).toBe(true);
        expect(statSync(serverPath).isFile()).toBe(true);
        // Команда одна: модуль сервера не запускается напрямую, его грузит CLI.
        expect(statSync(cliPath).mode & 0o111).toBe(0o111);
        expect(statSync(serverPath).mode & 0o111).toBe(0);
        expect(readFileSync(join(distDir, 'SKILL.md'), 'utf8')).toBe(
            readFileSync(join(packageRoot, 'SKILL.md'), 'utf8'),
        );
    });

    /**
     * По этому файлу сервер решает, вышла ли новая версия. Поля релиза сборке неизвестны —
     * в локальной поставке они остаются пустыми: обновление выполняет install:local.
     */
    it('version.json несёт версию поставки и состояние рабочего дерева', () => {
        const distVersion = JSON.parse(readFileSync(join(distDir, 'version.json'), 'utf8'));

        const head = git(['rev-parse', 'HEAD']);
        expect(distVersion).toEqual({
            version: releaseVersion,
            builtFrom: head === null ? null : git(['status', '--short', '--', '.']) === '' ? head : `${head}-dirty`,
            releasedAt: null,
            whatsNew: null,
        });
    });

    it('собранный CLI запускается голым node', () => {
        const stdout = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });

        expect(stdout.trim()).toBe(releaseVersion);
    });

    // Петля воркера дёргает CLI на каждый вызов: сервер и UI утяжелили бы каждый её шаг.
    it('сервер и UI живут в модуле сервера, а не в CLI', () => {
        expect(statSync(cliPath).size).toBeLessThan(statSync(serverPath).size);
        expect(readFileSync(cliPath, 'utf8')).not.toContain('node:sqlite');
        expect(readFileSync(serverPath, 'utf8')).toContain('node:sqlite');
    });

    it('SKILL.md описывает запуск и петлю воркера', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: devflow-diff-explain\n/u);
        expect(skill).toContain('bin/devflow-diff-explain.mjs up --pr');
        expect(skill).toContain('bin/devflow-diff-explain.mjs worker next --pr');
        expect(skill).toContain('--model');
        expect(skill).toContain('DONE');
        // Правило общего контекста задач: путь под `shared/` читается один раз за сессию.
        expect(skill).toContain('`shared/`');
        expect(skill).toContain('once per session');
        // Файл результата выдаёт задача: свой путь в общем tmp делили бы сессии на одной машине.
        expect(skill).toContain('only to the file path the task gives you');
    });

    /**
     * Петля из SKILL.md опознаёт ситуации по дословным фразам вывода: «stop the loop» — конец петли,
     * DONE — конец работы. Разъедься формулировки — модель молча перестанет узнавать эти ситуации,
     * поэтому пакт проверяется сборкой.
     */
    it('фразы-маркеры петли из SKILL.md дословно встречаются в выводе CLI и сервера', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');
        const cli = readFileSync(cliPath, 'utf8');
        const server = readFileSync(serverPath, 'utf8');

        // Кавычки в теле SKILL.md стоят ровно вокруг фраз, которые модель ищет в выводе;
        // фронтматтер не в счёт — там кавычки нужны YAML-валидатору, code span тоже — там они часть кода.
        const body = skill.replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/`[^`\n]*`/gu, '');
        const markers = [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
        expect(markers).toEqual(expect.arrayContaining(['stop the loop']));

        for (const marker of [...markers, 'DONE']) {
            expect(`${cli}\n${server}`, marker).toContain(marker);
        }
    });

    // Бутстрап спрятан в `devflow-diff-explain up`: если про сервер или регистрацию снова написали в SKILL.md,
    // модель опять знает лишнее — и разойдётся с CLI при первой же смене запуска.
    it('SKILL.md не рассказывает модели про сервер и регистрацию', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).not.toContain('@sherpa/server');
        expect(skill).not.toContain('worker register');
    });
});

/**
 * Дистрибутив как его видит пользователь: копия `dist/` в чужом каталоге, голый node, свой стейт.
 * Фикстурный ключ — живой Арканум в тестах запрещён (docs/testing.md).
 */
describe('собранный дистрибутив в работе', () => {
    const PR_KEY = 'fixture-medium';
    let workDir;
    let skillDir;
    let sherpaDir;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'sherpa-skill-'));
        skillDir = join(workDir, 'skill');
        sherpaDir = join(workDir, 'state');
        cpSync(distDir, skillDir, { recursive: true });
    });

    afterEach(async () => {
        const manifest = readManifest();
        if (manifest !== null) {
            await stopProcess(manifest.pid);
        }
        rmSync(workDir, { recursive: true, force: true });
    });

    function sherpa(args, extraEnv = {}) {
        // Окружение запуска тестов не должно подменять поиск сервера или ключ PR.
        const { SHERPA_SERVER_BIN: _bin, SHERPA_PR: _pr, SHERPA_WORKER_ID: _worker, ...inherited } = process.env;
        const env = { ...inherited, SHERPA_DIR: sherpaDir, ...extraEnv };
        return spawnSync(process.execPath, [join(skillDir, 'bin', 'devflow-diff-explain.mjs'), ...args], {
            cwd: workDir,
            encoding: 'utf8',
            env,
            // `worker next` ждёт задачу без срока: тесту хватит того, что он дошёл до запроса.
            timeout: 20_000,
        });
    }

    function up() {
        return sherpa(['up', '--pr', PR_KEY, '--no-open', '--harness', 'test']);
    }

    function readManifest() {
        const file = join(sherpaDir, 'servers', `${PR_KEY}.json`);
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    }

    it('up холодный поднимает сервер, тёплый переиспользует тот же', () => {
        const cold = up();
        expect(cold.status, cold.stderr).toBe(0);
        const first = readManifest();
        expect(first).not.toBeNull();
        expect(cold.stdout).toContain(`http://127.0.0.1:${String(first.port)}/#t=`);

        // Демон — этот же CLI командой `devflow-diff-explain server`, с флагами Node из корня CLI (`src/index.ts`):
        // без `--use-system-ca` сервер не доверяет внутреннему CA, которым подписаны хосты.
        const daemon = execFileSync('ps', ['-o', 'args=', '-p', String(first.pid)], { encoding: 'utf8' });
        expect(daemon).toContain(`bin/devflow-diff-explain.mjs server --pr ${PR_KEY}`);
        if (process.allowedNodeEnvironmentFlags.has('--use-system-ca')) {
            expect(daemon).toContain('--use-system-ca');
        }

        const warm = up();
        expect(warm.status, warm.stderr).toBe(0);
        const second = readManifest();
        expect({ port: second.port, pid: second.pid }).toEqual({ port: first.port, pid: first.pid });
        expect(warm.stdout).toContain(`http://127.0.0.1:${String(first.port)}/#t=`);
    }, 60_000);

    // Петля воркера дёргает CLI на каждый вызов — модуль сервера в ней грузиться не должен.
    it('worker next не грузит модуль сервера, а server грузит', () => {
        const marker = join(workDir, 'server-loaded');
        const probe = join(workDir, 'probe-server.mjs');
        writeFileSync(
            probe,
            `import { writeFileSync } from 'node:fs';\n` +
                `writeFileSync(${JSON.stringify(marker)}, 'loaded');\n` +
                'export async function runServer() { return 0; }\n',
        );

        // Сервер живой, воркер зарегистрирован: `next` проходит весь путь до ответа, а не падает на поиске манифеста.
        expect(up().status).toBe(0);
        const next = sherpa(['worker', 'next', '--pr', PR_KEY], { SHERPA_SERVER_BIN: probe });
        expect(next.status, next.stderr).toBe(0);
        expect(next.stdout).toContain('TASK');
        expect(existsSync(marker)).toBe(false);

        // Проба рабочая: `devflow-diff-explain server` её грузит.
        const server = sherpa(['server', '--pr', PR_KEY], { SHERPA_SERVER_BIN: probe });
        expect(server.status, server.stderr).toBe(0);
        expect(existsSync(marker)).toBe(true);
    }, 60_000);
});

/** Снимает демона по PID: SIGTERM и ожидание, чтобы сервер не пережил тест. */
async function stopProcess(pid) {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await delay(50);
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // Уже снят.
    }
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: resolve(packageRoot, '../..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        // В копии исходников вне Аркадии сборка честно пишет builtFrom: null.
        return null;
    }
}
