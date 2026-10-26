import type { Comment, Iteration, ReviewHost, Thread, Verdict } from '@sherpa/protocol';
import {
    fileContentSchema,
    fileImageSchema,
    IMAGE_BLOB_MAX_BYTES,
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    reviewUserSchema,
    threadSchema,
    verdictSchema,
} from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Общий контрактный набор `ReviewHost` (`docs/testing.md §3`): один и тот же список тестов
 * гоняется на всех реализациях — на `FixtureHost`, на записанных ответах Арканума и на `LocalHost`
 * с обоими бэкендами (фейковый arc, живой git).
 *
 * Проверяется то, что обещает интерфейс, а не то, как это устроено внутри: формы ответов
 * (fail-closed через схемы протокола), обещание `watchThreads` про начальный снапшот и снапшот
 * после каждого изменения, двухступенчатая модель черновиков и семантика вердикта
 * (`docs/design/SPEC-elements.md §4.5`).
 */

export interface ReviewHostContractOptions<H extends ReviewHost> {
    /** Хост умеет запись (черновики, resolve, публикация). Read-only моки чтения — `false`. */
    readonly writes?: boolean;
    /**
     * «Автор запушил»: реализация переводит хост на следующую итерацию (фикстура —
     * `advanceIteration()`, мок Арканума — свой «пуш»). Без хука тесты про смену итерации
     * пропускаются: у хоста с одной итерацией их не на чем проверять.
     */
    readonly advance?: (host: H) => void | Promise<void>;
    /** Ожидаемый логин в `PrMeta.viewer`; не задан — проверяются только общие требования к полю. */
    readonly viewer?: string | null;
    /** Пропустить набор целиком: нужного инструмента нет на машине (живой `git`). */
    readonly skip?: boolean;
    /**
     * Реализация ходит во внешний процесс (живой `git`): каждый вызов — десяток запусков,
     * и потолки времени теста и ожиданий поднимаются.
     */
    readonly slow?: boolean;
}

interface ThreadFeed {
    /** Снапшоты в порядке прихода: контракт обещает первый сразу после подписки. */
    readonly snapshots: Thread[][];
    readonly stop: () => void;
}

function subscribe(host: ReviewHost): ThreadFeed {
    const snapshots: Thread[][] = [];
    const stop = host.watchThreads((threads) => {
        snapshots.push(threads);
    });
    return { snapshots, stop };
}

/** Потолки ожидания сходимости: у хоста поверх внешнего процесса один вызов стоит секунды. */
const WAIT_MS = 2_000;
const SLOW_WAIT_MS = 20_000;

/** Потолок одного теста набора на медленной реализации; на быстрой остаётся вайтестовский. */
const SLOW_TIMEOUT_MS = 60_000;

/**
 * Ждёт выполнения условия: транспорт `watchThreads` — деталь адаптера (у фикстуры синхронно,
 * у Арканума поллинг), контракт обещает только сходимость.
 */
