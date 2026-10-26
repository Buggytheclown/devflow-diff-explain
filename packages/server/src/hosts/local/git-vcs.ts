import os from 'node:os';

import type { CommandRunner, LocalVcs, NameStatusEntry, VcsStatus, VcsStatusEntry } from './vcs.js';
import { changeTypeOf, commandBytes, commandLine, commandText } from './vcs.js';

/**
 * Бэкенд `git` для локального ревью. Команды зовутся с явным переопределением конфигов,
 * которые ломают разбор: пользовательские `core.quotePath`, `diff.noprefix`, внешние diff
 * и textconv-фильтры меняют вывод, а снимок читает его как формат.
 */

/** Конфиги, которые обязаны быть нашими, а не пользовательскими. */
const CONFIG = ['-c', 'core.quotePath=false'] as const;

/** Флаги диффа: патч должен быть машинным и с привычными префиксами `a/` и `b/`. */
const DIFF_FLAGS = [
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
] as const;

/** Ветки, которые считаются базой, когда `origin/HEAD` не назван. */
const FALLBACK_BASE_BRANCHES = ['main', 'master'] as const;

export function gitVcs(run: CommandRunner): LocalVcs {
    const text = (args: readonly string[]): Promise<string> => commandText(run, 'git', [...CONFIG, ...args]);
    const line = (args: readonly string[]): Promise<string> => commandLine(run, 'git', [...CONFIG, ...args]);
    // Логин за жизнь сервера не меняется, а опрос дерева идёт каждые полминуты: спрашиваем однажды.
    let login: string | null = null;

    return {
        kind: 'git',

        root: async () => (await text(['rev-parse', '--show-toplevel'])).trim(),

        info: async () => {
            const branch = await line(['rev-parse', '--abbrev-ref', 'HEAD']);
            if (branch === 'HEAD') {
                throw new Error('detached HEAD: check out a branch');
            }
            login ??= await gitLogin(run);
            return { branch, head: await line(['rev-parse', 'HEAD']), login };
        },

        defaultBaseRef: () => defaultBaseRef(run),

        mergeBase: (ref) => line(['merge-base', ref, 'HEAD']),

        // `^{commit}` требует именно коммита: тег и дерево базой сравнения быть не могут.
        revParse: (ref) => line(['rev-parse', '--verify', `${ref}^{commit}`]),

        // `--untracked-files=all` раскрывает неотслеживаемые каталоги файлами и сам вырезает
        // игнорируемое (`.gitignore`); пути git печатает от корня репозитория, а не от cwd.
        // Единственный каталог, который остаётся каталогом, — вложенный репозиторий (см. разбор).
        status: async (projectDir) =>
            parseGitStatus(
                await text([
                    'status',
                    '--porcelain=v2',
                    '-z',
                    '--untracked-files=all',
                    '--no-renames',
                    '--',
                    projectDir,
                ]),
            ),

        // `--relative` без аргумента считается от рабочего каталога команды — каталога проекта.
        diff: (base) => text(['diff', ...DIFF_FLAGS, '--relative', base, '--', '.']),

        nameStatus: async (base) =>
            parseGitNameStatus(
                await text(['diff', ...DIFF_FLAGS, '--name-status', '-z', '--relative', base, '--', '.']),
            ),

        // `<rev>:<path>` у git считается от корня репозитория — ровно то, чем адресует снимок.
        show: (ref, rootPath) => commandBytes(run, 'git', [...CONFIG, 'cat-file', 'blob', `${ref}:${rootPath}`]),
    };
}

/**
 * Логин автора комментариев: имя из `user.name`, а нет его — пользователь системы.
 * Пустой логин схема не примет, а гадать по `user.email` незачем.
 */
async function gitLogin(run: CommandRunner): Promise<string> {
    const outcome = await run([...CONFIG, 'config', 'user.name']);
    const name = outcome.code === 0 ? outcome.stdout.toString('utf8').trim() : '';
    return name === '' ? os.userInfo().username : name;
}

/**
 * База по умолчанию: ветка, на которую смотрит `origin/HEAD`, иначе местная `main` или `master`.
 * Ни одной — отказ с просьбой назвать базу: гадать, от чего ответвлена ветка, Шерпа не берётся.
 */
async function defaultBaseRef(run: CommandRunner): Promise<string> {
    const origin = await run([...CONFIG, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    const named = origin.code === 0 ? origin.stdout.toString('utf8').trim() : '';
    if (named !== '') {
        return named;
    }

    for (const branch of FALLBACK_BASE_BRANCHES) {
        const local = await run([...CONFIG, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`]);
        if (local.code === 0) {
            return branch;
        }
    }
    throw new Error('cannot pick the base branch of this git repository; pass `--base <ref>`');
}

/**
 * Разбор `git status --porcelain=v2 -z`. Записи разделены NUL: `1`/`u` — изменённый файл,
 * `2` — переименование (путь и прежний путь двумя частями), `?` — неотслеживаемый файл
 * (или вложенный репозиторий с хвостовой `/` — он отбрасывается), `#` — заголовок.
 */
export function parseGitStatus(stdout: string): VcsStatus {
    const records = stdout.split('\0');
    const changed: VcsStatusEntry[] = [];
    const untracked: string[] = [];

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index] ?? '';
        if (record === '') {
            continue;
        }
        const kind = record.slice(0, 2);

        if (kind === '# ') {
            continue;
        }
        if (kind === '? ') {
            const untrackedPath = record.slice(2);
            // Вложенный репозиторий git показывает одной записью с хвостовой `/`. Диффу он не нужен:
            // без gitlink его и `git add` не взял бы, а читать каталог как файл нечего.
            if (!untrackedPath.endsWith('/')) {
                untracked.push(untrackedPath);
            }
            continue;
        }
        if (kind === '2 ') {
            // Прежний путь едет отдельной частью — её надо снять с ленты вместе с записью.
            index += 1;
        }
        if (kind === '1 ' || kind === '2 ' || kind === 'u ') {
            const fields = record.split(' ');
            const status = fields[1] ?? '';
            // Путь — хвост записи после фиксированных полей, и пробелы внутри него уцелели:
            // `1` — восемь полей до пути, `2` — девять (добавлен счёт переноса), `u` — десять.
            const head = kind === 'u ' ? 10 : kind === '2 ' ? 9 : 8;
            const path = fields.slice(head).join(' ');
            if (path !== '') {
                changed.push({ status, path });
            }
        }
    }
    return { changed, untracked };
}

/**
 * Разбор `git diff --name-status -z`: буква статуса и путь отдельными NUL-частями,
 * у `R`/`C` путей два — прежний и новый (с `--no-renames` их не бывает).
 */
export function parseGitNameStatus(stdout: string): NameStatusEntry[] {
    const parts = stdout.split('\0').filter((part) => part !== '');
    const entries: NameStatusEntry[] = [];

    for (let index = 0; index < parts.length; index += 1) {
        const letter = (parts[index] ?? '').slice(0, 1).toUpperCase();
        const renamed = letter === 'R' || letter === 'C';
        const first = parts[index + 1];
        if (first === undefined) {
            break;
        }
        const second = renamed ? parts[index + 2] : undefined;
        index += renamed ? 2 : 1;
        if (renamed && second === undefined) {
            break;
        }

        entries.push({
            changeType: changeTypeOf(letter),
            path: second ?? first,
            oldPath: letter === 'R' ? first : null,
        });
    }
    return entries;
}
