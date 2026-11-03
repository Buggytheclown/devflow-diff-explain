import type { ReviewSource } from '@sherpa/protocol';

import type {
    FileContent,
    HostCapabilities,
    HostId,
    Iteration,
    PrDiff,
    PrMeta,
    ReviewUser,
} from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import { localInterdiff } from './interdiff.js';
import type { LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';
import { appendToHistory } from './iterations-store.js';
import type { LocalRepo, LocalSnapshot } from './snapshot.js';
import { buildLocalSnapshot, openLocalRepo, probeLocal, readSideBytes } from './snapshot.js';
import type { LocalVcs } from './vcs.js';

/** Read-only источник: метаданные, закреплённый код, версии и изображения. */

/** Как часто опрашивается рабочее дерево. Дебаунса нет: правка видна на следующем тике. */
const POLL_INTERVAL_MS = 30_000;

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: false,
    fileContent: true,
    sourceAtRevision: true,
    commentIssues: false,
    // Issue локально нет — резолвить по комментарию нечего, resolve живёт на треде.
    commentResolve: false,
    editPublished: false,
    iterations: true,
    blobs: true,
};

export interface LocalHostOptions {
    /** Ключ ревью: он же `PrMeta.id`. */
    readonly prKey: string;
    readonly vcs: LocalVcs;
    /** Каталог проекта внутри чекаута; пути наружу считаются от него. */
    readonly projectDir: string;
    /** База сравнения; null — merge-base с базовой веткой по умолчанию на каждом опросе. */
    readonly base: string | null;
    /** Ветка, на которой построен ключ ревью; null — первый снимок её зафиксирует. */
    readonly branch: string | null;
    /** История итераций: прошлых итераций у рабочего дерева нет больше нигде. */
    readonly iterations: LocalIterationsStore;
    readonly pollIntervalMs?: number;
    readonly now?: () => Date;
    /** Ветка зафиксирована первым снимком — её нужно сохранить рядом с каталогом и базой. */
    readonly onBranchResolved?: (branch: string) => void;
    /** Куда писать отказы истории итераций; по умолчанию stderr. */
    readonly log?: (message: string) => void;
}

export class LocalHost implements ReviewSource {

    private readonly options: LocalHostOptions;
    private readonly pollIntervalMs: number;
    private readonly now: () => Date;
    private readonly log: (message: string) => void;
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();
    private timer: NodeJS.Timeout | null = null;

    private repoPromise: Promise<LocalRepo> | null = null;
    private snapshotPromise: Promise<LocalSnapshot> | null = null;
    private current: LocalSnapshot | null = null;
    /** Чекаут ушёл из-под ревью (сменилась ветка): пока она не вернётся, хост отказывает. */
    private failure: Error | null = null;
    private expectedBranch: string | null;

    /** История итераций в памяти; null — с диска её ещё не читали. */
    private historyValue: LocalIterationRecord[] | null = null;
    private historyPromise: Promise<LocalIterationRecord[]> | null = null;

    /** Байты сторон картинок живут дольше снимка: блоб адресуется содержимым. */
    private readonly blobs = new Map<string, Uint8Array>();

    constructor(options: LocalHostOptions) {
        this.options = options;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.now = options.now ?? ((): Date => new Date());
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
        this.expectedBranch = options.branch;
    }

    /** Принудительный опрос рабочего дерева — мимо интервала таймера и мимо дешёвой проверки. */
    async refresh(): Promise<void> {
        await this.rebuild(true);
    }

    async getPr(): Promise<PrMeta> {
        const snapshot = await this.snapshot();

        return {
            id: this.options.prKey,
            url: `file://${this.options.projectDir}`,
            title: snapshot.branch,
            author: this.userOf(snapshot.login),
            fromBranch: snapshot.branch,
            toBranch: snapshot.baseRef,
            state: 'open',
            statusLabel: 'local',
            checks: null,
            updatedAt: snapshot.createdAt,
            capabilities: { ...CAPABILITIES, publishVerdicts: [] },
            // Вердикт живёт внутри итерации: новый дифф — ревью снова не завершено.
            verdicts: [],
            // Локальное ревью читает тот, чьё это дерево.
            viewer: this.userOf(snapshot.login),
        };
    }

    /** Вся история рабочего дерева: последняя запись — активная итерация. */
    async listIterations(): Promise<Iteration[]> {
        await this.snapshot();
        await this.history();
        return this.iterationList();
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            return this.sliceOf(slice.base, slice.head);
        }

