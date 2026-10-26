import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
const distDir = resolve(root, 'dist');
const binDir = resolve(distDir, 'bin');

const DIRTY_SUFFIX = '-dirty';

/**
 * `dist/` — дистрибутив скилла: SKILL.md рядом с `bin/` из двух файлов. Именно `dist`
 * копируется в харнес (`~/.claude/skills/devflow-diff-explain`), чтобы туда не утекали исходники пакета.
 * Команда одна — исполняемый `devflow-diff-explain.mjs`; `devflow-diff-explain-server.mjs` — модуль сервера с зашитым UI,
 * который CLI грузит `import()` только в `devflow-diff-explain server`. Поэтому петля воркера, дёргающая CLI
 * на каждый вызов, сервер не грузит.
 *
 * Сборки дёргаются напрямую, без вложенного pnpm (их зовёт и тест). Пакеты записаны
 * в devDependencies скилла ради топологического порядка `pnpm -r`: иначе эти сборки и сборки
 * в тестах самих пакетов пишут одни и те же файлы в dist параллельно.
 */
const bundles = [
    {
        pkg: '../server',
        script: 'build-server.mjs',
        file: 'dist/devflow-diff-explain-server.mjs',
        out: 'devflow-diff-explain-server.mjs',
        mode: 0o644,
    },
    { pkg: '../cli', script: 'build.mjs', file: 'dist/devflow-diff-explain.mjs', out: 'devflow-diff-explain.mjs', mode: 0o755 },
];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
copyFileSync(resolve(root, 'SKILL.md'), resolve(distDir, 'SKILL.md'));

for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    // Права ставятся явно: копия наследует их от файла сборки, а тот — от прошлых сборок.
    chmodSync(outfile, bundle.mode);
    process.stdout.write(`@sherpa/skill: ${outfile}\n`);
}

writeVersionFile();

/**
 * `dist/version.json` по `distributionVersionSchema`: сервер сравнит
 * этот файл из trunk с зашитой версией. Поля релиза (`releasedAt`, `whatsNew`) заполняет
 * `scripts/release.mjs` уже в целевом каталоге — в артефакте сборки их ещё нет.
 */
function writeVersionFile() {
    const version = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
    const file = resolve(distDir, 'version.json');

    writeFileSync(
        file,
        `${JSON.stringify({ version, builtFrom: buildRevision(), releasedAt: null, whatsNew: null }, null, 4)}\n`,
    );
    process.stdout.write(`@sherpa/skill: ${file}\n`);
}

/**
 * Идентификатор исходников сборки: хеш HEAD плюс `-dirty`, если в рабочем дереве есть
 * незакоммиченные или неотслеживаемые правки. Дистрибутив собирается из рабочего дерева, а не
 * из HEAD, и без пометки хеш указывал бы на код, из которого бандл не собирался.
 * Хеш полный: короткий в Аркадии неоднозначен. Статус смотрится только внутри корня Шерпы:
 * в монорепозитории чужие правки по соседству к сборке отношения не имеют.
 */
function buildRevision() {
    const head = arc(['rev-parse', 'HEAD']);
    if (head === null) {
        return null;
    }
    // Состояние дерева выяснить не вышло — честнее пометить сборку, чем обещать чистый хеш.
    const status = arc(['status', '--short', '--', '.']);
    return status === '' ? head : `${head}${DIRTY_SUFFIX}`;
}

function arc(args) {
    try {
        return execFileSync('arc', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}
