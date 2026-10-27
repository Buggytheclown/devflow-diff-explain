import http from 'node:http';
import { hostname } from 'node:os';

import type { ServerManifest } from '@sherpa/protocol';
import { LONG_POLL_DEFAULT_SECONDS, PROTOCOL_VERSION } from '@sherpa/protocol';

import { createToken } from './auth.js';
import { BlobCache } from './blob-cache.js';
import { ChatOrchestrator } from './chat-orchestrator.js';
import { createChatRoutes } from './chat-routes.js';
import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { createDevRoutes } from './dev-routes.js';
import { ServerAlreadyRunningError } from './errors.js';
import type { ReviewSourceFactory } from './hosts/select.js';
import { selectReviewSource } from './hosts/select.js';
import type { RequestListenerOptions, Route } from './http.js';
import { createRequestListener } from './http.js';
import { DEFAULT_IDLE_SECONDS, IdleWatch } from './idle.js';
import { IterationFeed } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { DEFAULT_LISTEN_HOST, uiHostForListenHost } from './listen-host.js';
import {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
import {
    assertValidPrKey,
    blobsDirOf,
    chatPayloadDirOf,
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    ensurePrivateDir,
    manifestPathFor,
    prStateDirOf,
    routePayloadDirOf,
    serversDirOf,
    sharedPayloadDirOf,
    workerIdPathFor,
} from './paths.js';
import { PrMetaCache } from './pr-meta.js';
import { TaskQueue } from './queue.js';
import { createReadRoutes } from './read-routes.js';
import { RouteOrchestrator } from './route-orchestrator.js';
import { createRouteRoutes } from './route-routes.js';
import { RouteStore } from './route-store.js';
import { createSettingsRoutes } from './settings-routes.js';
import { SettingsStore } from './settings-store.js';
import { holdsPayload, SharedPayloadStore } from './shared-payload.js';
import type { StaticAssets } from './static.js';
import { withDocumentSettings } from './ui-document.js';
import { UiPresence } from './ui-presence.js';
import { createUiRoutes } from './ui-routes.js';
import { SERVER_VERSION } from './version.js';
import { writeWorkerIdFile } from './worker-id-file.js';
import { WorkerRegistry } from './worker-registry.js';
import { createWorkerRoutes } from './worker-routes.js';

export interface StartServerOptions {
    /** Служебные задачи для локальной разработки; на фикстурах включены автоматически. */
    development?: boolean;
    /** Ключ PR вида `<host>-<pr>`: имя манифеста и каталога стейта. */
    prKey: string;
    /** Корень стейта; по умолчанию `~/.sherpa`. */
    sherpaDir?: string;
    /** Адрес TCP-прослушивания; по умолчанию локальный IPv4 loopback. */
    host?: string;
    /** Окно long-poll `worker next`; по умолчанию — `LONG_POLL_DEFAULT_SECONDS`. В тестах сокращается. */
    longPollSeconds?: number;
    /** Источник статики UI (каталог сборки или карта, зашитая в бандл); задан — раздаётся без токена. */
    assets?: StaticAssets;
    /**
     * Инжектируемые часы очереди, жизненного цикла воркера и учёта простоя; по умолчанию системные.
     * Тестам нужен способ пережить `WORKER_DEAD_AFTER_SECONDS` и TTL аренды, не ожидая минут.
     */
    now?: () => Date;
    /**
     * Простой, после которого сервер останавливается сам (`DEFAULT_IDLE_SECONDS`); `0` — не гаснуть.
     * Внутренняя политика демона, не часть контракта: CLI и UI о ней не знают.
     */
    idleSeconds?: number;
    /**
     * Причина самоостановки — до штатной остановки: точка входа пишет её в лог,
     * который переживёт процесс.
     */
    onIdleStop?: (idleSeconds: number) => void;
    /**
     * Грейс паузы между воркерскими вызовами (`WORKER_GAP_GRACE_SECONDS`): столько сессия без
     * открытого соединения и без аренды считается живой. Внутренняя политика, в тестах сокращается.
     */
    workerGapGraceSeconds?: number;
    /** Грейс ухода UI; контрактный дефолт меняется только в серверных тестах. */
    uiGoneGraceSeconds?: number;
    /** Источник кода для объяснения; методов записи и чтения тредов не требует. */
    reviewSourceFactory?: ReviewSourceFactory;
    /**
     * Каталог проекта локального ревью (`--repo`), база сравнения (`--base`) и ветка, на которой
     * CLI построил ключ (`--branch`): нужны только локальным ключам `local-*`. Без них локальный хост
     * поднимается на состоянии, сохранённом прошлым запуском.
     */
    repo?: string;
    base?: string;
    branch?: string;
}

export interface SherpaServer {
    readonly port: number;
    readonly token: string;
    readonly prKey: string;
    /** Имя или адрес в ссылке UI; то же значение лежит в манифесте. */
    readonly uiHost: string;
    /** Очередь этого PR: ею пользуются ручки UI и тесты, пока UI-канала нет. */
    readonly queue: TaskQueue;
    /** Жизненный цикл воркера этого PR: статус и события «подключился / отключился» для UI. */
    readonly workerRegistry: WorkerRegistry;
    /** Автомат маршрута этого PR: им пользуется ручка `generate`, прогрев и тесты. */
    readonly route: RouteOrchestrator;
    /** Оркестрация вопросов этого PR: ручки чата и тесты жизненного цикла. */
    readonly chat: ChatOrchestrator;
    /** Снимает манифест, закрывает порт и хранилище. Повторный вызов — no-op. */
    close: () => Promise<void>;
}

/** Ответ `/healthz`: им же проверяется живость чужого сервера при discovery. */
export interface HealthResponse {
    readonly ok: true;
    readonly prKey: string;
    readonly pid: number;
    readonly serverVersion: string;
    readonly protocolVersion: string;
}

/** Сколько раз пробуем занять манифест, если по пути висит протухший: каждая попытка снимает один. */
const CLAIM_ATTEMPTS = 5;

/**
 * Поднимает сервер PR на настроенном адресе (по умолчанию 127.0.0.1), случайный порт, bearer-токен на всех ручках,
 * манифест discovery в `<sherpaDir>/servers/<prKey>.json` (docs/protocol.md §2, §8).
 * Если сервер того же PR уже жив — кидает `ServerAlreadyRunningError`, второй процесс не поднимается.
 */
export async function startServer(options: StartServerOptions): Promise<SherpaServer> {
    const prKey = assertValidPrKey(options.prKey);
    const sherpaDir = options.sherpaDir ?? DEFAULT_SHERPA_DIR;
    const host = options.host ?? DEFAULT_LISTEN_HOST;
    // Ссылка на `[::]` мертва, поэтому внешний слушатель показывает в UI имя машины.
    const uiHost = uiHostForListenHost(host, hostname());
    const serversDir = serversDirOf(sherpaDir);
    const manifestPath = manifestPathFor(sherpaDir, prKey);

    await ensurePrivateDir(sherpaDir, serversDir);
    await cleanStaleManifests(serversDir);

    const token = createToken();
    // Настройки общие для PR; index.html сразу получает сохранённую тему.
    const settingsStore = new SettingsStore(sherpaDir);
    // Воркерские ручки появляются в этом же массиве после открытия БД: до заявки на манифест
    // сервер обязан отвечать только на `/healthz` — им конкурент проверяет нашу живость.
    const routes: Route[] = [healthRoute(prKey)];
    const idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    const idleWatch = new IdleWatch(
        options.now === undefined ? { idleSeconds } : { idleSeconds, now: options.now },
    );
    // Пока набор роутов не собран, не совпавший запрос ждёт этот сигнал, а не получает 404:
    // манифест публикуется раньше воркерских ручек, и вызов по свежему манифесту имеет право прийти
    // в этот промежуток. Сигнал даётся и на неудачном старте — иначе ожидающие висели бы до обрыва.
    let markRoutesReady!: () => void;
    const routesReady = new Promise<void>((resolve) => {
        markRoutesReady = resolve;
    });
    const listenerOptions: RequestListenerOptions = {
        token,
        routes,
        activity: idleWatch,
        ready: routesReady,
        ...(options.assets === undefined
            ? {}
            : { assets: withDocumentSettings(options.assets, () => settingsStore.read()) }),
    };
    const httpServer = http.createServer(createRequestListener(listenerOptions));
    const shutdownController = new AbortController();
    let claimed: ServerManifest | null = null;
    let db: SherpaDatabase | null = null;

    try {
        // Слушаем до заявки на манифест: как только манифест опубликован, конкурент имеет право
        // проверить нас через `/healthz` и должен получить ответ.
        const port = await listen(httpServer, host);
        claimed = await claimPr({
            prKey,
            manifestPath,
            manifest: {
                prKey,
                port,
                uiHost,
                pid: process.pid,
                token,
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
                createdAt: new Date().toISOString(),
            },
        });

        await ensurePrivateDir(sherpaDir, prStateDirOf(sherpaDir, prKey));
        db = openDatabase(databasePathFor(sherpaDir, prKey));
        const workerIdPath = workerIdPathFor(sherpaDir, prKey);

        const queue = new TaskQueue(options.now === undefined ? { db } : { db, now: options.now });
        const workerRegistry = new WorkerRegistry({
            db,
            leaseExpiryOf: (workerId) => queue.leaseExpiryOf(workerId),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.workerGapGraceSeconds === undefined
                ? {}
                : { gapGraceSeconds: options.workerGapGraceSeconds }),
        });
        const uiPresence = new UiPresence({
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.uiGoneGraceSeconds === undefined ? {} : { graceSeconds: options.uiGoneGraceSeconds }),
        });
        // Аренда — одно из оснований живости, поэтому её появление и пропажу регистр должен видеть:
        // иначе после отмены задачи момент смерти воркера остался бы посчитанным по старому.
        const unsubscribeQueue = queue.subscribeChanges(() => {
            workerRegistry.checkNow();
        });
        // Локальные патчи итераций и кэш срезов: наполняется отовсюду, где грузится дифф.
        const iterationStore = new IterationStore(options.now === undefined ? { db } : { db, now: options.now });
        const source = (options.reviewSourceFactory ?? selectReviewSource)(prKey, {
            sherpaDir, repo: options.repo ?? null, base: options.base ?? null, branch: options.branch ?? null,
        });
        const advanceIteration = source?.advanceIteration;
        const prMeta = new PrMetaCache({ host: source?.host ?? null });
        // Без источника диффа объяснение остаётся в фазе `none`.
        const routeStore = new RouteStore(options.now === undefined ? { db } : { db, now: options.now });
        {
            for (const task of queue.listTasks()) {
                const open = task.status === 'queued' || task.status === 'leased';
                if (open && (task.type === 'review.feedback' ||
                    (task.type.startsWith('route.') && routeStore.generationPresentation() !== 'story'))) queue.cancel(task.id);
            }
            if (routeStore.generationPresentation() !== 'story') {
                routeStore.clearBindings();
                routeStore.reset();
                routeStore.setGenerationPresentation('story');
            }
        }
        // Старые заметки остаются в БД; объяснение создаёт только сообщения чата.
        const chatStore = new ChatStore({ db, createNotes: false, ...(options.now === undefined ? {} : { now: options.now }) });
        // Итерации PR: один вотчер на сервер — из него растут `uiState.iterations` и `stale`.
        const iterationFeed =
            source === null
                ? null
                : new IterationFeed({
                      host: source.host,
                      iterations: iterationStore,
                      route: routeStore,
                  });
        // Общий контекст переживает рестарт вместе с задачами: и чистка на старте, и чистка при
        // смене ключа оставляют дифф, на который ещё ссылается открытая или удерживаемая задача.
        const sharedPayload = new SharedPayloadStore(sharedPayloadDirOf(sherpaDir, prKey), () =>
            queue.listTasks().flatMap((task) => (holdsPayload(task) ? task.contextFiles : [])),
        );
        sharedPayload.sweepDiffKeys();
        const routeOrchestrator = new RouteOrchestrator({
            store: routeStore,
            queue,
            registry: workerRegistry,
            host: source?.host ?? null,
            payloadDir: routePayloadDirOf(sherpaDir, prKey),
            shared: sharedPayload,
            iterations: iterationStore,
            // Язык генерации: настройки — вторая ступень лестницы после запроса вкладки.
            settings: settingsStore,
        });
        const chatOrchestrator = new ChatOrchestrator({
            store: chatStore,
            route: routeStore,
            queue,
            host: source?.host ?? null,
            payloadDir: chatPayloadDirOf(sherpaDir, prKey),
            iterations: iterationStore,
            iterationFeed,
            shared: sharedPayload,
            settings: settingsStore,
            registry: workerRegistry,
        });
        queue.setResultAcceptor(
            (task, result) =>
                routeOrchestrator.acceptResult(task, result) ??
                chatOrchestrator.acceptResult(task, result) ??
                null,
        );

        routes.push(
            ...createWorkerRoutes({
                queue,
                registry: workerRegistry,
                presence: uiPresence,
                longPollSeconds: options.longPollSeconds ?? LONG_POLL_DEFAULT_SECONDS,
                shutdownSignal: shutdownController.signal,
                publishWorkerId: (workerId) => {
                    writeWorkerIdFile(workerIdPath, workerId);
                },
            }),
            ...createUiRoutes({
                prKey,
                queue,
                registry: workerRegistry,
                reviewHost: source?.name ?? null,
                iterationFeed,
                prMeta,
                development: options.development ?? source?.name === 'fixture',
                route: routeStore,
                chat: chatStore,
                presence: uiPresence,
                shutdownSignal: shutdownController.signal,
            }),
            ...createReadRoutes({
                host: source?.host ?? null, prMeta, iterations: iterationStore, iterationFeed,
                blobs: new BlobCache(sherpaDir, blobsDirOf(sherpaDir, prKey)),
            }),
            // Настройки глобальные: ручка не зависит ни от ревью-хоста, ни от стейта этого PR.
            ...createSettingsRoutes({
                settings: settingsStore,
            }),
            ...createRouteRoutes({ store: routeStore, orchestrator: routeOrchestrator, iterationFeed }),
            ...createChatRoutes({ store: chatStore, orchestrator: chatOrchestrator }),
            // Дев-ручки есть только у фикстурного хоста; у остальных этих маршрутов не существует.
            ...(advanceIteration === undefined
                ? []
                : createDevRoutes({
                      advanceIteration,
                  })),
        );
        markRoutesReady();

        const handle = createHandle({
            manifest: claimed,
            uiHost,
            manifestPath,
            httpServer,
            db,
            queue,
            workerRegistry,
            uiPresence,
            unsubscribeQueue,
            shutdownController,
            idleWatch,
            iterationFeed,
            prMeta,
            routeStore,
            routeOrchestrator,
            chatStore,
            chatOrchestrator,
        });
        // Прогрев маршрута — после сборки handle и своим таймером: старт сервера не ждёт `getDiff()`,
        // иначе «дифф на экране меньше двух секунд» уехало бы за сетевой вызов хоста.
        routeOrchestrator.start();
        chatOrchestrator.start();
        // Мета PR грузится тем же фоном: снапшот отдаётся сразу, мета доезжает по SSE.
        prMeta.start();
        // Взводим самоостановку последним: раньше этого момента останавливать нечего.
        idleWatch.arm(() => {
            options.onIdleStop?.(idleSeconds);
            void handle.close().catch((error: unknown) => {
                process.stderr.write(`sherpa-server: ошибка при самоостановке: ${messageOf(error)}\n`);
            });
        });
        return handle;
    } catch (error) {
        markRoutesReady();
        idleWatch.close();
        shutdownController.abort();
        if (claimed !== null) {
            await removeOwnManifest(manifestPath, claimed);
        }
        await shutdown(httpServer, db);
        throw error;
    }
}

