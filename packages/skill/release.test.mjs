import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const releaseScript = join(repoRoot, 'scripts', 'release.mjs');
const uiRoot = resolve(packageRoot, '../ui');

/** Ровно то, что раскладывает релиз: каталог скилла с составом `dist/`, README не копируется. */
const EXPECTED_FILES = ['skill/SKILL.md', 'skill/bin/devflow-diff-explain-server.mjs', 'skill/bin/devflow-diff-explain.mjs', 'skill/version.json'];

const NOTES = 'Тестовая заметка релиза';

/**
 * Команда релиза раскладывает дистрибутив во временный каталог. Пересборку здесь не гоняем
 * (`--skip-build`): состав `dist/` проверяет `build.test.mjs`, а этому набору важна раскладка.
 */
describe('команда релиза', () => {
    let target;
    /** Текст подложенного README или `null`, если README в репозитории свой. */
    let temporaryReadme = null;

    beforeAll(() => {
        // Релиз сверяет корневой README с номером версии; набору важна раскладка, а не текст README,
        // поэтому в чекауте без него подкладываем свой и убираем за собой.
        temporaryReadme = ensureRootReadme();
        // Тот же порядок, что в цепочке сборки: сервер-бандл зашивает готовый `ui/dist`.
        if (!existsSync(join(uiRoot, 'dist', 'index.html'))) {
            execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
        }
        // Дистрибутив пересобираем всегда: порядок файлов набора не гарантирован, а раскладку
        // надо сверять со свежим `dist/`, а не с тем, что осталось от прошлого запуска.
        execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
        target = mkdtempSync(join(tmpdir(), 'sherpa-release-'));
    }, 180_000);

    afterAll(() => {
        rmSync(target, { recursive: true, force: true });
        // Файл мог за это время появиться в репозитории по-настоящему — чужой текст не трогаем.
        const readme = join(repoRoot, 'README.md');
        if (temporaryReadme !== null && existsSync(readme) && readFileSync(readme, 'utf8') === temporaryReadme) {
            rmSync(readme, { force: true });
        }
    });

    it('раскладывает каталог скилла, исполняемая в bin только команда', () => {
        const stdout = release(target);

        expect(listFiles(target)).toEqual(EXPECTED_FILES);
        expect(statSync(join(target, 'skill', 'bin', 'devflow-diff-explain.mjs')).mode & 0o111).toBe(0o111);
        // Модуль сервера грузит CLI в `devflow-diff-explain server`, напрямую его не запускают.
        expect(statSync(join(target, 'skill', 'bin', 'devflow-diff-explain-server.mjs')).mode & 0o111).toBe(0);
        // Публикацию делает человек — скрипт только печатает готовые команды.
        // README и package.json уже под arc'ом, добавлять надо только пересозданный каталог.
        expect(stdout).toContain(`cd ${target}`);
        expect(stdout).toContain('arc add skill\n');
        expect(stdout).toContain('arc commit -m');
    });

    it('повторный запуск обновляет каталог и убирает протухшее', () => {
        release(target);
        writeFileSync(join(target, 'skill', 'bin', 'stale.mjs'), '// хвост прошлого релиза\n');

        release(target);

        expect(listFiles(target)).toEqual(EXPECTED_FILES);
    });

    it('идентификатор сборки повторяет состояние рабочего дерева', () => {
        const stdout = release(target);

        // Дистрибутив собирается из рабочего дерева: незакоммиченные правки обязаны быть видны
        // и в отчёте, и в готовом сообщении коммита — иначе арк-лог сошлётся на чужой код.
        const head = git(['rev-parse', 'HEAD']);
        if (head === null) {
            expect(stdout).toContain('Исходники сборки: неизвестны');
            expect(stdout).not.toContain('(сборка ');
        } else {
            const expected = git(['status', '--short', '--', '.']) === '' ? head : `${head}-dirty`;
            expect(stdout).toContain(`Исходники сборки: ${expected}`);
            expect(stdout).toContain(`(сборка ${expected})`);
        }
    });

    /** Дату релиза и «что нового» знает только релиз: в артефакте сборки этих полей нет. */
    it('дописывает в version.json дату релиза и заметку из --notes', () => {
        release(target);

        const released = JSON.parse(readFileSync(join(target, 'skill', 'version.json'), 'utf8'));
        const built = JSON.parse(readFileSync(join(packageRoot, 'dist', 'version.json'), 'utf8'));

        expect(released.version).toBe(built.version);
        expect(released.builtFrom).toBe(built.builtFrom);
        expect(released.whatsNew).toBe(NOTES);
        expect(new Date(released.releasedAt).toISOString()).toBe(released.releasedAt);
        // `dist/` — артефакт сборки: релиз в него не пишет.
        expect(built.releasedAt).toBeNull();
        expect(built.whatsNew).toBeNull();
    });

    /** Цель по умолчанию — корень репозитория: `skill/` живёт рядом с исходниками. */
    it('без --target печатает корень репозитория', () => {
        const stdout = execFileSync(process.execPath, [releaseScript, '--help'], { cwd: repoRoot, encoding: 'utf8' });

        expect(stdout).toContain('по умолчанию корень репозитория');
    });

    it('на неизвестный аргумент падает до раскладки', () => {
        expectFails(['--skip-build', '--nonsense'], 'неизвестный аргумент');
    });

    it('без --notes падает до раскладки: тосту обновления нечего показать', () => {
        expectFails(['--skip-build'], '--notes');
    });

    it('заметка длиннее лимита падает до раскладки', () => {
        expectFails(['--skip-build', '--notes', 'я'.repeat(141)], 'тост вмещает');
    });
});

/** Запуск, который обязан упасть до раскладки: целевой каталог остаётся пустым. */
function expectFails(args, expectedError) {
    const untouched = mkdtempSync(join(tmpdir(), 'sherpa-release-bad-'));
    try {
        const result = runRelease(['--target', untouched, ...args]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expectedError);
        expect(listFiles(untouched)).toEqual([]);
    } finally {
        rmSync(untouched, { recursive: true, force: true });
    }
}

/** Успешный релиз в каталог; чужой код возврата — сразу поломка теста с текстом скрипта. */
function release(dir, notes = NOTES) {
    const result = runRelease(['--target', dir, '--skip-build', '--notes', notes]);
    if (result.status !== 0) {
        throw new Error(`release.mjs завершился с кодом ${String(result.status)}:\n${result.stderr}`);
    }
    return result.stdout;
}

/** Корневой README как README дистрибутива; возвращает текст подложенного файла или `null`. */
function ensureRootReadme() {
    const file = join(repoRoot, 'README.md');
    if (existsSync(file)) {
        return null;
    }
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
    const content = `# Шерпа\n\nВерсия ${version}\n`;
    writeFileSync(file, content);
    return content;
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        // В копии исходников вне Аркадии сборка честно пишет builtFrom: null.
        return null;
    }
}

function runRelease(args) {
    return spawnSync(process.execPath, [releaseScript, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

function listFiles(dir) {
    return walk(dir)
        .map((file) => relative(dir, file).split(sep).join('/'))
        .sort();
}

function walk(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...walk(full));
        } else {
            files.push(full);
        }
    }
    return files;
}
