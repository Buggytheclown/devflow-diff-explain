import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { PrDiff } from '@sherpa/protocol';

import type { TaskRecord } from './queue.js';

/**
 * Общий контекст задач. Всё, что между задачами не меняется — дифф PR, текст
 * файла, методичка, — материализуется один раз по стабильному пути под `payload/shared/`, а каталог
 * задачи держит только своё. Признак общности — сам путь: модель по нему видит, читала ли она этот
 * файл в этой сессии. Протокол не меняется: в задаче едут те же `contextFiles`.
 *
 * Самодостаточность задачи (docs/protocol.md §4) сохраняется: файл лежит на диске, путь — в задаче, и
 * новая сессия читает его как обычно.
 *
 * Запись синхронная: файлы пишутся считанные разы за сессию, и синхронный путь дешевле автомата
 * вокруг него. Она идемпотентна («есть — не перезаписываем») и атомарна (временный файл плюс
 * `rename`), поэтому недописанный файл в задачу не попадает.
 */

/** Права каталогов и файлов — те же, что у остального payload (docs/architecture.md §6). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Хеш в имени: 8 hex различают версии текста и не удлиняют путь. */
const HASH_LENGTH = 8;
/** Читаемая часть имени файла: дальше всё равно хеш, а длина пути не бесконечна. */
const NAME_LENGTH = 60;

export type FileSide = 'old' | 'new';

/** Ключ общего диффа: пара коммитов PR. Новый пуш — новый ключ и новый каталог. */
export function diffKeyOf(diff: PrDiff): string {
    return `${safeSegment(diff.baseCommit)}-${safeSegment(diff.headCommit)}`;
}

/**
 * Держит ли задача свой payload: открытая задача его читает, а держатель отменённой ещё не знает
 * об отмене (docs/protocol.md §5) и тоже имеет право дочитать. Всё остальное — мусор чистки.
 */
export function holdsPayload(task: TaskRecord): boolean {
    return task.status === 'queued' || task.status === 'leased' || task.workerId !== null;
}

export class SharedPayloadStore {
    private readonly sharedDir: string;
    /** Пути контекста задач, которые ещё читаются: их ключи диффа чистка не трогает. */
    private readonly openContextFiles: () => Iterable<string>;
    /**
     * Ключи диффа, которые держит текущая сборка payload: дифф итерации и срез до неё
     * (`interdiff.md`) живут вместе, поэтому чистка на смену ключа обязана щадить оба.
     */
    private readonly liveKeys = new Set<string>();

    constructor(sharedDir: string, openContextFiles: () => Iterable<string>) {
        this.sharedDir = sharedDir;
        this.openContextFiles = openContextFiles;
    }

    /** Методичка по хешу содержимого: новый текст сервера не подсунет старый путь старой сессии. */
    guide(name: string, content: string): string {
        const file = path.join(this.sharedDir, 'guides', `${name}-${hashOf(content)}.md`);
        this.write(file, content);
        return file;
    }

    /** Общий дифф PR: им пользуются `route.skeleton`, `route.section` и вопрос чата без якоря. */
    prDiff(key: string, content: string): string {
        const file = path.join(this.startBuildDir(key), 'pr-diff.md');
        const index = path.join(path.dirname(file), 'saved-patch-index.json');
        this.write(file, content + (fs.existsSync(index) ? `\nSaved complete patches (read specific files as needed): ${index}\n` : ''));
        return file;
    }

    /** Полные патчи живут рядом с ограниченным контекстом и чистятся вместе с его версией. */
    savedPatch(key: string, index: number, content: string): string {
        const file = path.join(this.joinBuildDir(key), 'patches', `${String(index + 1)}.md`);
        this.write(file, content); return file;
    }

    savedPatchIndex(key: string, content: string): string {
        const file = path.join(this.joinBuildDir(key), 'saved-patch-index.json');
        this.write(file, content); return file;
    }

