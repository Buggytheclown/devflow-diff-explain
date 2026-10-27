/**
 * Локальный сервер Шерпы (docs/architecture.md §1): discovery-манифест, bearer-аутентификация, хранилище,
 * очередь с арендой, воркерские ручки и канал UI (REST + SSE, раздача собранного UI).
 */
export { createToken, extractBearerToken, tokenMatches } from './auth.js';
export type { SherpaDatabase } from './db.js';
export { applyMigrations, openDatabase, readSchemaVersion, transaction } from './db.js';
export { RpcFailure, ServerAlreadyRunningError } from './errors.js';
export type {
    JsonResponse,
    JsonRoute,
    RequestContext,
    RequestListenerOptions,
    Route,
    RouteAuth,
    RouteHandler,
    StreamContext,
    StreamHandler,
    StreamRoute,
} from './http.js';
export {
    abortOnDisconnect,
    createRequestListener,
    handlingRpcFailures,
    readJsonBody,
    REQUEST_BODY_MAX_BYTES,
    rpcError,
    rpcFailureResponse,
} from './http.js';
export type { ArcanumHostOptions } from './hosts/arcanum/arcanum-host.js';
export { ArcanumHost, makeArcanumHost } from './hosts/arcanum/arcanum-host.js';
export type { ArcanumClientOptions, FetchLike } from './hosts/arcanum/client.js';
export { ARCANUM_API_BASE, ArcanumClient } from './hosts/arcanum/client.js';
export type { ArcTokenOptions, TokenSource } from './hosts/arcanum/token.js';
export { arcTokenSource, resolveArcToken } from './hosts/arcanum/token.js';
export type { ReviewSourceFactory, SelectedSource } from './hosts/select.js';
export { selectReviewSource } from './hosts/select.js';
export { affectedStops, buildIterationMap, classifyStop, identityMap } from './iterations/index.js';
export type { FileStatus, IterationMap, IterationMapInput, MappedRange, StopChangeKind } from './iterations/index.js';
export {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    isProcessAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
export type { IterationStoreOptions, StoredIteration } from './iteration-store.js';
export { IterationStore, rememberIterationDiff } from './iteration-store.js';
export type { Migration } from './migrations.js';
export { MIGRATIONS, SCHEMA_VERSION_KEY } from './migrations.js';
export {
    assertValidPrKey,
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    manifestPathFor,
    prStateDirOf,
    serversDirOf,
} from './paths.js';
export type { PrMetaCacheOptions } from './pr-meta.js';
export { PrMetaCache } from './pr-meta.js';
export type {
    CancelOutcome,
    EnqueueInput,
    LeasedTask,
    TaskQueueOptions,
    TaskRecord,
    TaskResultAcceptance,
    TaskResultAcceptor,
} from './queue.js';
export { MAX_RESULT_REJECTIONS, TaskQueue } from './queue.js';
export type { RouteOrchestratorOptions } from './route-orchestrator.js';
export { RouteOrchestrator } from './route-orchestrator.js';
export type { RouteRoutesOptions } from './route-routes.js';
export { createRouteRoutes } from './route-routes.js';
export type { AcceptedSkeletonInput, RouteListener, RouteStoreOptions } from './route-store.js';
export { contentHashOf, RouteStore } from './route-store.js';
export type { HealthResponse, SherpaServer, StartServerOptions } from './server.js';
export { startServer } from './server.js';
export type { StaticAsset, StaticAssets } from './static.js';
export { bundledAssets, contentTypeOf, directoryAssets, isStaticPath, serveStatic } from './static.js';
export type { PrMetaSource, UiRoutesOptions } from './ui-routes.js';
export { createUiRoutes } from './ui-routes.js';
export { SERVER_VERSION } from './version.js';
export type { WorkerRegistryOptions, WorkerStatusListener } from './worker-registry.js';
export { WorkerRegistry } from './worker-registry.js';
export type { WorkerRoutesOptions } from './worker-routes.js';
export { createWorkerRoutes } from './worker-routes.js';