async function waitWithin(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`не дождались: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

interface IterationFeed {
    readonly snapshots: Iteration[][];
    readonly stop: () => void;
}

function subscribeIterations(host: ReviewHost): IterationFeed {
    const snapshots: Iteration[][] = [];
    const stop = host.watchIterations((iterations) => {
        snapshots.push(iterations);
    });
    return { snapshots, stop };
}

function activeOf(iterations: readonly Iteration[]): Iteration {
    const active = iterations.filter((iteration) => iteration.status === 'active');
    if (active.length !== 1 || active[0] === undefined) {
        throw new Error(`активных итераций должно быть ровно одна, а их ${String(active.length)}`);
    }
    return active[0];
}

function lastSnapshot(feed: ThreadFeed): Thread[] {
    const snapshot = feed.snapshots.at(-1);
    if (snapshot === undefined) {
        throw new Error('подписка не прислала ни одного снапшота');
    }
    return snapshot;
}

function findComment(comments: readonly Comment[], id: string): Comment | null {
    for (const comment of comments) {
        if (comment.id === id) {
            return comment;
        }
        const found = findComment(comment.replies, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function findInThreads(threads: readonly Thread[], id: string): Comment | null {
    return findComment(
        threads.map((thread) => thread.root),
        id,
    );
}

function countDraftsIn(comment: Comment): number {
    return comment.replies.reduce((total, reply) => total + countDraftsIn(reply), comment.draft ? 1 : 0);
}

function countDrafts(threads: readonly Thread[]): number {
    return threads.reduce((total, thread) => total + countDraftsIn(thread.root), 0);
}

/**
 * Режим, которым контракт публикует черновики: `comment`, если хост его принимает, иначе первый
 * из `publishVerdicts`; null — публиковать хосту на этом PR нечем.
 */
async function publishingVerdict(host: ReviewHost): Promise<Verdict | null> {
    const { publishVerdicts } = (await host.getPr()).capabilities;
    return publishVerdicts.includes('comment') ? 'comment' : (publishVerdicts[0] ?? null);
}

function commentsOf(comment: Comment): Comment[] {
    return [comment, ...comment.replies.flatMap(commentsOf)];
}

/**
 * Правило хоста с `commentResolve`: тред закрыт, если в нём есть issue и все они закрыты.
 * Здесь оно записано заново, а не взято из адаптера: контракт проверяет обещание, а не его код.
 */
function threadResolvedByRule(thread: Thread): boolean {
    const issues = commentsOf(thread.root).filter((comment) => comment.issue === true);
    return issues.length > 0 && issues.every((comment) => comment.resolved === true);
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Контекстные строки патча с их номерами на новой стороне. */
function patchContextLines(patch: string): { line: number; text: string }[] {
    const found: { line: number; text: string }[] = [];
    let line = 0;

    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            line = Number(header[1]);
            continue;
        }
        if (line === 0) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        if (prefix === '+') {
            line += 1;
        } else if (prefix === ' ') {
            found.push({ line, text: raw.slice(1) });
            line += 1;
        }
    }
    return found;
}

export function describeReviewHostContract<H extends ReviewHost>(
    name: string,
    makeHost: () => H,
    options: ReviewHostContractOptions<H> = {},
): void {
    const writes = options.writes ?? true;
    const advance = options.advance;
    const slow = options.slow ?? false;
    const waitMs = slow ? SLOW_WAIT_MS : WAIT_MS;

    /** Ожидание сходимости с потолком этой реализации. */
    const waitUntil = (condition: () => boolean, what: string): Promise<void> =>
        waitWithin(condition, what, waitMs);

    /**
     * Ждёт, что после мутации подписка прислала **новый** снапшот и в нём видно результат.
     * Рост `snapshots.length` проверяется отдельно: хост, который один раз отдал живую ссылку на свой
     * массив тредов и дальше молча его мутирует, обещание «снапшот при каждом изменении» не выполняет,
     * хотя итоговое состояние в `lastSnapshot` при этом сойдётся.
     */
    const waitFreshSnapshot = (
        feed: ThreadFeed,
        seen: number,
        condition: () => boolean,
        what: string,
    ): Promise<void> => waitUntil(() => feed.snapshots.length > seen && condition(), what);

    const suite = describe.skipIf(options.skip ?? false);
    suite(`контракт ReviewHost: ${name}`, slow ? { timeout: SLOW_TIMEOUT_MS } : {}, () => {
        it('getPr отдаёт валидную шапку PR', async () => {
            const pr = await makeHost().getPr();
            expect(() => prMetaSchema.parse(pr)).not.toThrow();
        });

        it('viewer — личность ревьюера, обязательная при editPublished', async () => {
            const pr = await makeHost().getPr();

            if (pr.viewer !== null) {
                expect(() => reviewUserSchema.parse(pr.viewer)).not.toThrow();
                expect(pr.viewer.login.trim()).not.toBe('');
                expect(pr.viewer.bot).toBe(false);
            }
            // Правка своего опубликованного без личности неработоспособна: «своё» не с чем сверить.
            if (pr.capabilities.editPublished) {
                expect(pr.viewer).not.toBeNull();
            }
            if (options.viewer !== undefined) {
                expect(pr.viewer?.login ?? null).toBe(options.viewer);
            }
        });

        it('getDiff отдаёт валидный дифф с уникальными fileId', async () => {
            const diff = await makeHost().getDiff();
            expect(() => prDiffSchema.parse(diff)).not.toThrow();
            const ids = new Set(diff.files.map((file) => file.fileId));
            expect(ids.size).toBe(diff.files.length);
        });

        it('viewed у файлов согласован с capabilities.fileViewedSync', async () => {
            const host = makeHost();
            const [pr, diff] = await Promise.all([host.getPr(), host.getDiff()]);
            for (const file of diff.files) {
                expect(file.viewed === null).toBe(!pr.capabilities.fileViewedSync);
            }
        });

        it('getSourceAtRevision согласован с capabilities.sourceAtRevision', async () => {
            const host = makeHost();
            expect(typeof host.getSourceAtRevision === 'function').toBe((await host.getPr()).capabilities.sourceAtRevision === true);
        });

        it('getFileContent согласован с capabilities.fileContent', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const getContent = host.getFileContent?.bind(host);

            if (!pr.capabilities.fileContent) {
                expect(getContent).toBeUndefined();
                return;
            }
            if (getContent === undefined) {
                throw new Error('хост объявил fileContent, но не предоставил getFileContent');
            }

            const diff = await host.getDiff();
            const binary = diff.files.find((file) => file.binary);
            if (binary !== undefined) {
                expect(await getContent(binary.fileId)).toBeNull();
            }

            // Текстовый файл с ханками: текст обязан существовать и совпадать с патчем по номерам
            // строк — иначе «Expand context» дорисует контекст не оттуда.
            const text = diff.files.find((file) => !file.binary && file.patch !== null && file.changeType === 'modify');
            if (text?.patch == null) {
                return;
            }

            const content = await getContent(text.fileId);
            if (content === null) {
                throw new Error(`хост не отдал содержимое текстового файла ${text.path}`);
            }
            expect(() => fileContentSchema.parse(content)).not.toThrow();

            const newLines = content.newText?.split('\n') ?? [];
            expect(newLines.length).toBeGreaterThan(0);
            for (const context of patchContextLines(text.patch)) {
                expect(newLines[context.line - 1], `${text.path}:${String(context.line)}`).toBe(context.text);
            }
        });

        it('getBlob согласован с capabilities.blobs', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const getBlob = host.getBlob?.bind(host);

            if (!pr.capabilities.blobs) {
                expect(getBlob).toBeUndefined();
                // Картинки без байтов показывать нечем: такой хост их вовсе не помечает.
                expect((await host.getDiff()).files.every((file) => file.image === null)).toBe(true);
                return;
            }
            if (getBlob === undefined) {
                throw new Error('хост объявил blobs, но не предоставил getBlob');
            }

            expect(await getBlob('no-such-blob')).toBeNull();

            for (const file of (await host.getDiff()).files) {
                if (file.image === null) {
                    continue;
                }
                expect(() => fileImageSchema.parse(file.image)).not.toThrow();
                for (const side of [file.image.before, file.image.after]) {
                    if (side === null) {
                        continue;
                    }
                    const bytes = await getBlob(side.blobId);
                    if (side.size > IMAGE_BLOB_MAX_BYTES) {
                        expect(bytes, `${file.path}: сторона за лимитом`).toBeNull();
                        continue;
                    }
                    if (bytes === null) {
                        throw new Error(`хост не отдал байты стороны картинки ${file.path}`);
                    }
                    expect(bytes.length, `${file.path}: длина байтов против size`).toBe(side.size);
                }
            }
        });

        it('listIterations: ровно одна активная, ни одной gone, время не убывает', async () => {
            const iterations = await makeHost().listIterations();

            expect(iterations.length).toBeGreaterThan(0);
            for (const iteration of iterations) {
                expect(() => iterationSchema.parse(iteration)).not.toThrow();
            }
            // `gone` ставит только сервер, сравнивая список хоста со своим хранилищем.
            expect(iterations.filter((iteration) => iteration.status === 'gone')).toEqual([]);
            expect(activeOf(iterations)).toBeDefined();

            const created = iterations.map((iteration) => iteration.createdAt);
            expect([...created].sort((left, right) => left.localeCompare(right))).toEqual(created);
        });

        it('срез между итерациями согласован с capabilities.iterations', async () => {
            const host = makeHost();
            const [pr, iterations] = await Promise.all([host.getPr(), host.listIterations()]);

            if (!pr.capabilities.iterations) {
                expect(iterations).toHaveLength(1);
                const only = activeOf(iterations).diffId;
                await expect(host.getDiff({ base: only, head: only })).rejects.toThrow();
                return;
            }
            if (iterations.length < 2) {
                return;
            }

            const head = activeOf(iterations);
            const base = iterations.filter((iteration) => iteration.diffId !== head.diffId).at(-1);
            if (base === undefined) {
                throw new Error('в списке не нашлось итерации, отличной от активной');
            }

            const slice = await host.getDiff({ base: base.diffId, head: head.diffId });
            expect(() => prDiffSchema.parse(slice)).not.toThrow();
            expect(slice.diffId).toBe(head.diffId);
            const ids = new Set(slice.files.map((file) => file.fileId));
            expect(ids.size).toBe(slice.files.length);
        });

        // Пути среза сверяются здесь, а не выше: дифф прошлой итерации отдельной ручки не имеет,
        // и единственный способ узнать её файлы через интерфейс — прочитать их до «пуша».
        it.runIf(advance !== undefined)('срез старой и новой итерации: пути из объединения двух', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.iterations) {
                return;
            }

            const before = await host.getDiff();
            await advance?.(host);
            const after = await host.getDiff();

            const slice = await host.getDiff({ base: before.diffId, head: after.diffId });
            expect(() => prDiffSchema.parse(slice)).not.toThrow();
            expect(slice.diffId).toBe(after.diffId);

            const union = new Set([...before.files, ...after.files].map((file) => file.path));
            for (const file of slice.files) {
                expect(union.has(file.path), `${file.path} нет ни в одной из итераций`).toBe(true);
            }
        });

        it('срез с неизвестной итерацией отклоняется, а не отдаёт пустой дифф', async () => {
            const host = makeHost();
            const head = activeOf(await host.listIterations()).diffId;
            await expect(host.getDiff({ base: 'no-such-iteration', head })).rejects.toThrow();
        });

        it('watchIterations присылает начальный список сразу', async () => {
            const host = makeHost();
            const feed = subscribeIterations(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный список итераций');

            const first = feed.snapshots[0] ?? [];
            for (const iteration of first) {
                expect(() => iterationSchema.parse(iteration)).not.toThrow();
            }
            expect(activeOf(first)).toBeDefined();
            feed.stop();
        });

        it.runIf(advance !== undefined)('после пуша приходит список с другой активной итерацией', async () => {
            const host = makeHost();
            const feed = subscribeIterations(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный список итераций');
            const before = activeOf(feed.snapshots[0] ?? []);

            await advance?.(host);
            await waitUntil(
                () =>
                    feed.snapshots.length > 1 &&
                    activeOf(feed.snapshots.at(-1) ?? []).diffId !== before.diffId,
                'список итераций с новой активной',
            );

            const after = activeOf(feed.snapshots.at(-1) ?? []);
            expect(after.diffId).not.toBe(before.diffId);
            expect(() => iterationSchema.parse(after)).not.toThrow();
            feed.stop();
        });

        it.runIf(advance !== undefined)('после пуша дифф и треды — уже новой итерации', async () => {
            const host = makeHost();
            const before = await host.getDiff();

            await advance?.(host);

            const after = await host.getDiff();
            expect(() => prDiffSchema.parse(after)).not.toThrow();
            expect(after.diffId).not.toBe(before.diffId);
            expect(after.diffId).toBe(activeOf(await host.listIterations()).diffId);

            // Содержимое тредов новой итерации — дело реализации; контракт обещает форму.
            for (const thread of await host.getThreads()) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
            }
        });

        it('watchThreads присылает начальный снапшот, валидный по схеме', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');
            for (const thread of lastSnapshot(feed)) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
            }
            feed.stop();
        });

        it('getThreads отдаёт то же состояние, что начальный снапшот подписки', async () => {
            const host = makeHost();
            const threads = await host.getThreads();
            for (const thread of threads) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
            }
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');
            expect(threads).toEqual(feed.snapshots[0]);
            feed.stop();
        });

        it('линзы валидны по схеме, зоны ссылаются только на файлы диффа без дублей', async () => {
            const host = makeHost();
            const [diff, ownership, extra] = await Promise.all([
                host.getDiff(),
                host.ownershipLens(),
                host.extraLenses(),
            ]);
            if (ownership !== null) {
                expect(host.ownershipSource, 'у ownership-линзы есть имя источника зон').not.toBeNull();
            }
            const lenses = ownership === null ? extra : [ownership, ...extra];
            const diffPaths = new Set(diff.files.map((file) => file.path));

            for (const lens of lenses) {
                expect(() => lensSchema.parse(lens)).not.toThrow();
                const zonedPaths = new Set<string>();
                for (const zone of lens.zones ?? []) {
                    expect(zone.paths.length).toBeGreaterThan(0);
                    for (const path of zone.paths) {
                        expect(diffPaths.has(path), `${lens.id}: неизвестный путь зоны ${path}`).toBe(true);
                        expect(zonedPaths.has(path), `${lens.id}: путь ${path} попал в две зоны`).toBe(false);
                        zonedPaths.add(path);
                    }
                }
            }
        });

        it.runIf(writes)('цикл черновика: сохранение, правка, удаление', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            const supportsIssues = (await host.getPr()).capabilities.commentIssues;
            let seen = feed.snapshots.length;
            const created = await host.saveDraft({
                body: 'contract draft',
                parentId: null,
                anchor: null,
                ...(supportsIssues ? { issue: true } : {}),
            });
            expect(created.draft).toBe(true);
            // `null` — только у хоста без issue: где они есть, «не знаю» непредставимо, и UI
            // рисует выключенный переключатель вместо того, чтобы его прятать.
            expect(created.issue).toBe(supportsIssues ? true : null);

            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) !== null,
                'черновик в новом снапшоте тредов',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.draft).toBe(true);
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(false);

            seen = feed.snapshots.length;
            if (supportsIssues) {
                await host.updateDraft(created.id, 'contract draft, edited', false);
            } else {
                await host.updateDraft(created.id, 'contract draft, edited');
            }
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id)?.body === 'contract draft, edited',
                'правку черновика в новом снапшоте',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.issue).toBe(supportsIssues ? false : null);

            // Issue-статус правится и у ответа, не только у корня треда.
            seen = feed.snapshots.length;
            const reply = await host.saveDraft({ body: 'contract reply draft', parentId: created.id, anchor: null });
            if (supportsIssues) {
                await host.updateDraft(reply.id, 'contract reply draft, edited', true);
                await waitFreshSnapshot(
                    feed,
                    seen,
                    () => findInThreads(lastSnapshot(feed), reply.id)?.issue === true,
                    'issue ответа в новом снапшоте',
                );
            }
            await host.deleteDraft(reply.id);

            seen = feed.snapshots.length;
            await host.deleteDraft(created.id);
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) === null,
                'исчезновение черновика в новом снапшоте',
            );

            feed.stop();
        });

        // Повтор записи из буфера черновиков уходит с ключом первой попытки: хост
        // обязан принимать параметр, даже если сам о дублях не заботится (фикстура).
        it.runIf(writes)('saveDraft принимает ключ идемпотентности', async () => {
            const host = makeHost();
            const idempotencyKey = 'contract-idempotency-key';

            const created = await host.saveDraft(
                { body: 'contract idempotency', parentId: null, anchor: null },
                { idempotencyKey },
            );
            expect(created.draft).toBe(true);

            const repeated = await host.saveDraft(
                { body: 'contract idempotency', parentId: null, anchor: null },
                { idempotencyKey },
            );
            expect(repeated.draft).toBe(true);

            await host.deleteDraft(created.id);
            if (repeated.id !== created.id) {
                await host.deleteDraft(repeated.id);
            }
        });

        it.runIf(writes)('ответ через parentId попадает в дерево ответов', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            let seen = feed.snapshots.length;
            const root = await host.saveDraft({ body: 'contract root', parentId: null, anchor: null });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), root.id) !== null,
                'корень треда в новом снапшоте',
            );

            seen = feed.snapshots.length;
            const reply = await host.saveDraft({ body: 'contract reply', parentId: root.id, anchor: null });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), reply.id) !== null,
                'ответ в новом снапшоте',
            );
            const storedRoot = findInThreads(lastSnapshot(feed), root.id);
            expect(storedRoot?.replies.map((child) => child.id)).toContain(reply.id);

            feed.stop();
        });

        it.runIf(writes)('unsubscribe останавливает поток снапшотов', async () => {
            const host = makeHost();
            const stopped = subscribe(host);
            // Вторая подписка — маркер доставки. Без неё «остановленная не получила ничего» значит
            // только «обновление ещё не доехало»: у поллингового хоста интервал больше любого
            // фиксированного ожидания в тесте.
            const control = subscribe(host);
            await waitUntil(
                () => stopped.snapshots.length > 0 && control.snapshots.length > 0,
                'начальные снапшоты обеих подписок',
            );

            stopped.stop();
            const stoppedSeen = stopped.snapshots.length;
            const controlSeen = control.snapshots.length;

            const created = await host.saveDraft({ body: 'after unsubscribe', parentId: null, anchor: null });
            await waitFreshSnapshot(
                control,
                controlSeen,
                () => findInThreads(lastSnapshot(control), created.id) !== null,
                'черновик в контрольной подписке',
            );
            expect(stopped.snapshots.length).toBe(stoppedSeen);

            control.stop();
        });

        it.runIf(writes)('resolve треда виден в следующем снапшоте', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            const target = lastSnapshot(feed).find((thread) => !thread.resolved);
            if (target === undefined) {
                feed.stop();
                return;
            }

            const seen = feed.snapshots.length;
            await host.setThreadResolved(target.id, true);
            await waitFreshSnapshot(
                feed,
                seen,
                () => lastSnapshot(feed).find((thread) => thread.id === target.id)?.resolved === true,
                'resolved в новом снапшоте',
            );

            feed.stop();
        });

        it('setCommentResolved согласован с capabilities.commentResolve', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const setResolved = host.setCommentResolved?.bind(host);

            if (!pr.capabilities.commentResolve) {
                expect(setResolved).toBeUndefined();
            } else if (setResolved === undefined) {
                throw new Error('хост объявил commentResolve, но не предоставил setCommentResolved');
            }

            for (const thread of await host.getThreads()) {
                for (const comment of commentsOf(thread.root)) {
                    // `null` — только у хоста без резолва по комментарию: где он есть,
                    // «не знаю» непредставимо, как и у `issue`.
                    expect(comment.resolved === null, `${comment.id}: resolved против capabilities`).toBe(
                        !pr.capabilities.commentResolve,
                    );
                }
                if (pr.capabilities.commentResolve) {
                    expect(thread.resolved, `тред ${thread.id}: resolved против правила`).toBe(
                        threadResolvedByRule(thread),
                    );
                }
            }
        });

        it('updateComment и deleteComment согласованы с capabilities.editPublished', async () => {
            const host = makeHost();
            const pr = await host.getPr();

            const update = host.updateComment?.bind(host);
            const remove = host.deleteComment?.bind(host);

            if (pr.capabilities.editPublished) {
                if (update === undefined || remove === undefined) {
                    throw new Error('хост объявил editPublished, но не предоставил правку или удаление');
                }
                return;
            }
            expect(update).toBeUndefined();
            expect(remove).toBeUndefined();
        });

        it.runIf(writes)('resolve комментария закрывает и его, и тред', async () => {
            const host = makeHost();
            const setResolved = host.setCommentResolved?.bind(host);
            if (setResolved === undefined || !(await host.getPr()).capabilities.commentIssues) {
                return;
            }

            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            const seen = feed.snapshots.length;
            const created = await host.saveDraft({
                body: 'contract issue',
                parentId: null,
                anchor: null,
                issue: true,
            });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) !== null,
                'issue-комментарий в новом снапшоте',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.resolved).toBe(false);
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(false);

            const afterCreate = feed.snapshots.length;
            await setResolved(created.id, true);
            await waitFreshSnapshot(
                feed,
                afterCreate,
                () => findInThreads(lastSnapshot(feed), created.id)?.resolved === true,
                'закрытый issue в новом снапшоте',
            );
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(true);

            feed.stop();
        });

        it.runIf(writes)('ответ тоже может открывать issue', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.commentIssues) {
                return;
            }

            const root = await host.saveDraft({ body: 'contract issue root', parentId: null, anchor: null });
            const reply = await host.saveDraft({
                body: 'contract issue reply',
                parentId: root.id,
                anchor: null,
                issue: true,
            });
            expect(reply.issue).toBe(true);
            expect(findInThreads(await host.getThreads(), reply.id)?.issue).toBe(true);
        });

        it.runIf(writes)('опубликованный комментарий правится и удаляется', async () => {
            const host = makeHost();
            const updateComment = host.updateComment?.bind(host);
            const deleteComment = host.deleteComment?.bind(host);
            const verdict = await publishingVerdict(host);
            if (updateComment === undefined || deleteComment === undefined || verdict === null) {
                return;
            }

            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            const draft = await host.saveDraft({ body: 'contract published', parentId: null, anchor: null });
            const published = await host.publishBatch(verdict);
            expect(published.failed).toEqual([]);
            await waitUntil(
                () => findInThreads(lastSnapshot(feed), draft.id)?.draft === false,
                'опубликованный комментарий в снапшоте',
            );

            let seen = feed.snapshots.length;
            await updateComment(draft.id, 'contract published, edited');
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id)?.body === 'contract published, edited',
                'правку опубликованного в новом снапшоте',
            );

            seen = feed.snapshots.length;
            await deleteComment(draft.id);
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id) === null,
                'исчезновение опубликованного в новом снапшоте',
            );

            feed.stop();
        });

        it.runIf(writes)('publishBatch публикует черновики пакетом', async () => {
            const host = makeHost();
            const verdict = await publishingVerdict(host);
            if (verdict === null) {
                return;
            }
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'начальный снапшот тредов');

            const draft = await host.saveDraft({ body: 'contract publish', parentId: null, anchor: null });
            const seen = feed.snapshots.length;
            const result = await host.publishBatch(verdict);

            expect(result.failed).toEqual([]);
            expect(result.publishedCommentIds).toContain(draft.id);
            expect(result.verdictApplied).toBe(true);

            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id)?.draft === false,
                'опубликованный комментарий в новом снапшоте',
            );

            // После полной публикации черновиков не остаётся вовсе.
            expect(countDrafts(lastSnapshot(feed))).toBe(0);

            feed.stop();
        });

        it('publishVerdicts без повторов', async () => {
            const { publishVerdicts } = (await makeHost().getPr()).capabilities;
            expect(new Set(publishVerdicts).size).toBe(publishVerdicts.length);
        });

        it.runIf(writes)('вердикт вне publishVerdicts отклоняется, черновики остаются черновиками', async () => {
            const host = makeHost();
            const { publishVerdicts } = (await host.getPr()).capabilities;
            const outside = verdictSchema.options.filter((verdict) => !publishVerdicts.includes(verdict));
            if (outside.length === 0) {
                return;
            }

            const draft = await host.saveDraft({ body: 'contract refused', parentId: null, anchor: null });
            for (const verdict of outside) {
                await expect(host.publishBatch(verdict), verdict).rejects.toThrow();
            }
            expect(findInThreads(await host.getThreads(), draft.id)?.draft).toBe(true);
        });

        it.runIf(writes)('comment без черновиков ничего не делает', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.publishVerdicts.includes('comment')) {
                return;
            }
            // Черновики из данных хоста уходят заранее: проверяем именно пустой пакет.
            if (countDrafts(await host.getThreads()) > 0) {
                await host.publishBatch('comment');
            }
            const before = await host.getThreads();
            expect(countDrafts(before)).toBe(0);

            expect(await host.publishBatch('comment')).toEqual({
                publishedCommentIds: [],
                failed: [],
                verdictApplied: true,
            });
            expect(await host.getThreads()).toEqual(before);
        });

        it.runIf(writes)('каждый вердикт из publishVerdicts публикует черновик и применяется', async () => {
            const { publishVerdicts } = (await makeHost().getPr()).capabilities;
            for (const verdict of publishVerdicts.filter((candidate) => candidate !== 'comment')) {
                const host = makeHost();
                const draft = await host.saveDraft({ body: `contract ${verdict}`, parentId: null, anchor: null });

                const result = await host.publishBatch(verdict);

                expect(result.failed, verdict).toEqual([]);
                expect(result.publishedCommentIds, verdict).toContain(draft.id);
                expect(result.verdictApplied, verdict).toBe(true);
            }
        });

        it.runIf(writes)('setFileViewed отражается в следующем getDiff', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const setViewed = host.setFileViewed?.bind(host);

            if (!pr.capabilities.fileViewedSync) {
                expect(setViewed).toBeUndefined();
                return;
            }
            if (setViewed === undefined) {
                throw new Error('хост объявил fileViewedSync, но не предоставил setFileViewed');
            }

            const before = await host.getDiff();
            const file = before.files.find((candidate) => candidate.viewed === false);
            if (file === undefined) {
                return;
            }

            await setViewed(file.fileId, true);
            const after = await host.getDiff();
            expect(after.files.find((candidate) => candidate.fileId === file.fileId)?.viewed).toBe(true);
        });
    });
}
