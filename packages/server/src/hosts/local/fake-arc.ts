import fs from 'node:fs';
import path from 'node:path';

import type { CommandOutcome, CommandRunner } from './vcs.js';

/**
 * Подставной `arc` поверх настоящего каталога на диске: живой `arc` в тестах не зовётся,
 * а файлы адаптер читает по-настоящему. Состояние базы — карта «путь от корня чекаута →
 * содержимое»; всё, что лежит на диске и не отслеживается, считается неотслеживаемым.
 */

/** Сколько строк контекста вокруг изменения печатает подставной дифф — как у `arc` по умолчанию. */
const CONTEXT_LINES = 3;

export interface FakeArcOptions {
    /** Корень чекаута: настоящий временный каталог. */
    readonly root: string;
    /** Каталог проекта от корня чекаута; пустая строка — проект и есть корень. */
    readonly prefix: string;
}

export class FakeArc {
    branch = 'feature';
    head = '1'.repeat(40);
    login = 'reviewer';
    base = '0'.repeat(40);

    /** Куда указывают именованные ссылки: ими отвечает `rev-parse` на явную базу. */
    readonly refs = new Map<string, string>();

    /** Содержимое файлов на базовом коммите: путь от корня чекаута → байты. */
    readonly baseTree = new Map<string, Buffer>();
    /** Отслеживаемые пути сверх базового дерева (добавленные в индекс). */
    readonly added = new Set<string>();

    /** Префиксы путей, которые чекаут игнорирует (`.arcignore`): в `status` они не попадают. */
    readonly ignored: string[] = [];

    private readonly root: string;
    private readonly prefix: string;

    constructor(options: FakeArcOptions) {
        this.root = options.root;
        this.prefix = options.prefix;
    }

    /** Каталог проекта абсолютным путём. */
    get projectDir(): string {
        return this.prefix === '' ? this.root : path.join(this.root, this.prefix);
    }

    /** Кладёт файл и на базу, и на диск: так рождается неизменённый отслеживаемый файл. */
    commit(rootPath: string, content: string | Buffer): void {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
        this.baseTree.set(rootPath, bytes);
        this.writeDisk(rootPath, bytes);
    }