        const snapshot = await this.snapshot();
        return {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            files: snapshot.files.map((file) => structuredClone(file)),
        };
    }

    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        this.startPolling();
        void this.listIterations()
            .then((iterations) => {
                if (this.iterationWatchers.has(onChange)) {
                    onChange(iterations);
                }
            })
            .catch(() => {
                // Первый снимок не собрался: подписка молчит, ошибку человеку покажет ручка диффа.
            });

        return () => {
            this.iterationWatchers.delete(onChange);
            this.stopPollingIfIdle();
        };
    }

    /**
     * Содержимое файла целиком по обе стороны; null — текста у файла нет (двоичный или больше
     * `MAX_FILE_BYTES`). Стороны читаются сейчас, а не лежат в снимке, поэтому снимок сперва
     * догоняется: иначе номера строк разошлись бы с патчем итерации, на которую ссылается `fileId`.
     */
    async getSourceAtRevision(filePath: string, revision: string): Promise<string | null> {
        const record = (await this.history()).find((entry) => entry.headCommit === revision);
        const repo = await this.repo();
        if (record !== undefined) {
            const file = record.files.find((entry) => entry.path === filePath);
            if (file !== undefined) return file.blob === null ? null : this.options.iterations.blob(file.blob);
        }
        const ref = record?.baseCommit ?? revision;
        try { return (await repo.vcs.show(ref, repo.prefix === '' ? filePath : `${repo.prefix}/${filePath}`)).toString('utf8'); }
        catch { return null; }
    }

    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const snapshot = await this.rebuild(false);
        const entry = snapshot.entries.get(fileId);
        if (entry === undefined) {
            throw new Error(
                fileId.startsWith(`${snapshot.diffId}:`)
                    ? `file ${fileId} is not in the diff`
                    : `file ${fileId} belongs to an older diff: the working tree has changed since`,
            );
        }
        if (entry.file.binary) {
            return null;
        }

        const repo = await this.repo();
        const [oldSide, newSide] = await Promise.all([
            readSideBytes(repo, snapshot.baseCommit, entry, 'old'),
            readSideBytes(repo, snapshot.baseCommit, entry, 'new'),
        ]);
        if (oldSide.kind === 'oversized' || newSide.kind === 'oversized') {
            return null;
        }
        return {
            oldText: oldSide.kind === 'bytes' ? oldSide.bytes.toString('utf8') : null,
            newText: newSide.kind === 'bytes' ? newSide.bytes.toString('utf8') : null,
        };
    }

    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        await this.snapshot();
        const bytes = this.blobs.get(blobId);
        return bytes === undefined ? null : bytes.slice();
    }

    private userOf(login: string): ReviewUser {
        return { login, displayName: null, bot: false, avatarUrl: null };
    }

    private emitIterations(): void {
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationList());
        }
    }

    /** Итерации из истории: последняя активна, остальные — прошлые. */
    private iterationList(): Iteration[] {
        const history = this.historyValue ?? [];
        return history.map((record, index) => ({
            diffId: record.diffId,
            baseCommit: record.baseCommit,
            headCommit: record.headCommit,
            createdAt: record.createdAt,
            status: index === history.length - 1 ? 'active' : 'previous',
        }));
    }

    /**
     * Срез между двумя итерациями истории. Итерации, которой в истории нет, хост не знает
     * никогда — это окончательный отказ (`bad_request`), а не повод повторять запрос.
     */
    private async sliceOf(base: HostId, head: HostId): Promise<PrDiff> {
        await this.snapshot();
        const history = await this.history();
        const find = (diffId: HostId): LocalIterationRecord => {
            const found = history.find((record) => record.diffId === diffId);
            if (found === undefined) {
                throw new RpcFailure('bad_request', `iteration ${diffId} is unknown to the local host`);
            }
            return found;
        };
        return localInterdiff(this.options.iterations, find(base), find(head));
    }

    /** История итераций: с диска читается один раз, дальше её ведёт сам адаптер. */
    private history(): Promise<LocalIterationRecord[]> {
        const known = this.historyValue;
        if (known !== null) {
            return Promise.resolve(known);
        }
        this.historyPromise ??= this.options.iterations
            .read()
            .then((records) => {
                this.historyValue ??= records;
                return this.historyValue;
            })
            .catch((error: unknown) => {
                this.historyPromise = null;
                throw error;
            });
        return this.historyPromise;
    }

    /**
     * Снимок в истории: тот же дифф, что у последней записи, — та же итерация (её и поднимает
     * перезапуск сервера), иначе новая запись. Возвращает момент рождения итерации: у поднятой
     * из истории он свой, а не сегодняшний.
     *
     * История — производные данные: её потеря стоит переноса прогресса, но не всего экрана
     * ревью. Хранилище отказало — пишем в лог и живём тем, что от истории осталось в памяти,
     * а не роняем `getPr`, `getDiff` и `listIterations` вместе со снимком.
     */
    private async recordIteration(snapshot: LocalSnapshot): Promise<string> {
        const record: LocalIterationRecord = {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            createdAt: snapshot.createdAt,
            files: snapshot.iterationFiles,
        };

        let known: LocalIterationRecord[];
        try {
            known = await this.history();
        } catch (error) {
            // Прошлых итераций хост не знает: срез по ним получит тот же окончательный отказ,
            // что и по итерации, которой не было.
            this.log(`история итераций не прочитана: ${messageOf(error)}`);
            known = [];
        }

        const last = known.at(-1);
        if (last?.diffId === snapshot.diffId) {
            return last.createdAt;
        }

        try {
            this.historyValue = await this.options.iterations.append(record, snapshot.textBlobs);
        } catch (error) {
            this.log(`итерация ${record.diffId} не записана в историю: ${messageOf(error)}`);
            // Итерация остаётся только в памяти: её блобов в хранилище нет, и срез покажет
            // файлы без патчей — прогресс не переедет, но ревью работает. Следующая запись
            // снова пойдёт в хранилище, поэтому починившийся диск подхватится сам.
            this.historyValue = appendToHistory(known, record);
            this.historyPromise = null;
        }
        return record.createdAt;
    }

    private repo(): Promise<LocalRepo> {
        this.repoPromise ??= openLocalRepo(this.options.vcs, this.options.projectDir).catch(
            (error: unknown) => {
                this.repoPromise = null;
                throw error;
            },
        );
        return this.repoPromise;
    }

    /**
     * Снимок рабочего дерева. Первый считается лениво, при первом обращении: старт сервера
     * его не ждёт (`docs/architecture.md §6`).
     */
    private async snapshot(): Promise<LocalSnapshot> {
        if (this.failure !== null) {
            throw this.failure;
        }
        const current = this.current;
        if (current !== null) {
            return current;
        }
        return this.rebuild(true);
    }

    /**
     * Пересчёт снимка; параллельные вызовы делят один проход. Принудительный вызов проход не
     * делит, а встаёт за ним: идущий пересчёт начался до правки, ради которой зовут `force`.
     */
    private rebuild(force: boolean): Promise<LocalSnapshot> {
        const running = this.snapshotPromise;
        if (running !== null && !force) {
            return running;
        }

        const started =
            running === null
                ? this.recompute(force)
                : running.then(
                      () => this.recompute(force),
                      () => this.recompute(force),
                  );
        const tracked: Promise<LocalSnapshot> = started.finally(() => {
            // Хвост очереди мог уехать вперёд: обнуляет только последний проход.
            if (this.snapshotPromise === tracked) {
                this.snapshotPromise = null;
            }
        });
        this.snapshotPromise = tracked;
        return tracked;
    }

    private async recompute(force: boolean): Promise<LocalSnapshot> {
        const repo = await this.repo();
        const probe = await probeLocal(repo, this.options.base);
        this.checkBranch(probe.info.branch);

        const known = this.current;
        if (known !== null && !force && known.stamp === probe.stamp) {
            // Дешёвая проверка сошлась: дерево не трогали, читать дифф незачем.
            return known;
        }

        const built = await buildLocalSnapshot(repo, probe, this.now().toISOString());
        for (const [blobId, bytes] of built.blobs) {
            this.blobs.set(blobId, bytes);
        }

        const previous = this.current;
        if (previous !== null && previous.diffId === built.diffId) {
            // Дифф тот же — итерация не меняется; свежим берём только отпечаток опроса.
            this.current = { ...previous, stamp: built.stamp };
            return this.current;
        }

        // Момент рождения итерации — из истории: перезапуск сервера поднимает её, а не заводит новую.
        const createdAt = await this.recordIteration(built);
        const snapshot = createdAt === built.createdAt ? built : { ...built, createdAt };
        this.current = snapshot;
        if (previous !== null) {
            this.emitIterations();
        }
        return snapshot;
    }

    /**
     * Ключ ревью держит каталог и ветку: на другой ветке это другое ревью, и отдавать под старым
     * ключом чужой дифф нельзя. Ветка вернулась — следующий опрос снимает отказ.
     */
    private checkBranch(branch: string): void {
        if (this.expectedBranch === null) {
            this.expectedBranch = branch;
            this.options.onBranchResolved?.(branch);
        }
        if (this.expectedBranch !== branch) {
            this.failure = new Error(
                `checkout switched to branch ${branch}; run \`devflow-diff-explain up --local ${this.options.projectDir}\` again`,
            );
            throw this.failure;
        }
        this.failure = null;
    }

    private startPolling(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            void this.rebuild(false).catch(() => {
                // Тик опроса не роняет подписки: причину покажет ближайший вызов ручки.
            });
        }, this.pollIntervalMs);
        this.timer.unref();
    }

    private stopPollingIfIdle(): void {
        if (this.timer === null || this.iterationWatchers.size > 0) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
