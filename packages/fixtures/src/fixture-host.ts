import type { CodeReader } from '@sherpa/protocol';
import type {
    FileContent,
    HostId,
    Iteration,
    PrDiff,
    PrMeta,
} from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES } from '@sherpa/protocol';

import type { FixtureData, FixtureIteration, FixtureName } from './data/index.js';
import { fixtureData } from './data/index.js';
import { fileContentOf } from './file-content.js';
import { fixtureBlob } from './patch.js';



export class FixtureHost implements CodeReader {

    private readonly data: FixtureData;
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();

    /** Указатель активной итерации: `advanceIteration` двигает его на одну вперёд. */
    private active = 0;

    /** Есть только когда хост фикстуры умеет содержимое файлов (`capabilities.fileContent`). */
    getSourceAtRevision?: (path: string, revision: string) => Promise<string | null>;
    getFileContent?: (fileId: HostId) => Promise<FileContent | null>;

    /** Есть только когда хост фикстуры умеет байты картинок (`capabilities.blobs`). */
    getBlob?: (blobId: HostId) => Promise<Uint8Array | null>;

    constructor(name: FixtureName) {
        this.data = fixtureData(name);
        // Данные фикстур issue-статус обычно не задают; инвариант контракта чинится здесь, чтобы
        // каждый комментарий каждого файла данных не приходилось помечать вручную.
        const capabilities = this.data.pr.capabilities;
        capabilities.publishVerdicts = []; capabilities.fileViewedSync = false;
        capabilities.commentIssues = false; capabilities.commentResolve = false; capabilities.editPublished = false;
        if (this.data.pr.capabilities.fileContent) {
            this.getFileContent = (fileId) => this.loadFileContent(fileId);
            capabilities.sourceAtRevision = true;
            this.getSourceAtRevision = (path, revision) => {
                const iteration = this.data.iterations.find((entry) => entry.diff.headCommit === revision || entry.diff.baseCommit === revision);
                if (iteration === undefined) return Promise.resolve(null);
                if (path === 'context/caller.ts') return Promise.resolve('export function caller() {\n  return validate();\n}\n');
                const old = iteration.diff.baseCommit === revision;
                const file = iteration.diff.files.find((entry) => (old ? entry.oldPath ?? entry.path : entry.path) === path);
                const content = file === undefined || file.binary ? null : fileContentOf(file);
                return Promise.resolve(content === null ? null : old ? content.oldText : content.newText);
            };
        }
        if (this.data.pr.capabilities.blobs) {
            this.getBlob = (blobId) => this.loadBlob(blobId);
        }
    }

    getPr(): Promise<PrMeta> {
        // «Я» фикстуры — и автор черновиков, и тот, кто смотрит PR.
        return Promise.resolve({ ...structuredClone(this.data.pr), viewer: structuredClone(this.data.currentUser) });
    }

    /** Итерации до активной включительно; переписанные force-push'ем не перечисляются вовсе. */
    listIterations(): Promise<Iteration[]> {
        return Promise.resolve(this.iterationsSnapshot());
    }

    /**
     * Дифф активной итерации, а со `slice` — объявленный в фикстуре срез между двумя
     * перечисляемыми итерациями. Всё, чего в данных нет, отклоняется понятной ошибкой:
     * молча отдать дифф не той итерации хуже, чем отказать.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice === undefined) {
            return Promise.resolve(structuredClone(this.activeData().diff));
        }
        if (!this.data.pr.capabilities.iterations) {
            return Promise.reject(new Error('хост не поддерживает срезы между итерациями (capabilities.iterations)'));
        }

        const listed = new Set(this.listed().map((iteration) => iteration.iteration.diffId));
        for (const diffId of [slice.base, slice.head]) {
            if (!listed.has(diffId)) {
                return Promise.reject(new Error(`итерация ${diffId} неизвестна хосту`));
            }
        }

        const found = this.data.interdiffs.find(
            (interdiff) => interdiff.base === slice.base && interdiff.head === slice.head,
        );
        if (found === undefined) {
            return Promise.reject(new Error(`среза ${slice.base}→${slice.head} в фикстуре нет`));
        }
        return Promise.resolve(structuredClone(found.diff));
    }

    /** Подписка на итерации: снапшот сразу и после каждого `advanceIteration`. */
    subscribeVersions(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        onChange(this.iterationsSnapshot());
        return () => {
            this.iterationWatchers.delete(onChange);
        };
    }

    /**
     * Фикстурный «пуш»: следующая объявленная итерация становится активной. Ею живут дев-ручка
     * сервера и галерея второго захода; на последней итерации двигаться уже некуда.
     */
    advanceIteration(): Iteration {
        if (this.active + 1 >= this.data.iterations.length) {
            throw new Error('итераций больше нет: фикстура закончилась');
        }
        this.active += 1;
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationsSnapshot());
        }
        return this.activeIteration();
    }

    /** Данные активной итерации; указатель всегда внутри массива — пустых фикстур не бывает. */
    private activeData(): FixtureIteration {
        const iteration = this.data.iterations[this.active];
        if (iteration === undefined) {
            throw new Error(`указатель итерации ${String(this.active)} вне фикстуры`);
        }
        return iteration;
    }

    /**
     * Итерации, которые хост сейчас перечисляет: всё до активной включительно, кроме
     * переписанных force-push'ем — их хост уже не видит, а `gone` ставит сервер.
     */
    private listed(): FixtureIteration[] {
        const seen = this.data.iterations.slice(0, this.active + 1);
        const replaced = new Set(seen.map((iteration) => iteration.replaces).filter((id) => id !== null));
        return seen.filter((iteration) => !replaced.has(iteration.iteration.diffId));
    }

    private iterationsSnapshot(): Iteration[] {
        const activeId = this.activeData().iteration.diffId;
        return this.listed().map((iteration) => ({
            ...structuredClone(iteration.iteration),
            status: iteration.iteration.diffId === activeId ? ('active' as const) : ('previous' as const),
        }));
    }

    private activeIteration(): Iteration {
        const activeId = this.activeData().iteration.diffId;
        const found = this.iterationsSnapshot().find((iteration) => iteration.diffId === activeId);
        if (found === undefined) {
            throw new Error('активная итерация не попала в список — такого быть не должно');
        }
        return found;
    }

    /** Неизвестный файл — ошибка хоста, известный без содержимого (binary, картинка) — честный null. */
    private loadFileContent(fileId: HostId): Promise<FileContent | null> {
        const file = this.activeData().diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`файл ${fileId} не найден в диффе`));
        }
        return Promise.resolve(file.image === null ? fileContentOf(file) : null);
    }

    /**
     * Байты стороны картинки. Блобы содержательно адресуемы и живут вне итерации: id из среза и
     * из прошлой итерации работает так же, как из активной. Слишком большая сторона — `null`,
     * как у настоящего хоста (лимит контракта).
     */
    private loadBlob(blobId: HostId): Promise<Uint8Array | null> {
        const bytes = fixtureBlob(blobId);
        if (bytes === null || bytes.length > IMAGE_BLOB_MAX_BYTES) {
            return Promise.resolve(null);
        }
        return Promise.resolve(bytes.slice());
    }
}

export function makeFixtureHost(name: FixtureName): FixtureHost {
    return new FixtureHost(name);
}
