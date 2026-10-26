import { z } from 'zod';

import type { CommandRunner, LocalVcs, NameStatusEntry, VcsInfo, VcsStatus } from './vcs.js';
import { changeTypeOf, commandBytes, commandLine, commandText } from './vcs.js';

/**
 * Бэкенд `arc` для локального ревью: команды и разбор их вывода.
 * Формы вывода показаны синтетическими примерами у соответствующих функций.
 */

/** База по умолчанию в Аркадии одна. */
const DEFAULT_BASE_REF = 'trunk';

export function arcVcs(run: CommandRunner): LocalVcs {
    const text = (args: readonly string[]): Promise<string> => commandText(run, 'arc', args);
    const line = (args: readonly string[]): Promise<string> => commandLine(run, 'arc', args);

    return {
        kind: 'arc',

        root: async () => (await text(['root'])).trim(),

        info: async () => parseArcInfo(await text(['info', '--json'])),

        defaultBaseRef: () => Promise.resolve(DEFAULT_BASE_REF),

        mergeBase: (ref) => line(['merge-base', ref, 'HEAD']),

        revParse: (ref) => line(['rev-parse', ref]),

        // `-u all` раскрывает неотслеживаемые каталоги файлами и сам вырезает игнорируемое
        // (`.arcignore`): собственный обход каталога притащил бы в дифф node_modules и сборку.
        status: async (projectDir) =>
            parseArcStatus(await text(['status', '--json', '-u', 'all', '--', projectDir])),

        // `--relative` считается от рабочего каталога команды, а он и есть каталог проекта:
        // абсолютный путь или путь от корня чекаута arc молча отдаёт пустым диффом.
        diff: (base) => text(['diff', '--git', '--relative=.', base]),

        nameStatus: async (base) =>
            parseNameStatus(await text(['diff', '--git', '--name-status', '--relative=.', base])),

        show: (ref, rootPath) => commandBytes(run, 'arc', ['show', `${ref}:${rootPath}`]),
    };
}

const infoSchema = z.object({
    branch: z.string().min(1),
    hash: z.string().min(1),
    user_login: z.string().min(1),
});

/**
 * Ветка, HEAD и логин из `arc info --json`. Синтетический пример:
 * `{"repository":"arcadia","author":"bob",…,"user_login":"alice","branch":"sherpa-local-host",
 * "hash":"12345678…"}`.
 */
export function parseArcInfo(stdout: string): VcsInfo {
    const parsed = infoSchema.safeParse(parseJson(stdout));
    if (!parsed.success) {
        throw new Error('`arc info --json` printed something Sherpa cannot read');
    }
    return { branch: parsed.data.branch, head: parsed.data.hash, login: parsed.data.user_login };
}

const statusEntrySchema = z.object({ status: z.string(), type: z.string(), path: z.string().min(1) });
const statusSchema = z.object({
    status: z
        .object({
            changed: z.array(statusEntrySchema).optional(),
            untracked: z.array(statusEntrySchema).optional(),
        })
        .optional(),
});

/**
 * Разбор `arc status --json -- <path>`. Чистое дерево печатает `{"status":{}}` — обеих секций
 * может не быть вовсе. Каталог среди неотслеживаемых означал бы, что arc в него не заглянул;
 * всё, что не файл, диффу не нужно.
 */
export function parseArcStatus(stdout: string): VcsStatus {
    const parsed = statusSchema.safeParse(parseJson(stdout));
    if (!parsed.success) {
        throw new Error('`arc status --json` printed something Sherpa cannot read');
    }
    return {
        changed: (parsed.data.status?.changed ?? []).map((entry) => ({
            status: entry.status,
            path: entry.path,
        })),
        untracked: (parsed.data.status?.untracked ?? [])
            .filter((entry) => entry.type === 'file')
            .map((entry) => entry.path),
    };
}

/**
 * Разбор `arc diff --git --name-status --relative=. <base>`. Живой формат (2026-09-11) —
 * буква статуса, добитая пробелами до колонки, и путь: `A       README-probe.md`. Перенос
 * файла в рабочем дереве arc показывает парой A + D, поэтому R и C здесь — задел на `-M`.
 */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
    const entries: NameStatusEntry[] = [];

    for (const line of stdout.split('\n')) {
        const match = /^(\S+)[ \t]+(.+)$/.exec(line);
        if (match === null) {
            continue;
        }
        const [status, rest] = [match[1] ?? '', match[2] ?? ''];
        const paths = splitPaths(rest);
        const last = paths.at(-1);
        if (last === undefined) {
            continue;
        }

        const letter = status.slice(0, 1).toUpperCase();
        entries.push({
            changeType: changeTypeOf(letter),
            path: last,
            oldPath: letter === 'R' && paths.length > 1 ? (paths[0] ?? null) : null,
        });
    }
    return entries;
}

/**
 * Пути одной строки статуса. Две стороны arc разделяет табом либо колонкой пробелов;
 * одиночный пробел разделителем не считается — он бывает внутри пути.
 */
function splitPaths(rest: string): string[] {
    const parts = rest.includes('\t') ? rest.split('\t') : rest.split(/ {2,}/u);
    return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
