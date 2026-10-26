#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Команда релиза дистрибутива Шерпы: собрать → сверить версию → разложить `<target>/skill/`
 * с содержимым `packages/skill/dist` → проставить дату релиза и «что нового»
 * в `<target>/skill/version.json` → напечатать готовые команды `arc`.
 * Сам `arc` не зовётся: коммит в Аркадию человек делает руками.
 *
 * Цель по умолчанию — корень самого репозитория: дистрибутив лежит рядом с исходниками
 * и уезжает в Аркадию тем же коммитом. `--target` нужен для прогонов в отдельный каталог.
 * README дистрибутива — корневой `README.md` репозитория; релиз его не копирует, только
 * сверяет, что в нём назван номер версии.
 *
 * Повторный запуск — обновление: `<target>/skill` пересоздаётся, протухшим файлам не выжить.
 *
 * Чистый node без зависимостей: скрипт живёт вне пакетов и запускается на голом рантайме.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoRoot, 'packages/skill/dist');
const versionFile = join(distDir, 'version.json');
const readmeFile = join(repoRoot, 'README.md');
const DEFAULT_TARGET = repoRoot;
const DIRTY_SUFFIX = '-dirty';
/** Дубль `DISTRIBUTION_WHATS_NEW_MAX_CHARS` из `packages/protocol/src/distribution.ts`. */
const WHATS_NEW_MAX_CHARS = 140;

const USAGE = [
    'Использование: node scripts/release.mjs --notes "<одна фраза>" [--target <каталог>] [--skip-build]',
    '',
    `  --notes "<фраза>"   «что нового» для тоста обновления, до ${WHATS_NEW_MAX_CHARS} символов (обязателен)`,
    '  --target <каталог>  куда разложить каталог skill/ (по умолчанию корень репозитория)',
    '  --skip-build        не пересобирать, взять готовый packages/skill/dist',
].join('\n');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
}

const version = releaseVersion();

if (options.skipBuild) {
    log('сборка пропущена (--skip-build)');
} else {
    buildDistribution();
}

verifyDist(version);
const files = layout(options.target);
stampRelease(options.target, options.notes);
report(version, options.target, files);

/** Разбор аргументов: неизвестный флаг — ошибка, а не молчаливое умолчание. */
function parseArgs(argv) {
    const parsed = { target: DEFAULT_TARGET, skipBuild: false, help: false, notes: null };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else if (arg === '--skip-build') {
            parsed.skipBuild = true;
        } else if (arg === '--target') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                fail(`флагу --target нужен путь.\n${USAGE}`);
            }
            parsed.target = resolve(value);
            i += 1;
        } else if (arg === '--notes') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                fail(`флагу --notes нужна фраза.\n${USAGE}`);
            }
            parsed.notes = value.trim();
            i += 1;
        } else {
            fail(`неизвестный аргумент \`${arg}\`.\n${USAGE}`);
        }
    }

    if (parsed.help) {
        return parsed;
    }

    // Тост обновления показывает эту фразу пользователю: пустой релиз без «что нового» не выпускаем.
    if (parsed.notes === null) {
        fail(`нужен флаг --notes с одной фразой «что нового» — её покажет тост обновления.\n${USAGE}`);
    }
    if (parsed.notes === '') {
        fail('фраза --notes пустая — напишите, что изменилось для ревьюера.');
    }
    if (parsed.notes.length > WHATS_NEW_MAX_CHARS) {
        fail(`фраза --notes длиной ${String(parsed.notes.length)} символов, а тост вмещает ${WHATS_NEW_MAX_CHARS}.`);
    }
    return parsed;
}

/** Версия поставки — поле `version` корневого package.json, единственный источник. */
function releaseVersion() {
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        fail(`в корневом package.json версия \`${String(version)}\`, а нужна X.Y.Z.`);
    }
    return version;
}

/**
 * Сборка UI обязана идти первой: модуль сервера зашивает `packages/ui/dist` внутрь себя
 * и без него падает.
 */
function buildDistribution() {
    for (const filter of ['@sherpa/ui', '@sherpa/skill']) {
        log(`сборка ${filter}`);
        run('pnpm', ['--filter', filter, 'build']);
    }
}