    /** Пишет файл на диск, не трогая базу: отслеживаемая правка или неотслеживаемый файл. */
    writeDisk(rootPath: string, content: string | Buffer): void {
        const absolute = path.join(this.root, rootPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }

    removeDisk(rootPath: string): void {
        fs.rmSync(path.join(this.root, rootPath), { force: true });
    }

    /** Команды в порядке вызова: по ним видно, что дешёвый опрос не читает дифф. */
    readonly calls: string[] = [];

    readonly runner: CommandRunner = (args) => Promise.resolve(this.answer(args));

    /** Сколько раз позвали команду с таким именем. */
    countOf(command: string): number {
        return this.calls.filter((call) => call === command).length;
    }

    private answer(args: readonly string[]): CommandOutcome {
        const [command] = args;
        this.calls.push(command ?? '');

        if (command === 'root') {
            return ok(`${this.root}\n`);
        }
        if (command === 'info') {
            return ok(
                `${JSON.stringify({ branch: this.branch, hash: this.head, user_login: this.login })}\n`,
            );
        }
        if (command === 'merge-base') {
            return ok(`${this.base}\n`);
        }
        if (command === 'rev-parse') {
            const ref = args[1] ?? '';
            const resolved = this.refs.get(ref);
            return resolved === undefined
                ? { code: 1, stdout: Buffer.alloc(0), stderr: `fake arc: unknown revision ${ref}\n` }
                : ok(`${resolved}\n`);
        }
        if (command === 'status') {
            return ok(this.status(args));
        }
        if (command === 'show') {
            return this.show(args[1] ?? '');
        }
        if (command === 'diff') {
            // `--relative` живой `arc` считает от рабочего каталога команды: всё, кроме `.`,
            // молча отдало бы пустой дифф, поэтому здесь это явный отказ.
            if (!args.includes('--relative=.')) {
                return { code: 1, stdout: Buffer.alloc(0), stderr: 'fake arc: --relative=. expected\n' };
            }
            return ok(args.includes('--name-status') ? this.nameStatus() : this.patch());
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: `fake arc: unknown command ${args.join(' ')}\n` };
    }

    private show(target: string): CommandOutcome {
        const separator = target.indexOf(':');
        const content = this.baseTree.get(target.slice(separator + 1));
        return content === undefined
            ? { code: 1, stdout: Buffer.alloc(0), stderr: `fake arc: no such path ${target}\n` }
            : { code: 0, stdout: content, stderr: '' };
    }

    private status(args: readonly string[]): string {
        const changed = this.trackedChanges().map((change) => ({
            status: change.kind === 'add' ? 'added' : change.kind === 'delete' ? 'deleted' : 'modified',
            type: 'file',
            path: change.rootPath,
        }));
        const files = this.diskFiles().filter(
            (rootPath) => !this.isTracked(rootPath) && !this.isIgnored(rootPath),
        );
        // Игнорируемое arc не показывает вовсе, а без `-u all` схлопывает каталог в одну запись.
        const untracked = args.includes('all')
            ? files.map((rootPath) => ({ status: 'untracked', type: 'file', path: rootPath }))
            : this.collapse(files);

        return JSON.stringify({ status: { changed, untracked } });
    }

    /** Неотслеживаемый каталог одной записью: так отвечает живой `arc status` без `-u all`. */
    private collapse(files: readonly string[]): { status: string; type: string; path: string }[] {
        const entries: { status: string; type: string; path: string }[] = [];
        const seen = new Set<string>();

        for (const file of files) {
            const slash = file.lastIndexOf('/');
            const dir = slash === -1 ? '' : file.slice(0, slash);
            const whole =
                dir !== '' &&
                !this.diskFiles().some((other) => other.startsWith(`${dir}/`) && this.isTracked(other));
            const path = whole ? dir : file;
            if (!seen.has(path)) {
                seen.add(path);
                entries.push({ status: 'untracked', type: whole ? 'directory' : 'file', path });
            }
        }
        return entries;
    }

    private isIgnored(rootPath: string): boolean {
        return this.ignored.some((prefix) => rootPath.startsWith(prefix));
    }

    private nameStatus(): string {
        return this.trackedChanges()
            .map((change) => `${letterOf(change.kind)}       ${change.localPath}\n`)
            .join('');
    }

    private patch(): string {
        return this.trackedChanges()
            .map((change) => patchOf(change))
            .join('');
    }

    /** Отслеживаемые файлы каталога проекта, чьё содержимое разошлось с базой. */
    private trackedChanges(): Change[] {
        const paths = new Set<string>([...this.baseTree.keys(), ...this.added]);
        const changes: Change[] = [];

        for (const rootPath of [...paths].sort((left, right) => left.localeCompare(right))) {
            const localPath = this.withinProject(rootPath);
            if (localPath === null) {
                continue;
            }

            const before = this.baseTree.get(rootPath) ?? null;
            const after = this.readDisk(rootPath);
            if (before === null && after === null) {
                continue;
            }
            if (before !== null && after !== null && before.equals(after)) {
                continue;
            }

            changes.push({
                rootPath,
                localPath,
                kind: before === null ? 'add' : after === null ? 'delete' : 'modify',
                before,
                after,
            });
        }
        return changes;
    }

    private isTracked(rootPath: string): boolean {
        return this.baseTree.has(rootPath) || this.added.has(rootPath);
    }

    private diskFiles(): string[] {
        const found: string[] = [];
        const walk = (absolute: string, local: string): void => {
            for (const child of fs.readdirSync(absolute, { withFileTypes: true })) {
                const next = local === '' ? child.name : `${local}/${child.name}`;
                if (child.isDirectory()) {
                    walk(path.join(absolute, child.name), next);
                } else if (child.isFile()) {
                    found.push(next);
                }
            }
        };
        walk(this.root, '');
        return found.sort((left, right) => left.localeCompare(right));
    }

    private readDisk(rootPath: string): Buffer | null {
        try {
            return fs.readFileSync(path.join(this.root, rootPath));
        } catch {
            return null;
        }
    }

    /** Путь от корня чекаута → путь от каталога проекта; null — файл вне проекта. */
    private withinProject(rootPath: string): string | null {
        if (this.prefix === '') {
            return rootPath;
        }
        return rootPath.startsWith(`${this.prefix}/`) ? rootPath.slice(this.prefix.length + 1) : null;
    }
}

interface Change {
    readonly rootPath: string;
    readonly localPath: string;
    readonly kind: 'add' | 'delete' | 'modify';
    readonly before: Buffer | null;
    readonly after: Buffer | null;
}

function letterOf(kind: Change['kind']): string {
    return kind === 'add' ? 'A' : kind === 'delete' ? 'D' : 'M';
}

function patchOf(change: Change): string {
    const header = `diff --git a/${change.localPath} b/${change.localPath}\n`;
    if (isBinary(change.before) || isBinary(change.after)) {
        return `${header}Binary files a/${change.localPath} and b/${change.localPath} differ\n`;
    }

    const before = linesOf(change.before);
    const after = linesOf(change.after);
    const sides = `--- ${change.before === null ? '/dev/null' : `a/${change.localPath}`}\n+++ ${
        change.after === null ? '/dev/null' : `b/${change.localPath}`
    }\n`;
    return `${header}${sides}${hunkOf(before, after)}`;
}

/** Один ханк на файл: общие хвосты уходят в контекст, различающаяся середина — в тело. */
function hunkOf(before: readonly string[], after: readonly string[]): string {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const leading = Math.min(CONTEXT_LINES, prefix);
    const trailing = Math.min(CONTEXT_LINES, suffix);
    const oldStart = prefix - leading;
    const newStart = prefix - leading;
    const oldEnd = before.length - suffix + trailing;
    const newEnd = after.length - suffix + trailing;

    const body = [
        ...before.slice(oldStart, prefix).map((line) => ` ${line}`),
        ...before.slice(prefix, before.length - suffix).map((line) => `-${line}`),
        ...after.slice(prefix, after.length - suffix).map((line) => `+${line}`),
        ...before.slice(before.length - suffix, oldEnd).map((line) => ` ${line}`),
    ];

    const head = `@@ -${range(oldStart, oldEnd)} +${range(newStart, newEnd)} @@\n`;
    return `${head}${body.map((line) => `${line}\n`).join('')}`;
}

/** Диапазон ханка: пустая сторона (add/delete) начинается с нуля, как у настоящего патча. */
function range(start: number, end: number): string {
    const count = end - start;
    return `${String(count === 0 ? 0 : start + 1)},${String(count)}`;
}

function linesOf(content: Buffer | null): string[] {
    if (content === null) {
        return [];
    }
    const text = content.toString('utf8');
    return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

function isBinary(content: Buffer | null): boolean {
    return content?.subarray(0, 8192).includes(0) === true;
}

function ok(stdout: string): CommandOutcome {
    return { code: 0, stdout: Buffer.from(stdout), stderr: '' };
}