    /**
     * Срез между итерациями для перегенерации маршрута. Ключ — пара голов итераций,
     * поэтому он не тот, что у диффа PR: каталог присоединяется к текущей сборке, а не начинает
     * новую — иначе чистка снесла бы дифф, на который задача этой же сборки ещё не сослалась.
     */
    interdiff(key: string, content: string): string {
        const file = path.join(this.joinBuildDir(key), 'interdiff.md');
        this.write(file, content);
        return file;
    }

    /** Полный текст стороны файла: два якорных вопроса к одному файлу делят один путь. */
    fileSide(key: string, fileId: string, side: FileSide, content: string): string {
        const file = path.join(this.startBuildDir(key), 'files', `${safeName(fileId)}.${side}.md`);
        this.write(file, content);
        return file;
    }

    /**
     * Убирает каталоги диффа, на которые уже никто не ссылается. Задача читает свой дифф до конца:
     * маршрут кеширует дифф на процесс, так что стоящие в очереди секции запросто ссылаются не на
     * тот ключ, с которым пришёл свежий вопрос чата, — сносить всё, кроме текущего ключа, нельзя.
     *
     * Ключи текущей сборки чистка тоже щадит: их задачи ещё не поставлены.
     */
    sweepDiffKeys(): void {
        const keep = this.referencedDiffKeys(this.openContextFiles());
        for (const key of this.liveKeys) {
            keep.add(key);
        }

        const root = path.join(this.sharedDir, 'diff');
        let entries: string[];
        try {
            entries = fs.readdirSync(root);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!keep.has(entry)) {
                fs.rmSync(path.join(root, entry), { recursive: true, force: true });
            }
        }
    }

    /**
     * Каталог диффа итерации: новый ключ начинает новую сборку, и каталоги прежней уходят,
     * если их не держит открытая задача.
     */
    private startBuildDir(key: string): string {
        if (!this.liveKeys.has(key)) {
            this.liveKeys.clear();
            this.liveKeys.add(key);
            this.sweepDiffKeys();
        }
        return path.join(this.sharedDir, 'diff', key);
    }

    /** Каталог ключа-спутника текущей сборки: чистку не запускает, но от неё защищён. */
    private joinBuildDir(key: string): string {
        this.liveKeys.add(key);
        return path.join(this.sharedDir, 'diff', key);
    }

    /** Ключи диффа, на которые ссылаются перечисленные пути; чужие пути пропускаются. */
    private referencedDiffKeys(contextFiles: Iterable<string>): Set<string> {
        const root = path.join(this.sharedDir, 'diff');
        const keys = new Set<string>();
        for (const file of contextFiles) {
            const relative = path.relative(root, file);
            if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
                continue;
            }
            const [key] = relative.split(path.sep);
            if (key !== undefined && key !== '') {
                keys.add(key);
            }
        }
        return keys;
    }

    private write(file: string, content: string): void {
        const dir = path.dirname(file);
        this.makeDir(dir);
        // Общий путь — общий и во времени: файл по ключу пишется один раз и больше не трогается.
        if (fs.existsSync(file)) {
            return;
        }

        const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
        fs.writeFileSync(temp, content, { mode: FILE_MODE });
        try {
            fs.renameSync(temp, file);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            throw error;
        }
    }

    private makeDir(dir: string): void {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        // mkdir применяет mode с учётом umask, а каталоги могли существовать и раньше.
        let current = this.sharedDir;
        fs.chmodSync(current, DIR_MODE);
        for (const segment of path.relative(this.sharedDir, dir).split(path.sep)) {
            if (segment === '') {
                continue;
            }
            current = path.join(current, segment);
            fs.chmodSync(current, DIR_MODE);
        }
    }
}

function hashOf(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

/** Имя файла из чужого идентификатора: читаемая часть плюс хеш от исходной строки. */
function safeName(id: string): string {
    return `${safeSegment(id).slice(0, NAME_LENGTH)}-${hashOf(id)}`;
}

function safeSegment(value: string): string {
    return value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}