/** Версия в собранном CLI обязана совпасть с источником — иначе поехала цепочка сборки. */
function verifyDist(version) {
    const cliPath = join(distDir, 'bin', 'devflow-diff-explain.mjs');
    if (!existsSync(cliPath)) {
        fail(
            `нет собранного дистрибутива (${cliPath}). ` +
                'Запустите без --skip-build или соберите вручную: ' +
                '`pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/skill build`.',
        );
    }

    const printed = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' }).trim();
    if (printed !== version) {
        fail(`\`devflow-diff-explain --version\` печатает ${printed}, а в корневом package.json ${version}.`);
    }

    // README называет версию словами — забытая правка выдала бы читателю чужой номер.
    // Проверяем корневой README репозитория: он же README дистрибутива, куда бы ни лёг `--target`.
    if (!existsSync(readmeFile)) {
        fail(`нет ${readmeFile} — README репозитория и есть README дистрибутива, без него релиз не выпускаем.`);
    }
    if (!readFileSync(readmeFile, 'utf8').includes(version)) {
        fail(`в ${relative(repoRoot, readmeFile)} не упомянута версия ${version} — обновите раздел «Версия».`);
    }

    // По этому файлу сервер решает, вышла ли новая версия: кривой или отставший — молчаливо сломанная проверка.
    const distVersion = readDistVersion();
    if (distVersion.version !== version) {
        fail(`в ${relative(repoRoot, versionFile)} версия ${String(distVersion.version)}, а в package.json ${version}.`);
    }
    if (typeof distVersion.builtFrom !== 'string' && distVersion.builtFrom !== null) {
        fail(`в ${relative(repoRoot, versionFile)} поле builtFrom не строка и не null — пересоберите дистрибутив.`);
    }
    log(`версия дистрибутива ${version}`);
}

/** `dist/version.json` от сборки; разбор с понятным текстом — файл читают и скрипт, и сервер. */
function readDistVersion() {
    if (!existsSync(versionFile)) {
        fail(`нет ${relative(repoRoot, versionFile)} — пересоберите дистрибутив без --skip-build.`);
    }
    try {
        return JSON.parse(readFileSync(versionFile, 'utf8'));
    } catch (error) {
        fail(`${relative(repoRoot, versionFile)} не разбирается как JSON: ${messageOf(error)}`);
    }
}

/**
 * Поля релиза в выложенном `version.json`: сборка их не знает, а сервер по ним показывает тост.
 * `dist/version.json` остаётся артефактом сборки и не трогается.
 */
function stampRelease(target, notes) {
    const file = join(target, 'skill', 'version.json');
    const content = { ...readDistVersion(), releasedAt: new Date().toISOString(), whatsNew: notes };

    writeFileSync(file, `${JSON.stringify(content, null, 4)}\n`);
}

/** Раскладка в целевом каталоге; возвращает пути файлов относительно него. */
function layout(target) {
    const skillDir = join(target, 'skill');

    mkdirSync(target, { recursive: true });

    // Каталог скилла пересоздаётся целиком: файл, выпавший из дистрибутива, не должен пережить релиз.
    rmSync(skillDir, { recursive: true, force: true });
    cpSync(distDir, skillDir, { recursive: true });

    // Исполняемая в дистрибутиве только команда; модуль сервера CLI грузит `import()`.
    const binDir = join(skillDir, 'bin');
    for (const name of readdirSync(binDir)) {
        chmodSync(join(binDir, name), name === 'devflow-diff-explain.mjs' ? 0o755 : 0o644);
    }

    // Перечисляем только выложенное — ровно то, что уйдёт в `arc add skill` ниже.
    return walk(skillDir)
        .map((file) => relative(target, file).split(sep).join('/'))
        .sort();
}

function report(version, target, files) {
    // Идентификатор сборки пишет `build.mjs` — второй раз спрашивать git незачем.
    const revision = readDistVersion().builtFrom;
    const message = `junk/alice/devflow-diff-explain: Шерпа ${version}${revision === null ? '' : ` (сборка ${revision})`}`;

    process.stdout.write(
        [
            '',
            `Шерпа ${version} разложена в ${target}`,
            `Исходники сборки: ${revision ?? 'неизвестны'}`,
            ...(revision !== null && revision.endsWith(DIRTY_SUFFIX)
                ? ['  в рабочем дереве есть незакоммиченные правки — по одному хешу сборку не повторить']
                : []),
            '',
            'Файлы:',
            ...files.map((file) => `  ${file}`),
            '',
            'Дальше — руками:',
            `  cd ${target}`,
            // `README.md` и `package.json` уже отслеживаются arc'ом, а в `skill/` после
            // пересоздания есть и новые, и исчезнувшие файлы — их и подхватываем.
            '  arc add skill',
            `  arc commit -m ${JSON.stringify(message)}`,
            '',
        ].join('\n'),
    );
}

function run(command, args) {
    try {
        execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
    } catch (error) {
        fail(`команда \`${command} ${args.join(' ')}\` завершилась с ошибкой: ${messageOf(error)}`);
    }
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

function log(text) {
    process.stdout.write(`devflow-diff-explain release: ${text}\n`);
}

function fail(text) {
    process.stderr.write(`devflow-diff-explain release: ${text}\n`);
    process.exit(1);
}

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