/**
 * Занимает единственное место сервера этого PR. Заявка и проверка «а не занято ли» — одна
 * атомарная операция создания манифеста, поэтому одновременный старт двух серверов даёт
 * ровно одного победителя, а проигравший получает `ServerAlreadyRunningError`.
 */
async function claimPr(parts: {
    prKey: string;
    manifestPath: string;
    manifest: ServerManifest;
}): Promise<ServerManifest> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
        if (await claimManifest(parts.manifestPath, parts.manifest)) {
            return parts.manifest;
        }

        const existing = await readManifest(parts.manifestPath);
        if (existing !== null && (await isManifestServerAlive(existing))) {
            throw new ServerAlreadyRunningError({
                prKey: parts.prKey,
                port: existing.port,
                pid: existing.pid,
            });
        }
        await releaseStaleManifest(parts.manifestPath, existing);
    }

    throw new Error(
        `Не удалось занять манифест PR ${parts.prKey}: за ${String(CLAIM_ATTEMPTS)} попыток его каждый раз ` +
            'перехватывал другой процесс.',
    );
}

function healthRoute(prKey: string): Route {
    return {
        method: 'GET',
        path: '/healthz',
        handle: () => {
            const body: HealthResponse = {
                ok: true,
                prKey,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                protocolVersion: PROTOCOL_VERSION,
            };
            return { status: 200, body };
        },
    };
}

function createHandle(parts: {
    manifest: ServerManifest;
    uiHost: string;
    manifestPath: string;
    httpServer: http.Server;
    db: SherpaDatabase;
    queue: TaskQueue;
    workerRegistry: WorkerRegistry;
    uiPresence: UiPresence;
    unsubscribeQueue: () => void;
    shutdownController: AbortController;
    idleWatch: IdleWatch;
    iterationFeed: IterationFeed | null;
    prMeta: PrMetaCache;
    routeStore: RouteStore;
    routeOrchestrator: RouteOrchestrator;
    chatStore: ChatStore;
    chatOrchestrator: ChatOrchestrator;
}): SherpaServer {
    let closing: Promise<void> | null = null;

    return {
        port: parts.manifest.port,
        token: parts.manifest.token,
        prKey: parts.manifest.prKey,
        uiHost: parts.uiHost,
        queue: parts.queue,
        workerRegistry: parts.workerRegistry,
        route: parts.routeOrchestrator,
        chat: parts.chatOrchestrator,
        close: () => {
            closing ??= (async () => {
                // Таймер простоя гасим первым: остановка уже идёт, второй раз её звать незачем.
                parts.idleWatch.close();
                // Сначала обрываем висящие long-poll'ы, иначе они попробуют дописать в закрытые сокеты.
                parts.shutdownController.abort();
                // Отписка от очереди и таймер смерти воркера — до закрытия хранилища:
                // после close() читать из него некому и незачем.
                parts.unsubscribeQueue();
                parts.workerRegistry.close();
                parts.uiPresence.close();
                // Поллинг хоста гасим здесь же: без него подписка пережила бы закрытие сервера.

                parts.iterationFeed?.close();
                // Ретрай загрузки меты не должен проснуться после остановки сервера.
                parts.prMeta.close();
                // Автомат маршрута гасим до закрытия хранилища: его отложенный прогрев не должен
                // проснуться над закрытой БД.
                parts.routeOrchestrator.close();
                parts.routeStore.close();
                parts.chatOrchestrator.close();
                parts.chatStore.close();

                await removeOwnManifest(parts.manifestPath, parts.manifest);
                await shutdown(parts.httpServer, parts.db);
            })();
            return closing;
        },
    };
}

async function shutdown(httpServer: http.Server, db: SherpaDatabase | null): Promise<void> {
    if (httpServer.listening) {
        // Иначе close() ждёт, пока отвиснут keep-alive соединения long-poll'а.
        httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
    db?.close();
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function listen(httpServer: http.Server, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            reject(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(0, host, () => {
            httpServer.removeListener('error', onError);
            resolve();
        });
    });

    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Сервер слушает не TCP-порт — такого быть не должно.');
    }
    return address.port;
}
