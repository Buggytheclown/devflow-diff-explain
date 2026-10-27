import type { ChatExchange, ChatExplanation, FileContent, Locale, PrDiff, PriorityClass, UiCancelResponse, UiChatAskAnchor, UiChatAskRequest, UiChatCancelResponse, UiChatResponse, UiChatRetryResponse, UiEnqueueResponse, UiRouteFillStopRequest, UiRouteFillStopResponse, UiRouteGenerateRequest, UiRouteGenerateResponse, UiReviewRouteResponse, UiSettings, UiSettingsPatch, UiTask } from '@sherpa/protocol';
import { rpcErrorSchema, UI_ENDPOINTS, uiCancelResponseSchema, uiChatAskResponseSchema, uiChatCancelResponseSchema, uiChatResponseSchema, uiChatRetryResponseSchema, uiEnqueueResponseSchema, uiReviewDiffResponseSchema, uiReviewFileContentResponseSchema, uiReviewRouteResponseSchema, uiRouteFillStopResponseSchema, uiRouteGenerateResponseSchema, uiSettingsResponseSchema } from '@sherpa/protocol';
import type { z } from 'zod';

import { activeT } from './i18n/index.js';
import { uiReviewWriteAckSchema } from '@sherpa/protocol';
import { withTreeOrder } from './tree/file-order.js';

/**
 * Действия UI (docs/protocol.md §2): обычный REST под bearer-токеном. Ответы валидируются схемами
 * протокола — UI не потребляет ничего, что не прошло валидатор.
 */

/** Ошибка, которую можно показать ревьюеру как есть: тексты контракта уже человеческие. */
export class ApiError extends Error {
    constructor(message: string, readonly status: number | null = null) {
        super(message);
    }
}

export async function enqueueEchoTask(token: string, text: string, priority?: PriorityClass): Promise<UiTask> {
    const body: UiEnqueueResponse = await post(
        UI_ENDPOINTS.enqueue,
        token,
        priority === undefined ? { type: 'echo', text } : { type: 'echo', text, priority },
        uiEnqueueResponseSchema,
    );
    return body.task;
}

export async function cancelTask(token: string, taskId: number): Promise<UiCancelResponse['outcome']> {
    const body: UiCancelResponse = await post(UI_ENDPOINTS.cancel, token, { taskId }, uiCancelResponseSchema);
    return body.outcome;
}

/**
 * Выбор диффа для ручки: без него — активная итерация, `diffId` — сохранённая итерация
 * (пикер снапшотов), `base`/`head` — срез между итерациями.
 */
export type ReviewDiffSelection = { readonly diffId: string | null } | { readonly base: string; readonly head: string };

/** Дифф приходит в UI здесь — и сразу в порядке дерева: порядок хоста дальше не виден никому. */
export async function fetchReviewDiff(token: string, selection?: ReviewDiffSelection | null): Promise<PrDiff> {
    const query =
        selection == null
            ? {}
            : 'diffId' in selection
              ? { diffId: selection.diffId }
              : { base: selection.base, head: selection.head };
    return withTreeOrder((await get(withQuery(UI_ENDPOINTS.reviewDiff, query), token, uiReviewDiffResponseSchema)).diff);
}

/**
 * Содержимое файла для «Expand context». Зовётся только при `capabilities.fileContent`;
 * `null` — у этого файла содержимого нет (binary, слишком большой).
 */
export async function fetchFileContent(token: string, fileId: string, diffId?: string): Promise<FileContent | null> {
    const path = `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(fileId)}${diffId === undefined ? '' : `&diffId=${encodeURIComponent(diffId)}`}`;
    return (await get(path, token, uiReviewFileContentResponseSchema)).content;
}

/**
 * Байты стороны картинки (`FileDiff.image`). Зовётся только при `capabilities.blobs`;
 * `null` — хост такого блоба не знает или сторона больше лимита контракта.
 */
export async function fetchBlob(token: string, blobId: string): Promise<Blob | null> {
    const path = `${UI_ENDPOINTS.reviewBlob}?blobId=${encodeURIComponent(blobId)}`;
    let response: Response;
    try {
        response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw new ApiError(activeT()('error.serverDown'));
    }

    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new ApiError(errorMessage(await response.json().catch(() => null)), response.status);
    }
    return response.blob();
}

/**
 * Состояние маршрута: фаза, снапшот и ревизия. Ручка локальная — живёт и без ревью-хоста,
 * перечитывается по выросшей `routeRevision` из SSE.
 */
export async function fetchReviewRoute(
    token: string,
    snapshotId?: string | null,
): Promise<UiReviewRouteResponse> {
    return get(withQuery(UI_ENDPOINTS.reviewRoute, { snapshot: snapshotId }), token, uiReviewRouteResponseSchema);
}

export async function retryRouteDiagram(token: string, snapshotId: string): Promise<void> {
    await post(UI_ENDPOINTS.reviewRouteRetryDiagram, token, { snapshotId }, uiReviewWriteAckSchema);
}

export async function cancelRouteGeneration(token: string, generationId: string): Promise<void> {
    await post(UI_ENDPOINTS.reviewRouteCancelGeneration, token, { generationId }, uiReviewWriteAckSchema);
}

/**
 * Запуск или перезапуск генерации маршрута: «Повторить» на карточке провала (docs/spec.md)
 * и команда палитры. Что генерить, сервер знает сам; в теле едет только язык —
 * эффективная локаль вкладки, чтобы маршрут родился на том же языке, что интерфейс.
 */
export async function generateReviewRoute(
    token: string,
    locale: Locale,
): Promise<UiRouteGenerateResponse['outcome']> {
    const request: UiRouteGenerateRequest = { locale };
    const body: UiRouteGenerateResponse = await post(
        UI_ENDPOINTS.reviewRouteGenerate,
        token,
        request,
        uiRouteGenerateResponseSchema,
    );
    return body.outcome;
}

/** Дозаполняет один failed-слот текущего снапшота без полной перестройки маршрута. */
export async function fillRouteStop(
    token: string,
    request: UiRouteFillStopRequest,
): Promise<UiRouteFillStopResponse['outcome']> {
    const body: UiRouteFillStopResponse = await post(
        UI_ENDPOINTS.reviewRouteFillStop,
        token,
        request,
        uiRouteFillStopResponseSchema,
    );
    return body.outcome;
}

/** Полный снапшот чата и заметок; перечитывается по выросшей `chatRevision`. */
export async function fetchReviewChat(token: string): Promise<UiChatResponse> {
    return get(UI_ENDPOINTS.reviewChat, token, uiChatResponseSchema);
}

/**
 * Ставит вопрос по выделению или ко всему PR; созданный обмен показывается оптимистично.
 * `locale` — язык ответа: та же эффективная локаль вкладки, что у генерации маршрута.
 */
export async function askReviewChat(
    token: string,
    text: string,
    anchor: UiChatAskAnchor | undefined,
    locale: Locale,
    explanation?: ChatExplanation,
): Promise<ChatExchange> {
    const request: UiChatAskRequest = { text, locale, ...(anchor === undefined ? {} : { anchor }), ...(explanation === undefined ? {} : { explanation }) };
    return (await post(UI_ENDPOINTS.reviewChatAsk, token, request, uiChatAskResponseSchema)).exchange;
}

export async function cancelReviewChat(
    token: string,
    exchangeId: number,
): Promise<UiChatCancelResponse['outcome']> {
    return (
        await post(UI_ENDPOINTS.reviewChatCancel, token, { exchangeId }, uiChatCancelResponseSchema)
    ).outcome;
}

export async function retryReviewChat(
    token: string,
    exchangeId: number,
): Promise<UiChatRetryResponse['outcome']> {
    return (
        await post(UI_ENDPOINTS.reviewChatRetry, token, { exchangeId }, uiChatRetryResponseSchema)
    ).outcome;
}

/** Параметры ручки: пустые (`undefined`/`null`) в адрес не попадают. */
function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            query.set(name, value);
        }
    }
    const search = query.toString();
    return search === '' ? path : `${path}?${search}`;
}

/**
 * Глобальные настройки UI: они живут в `~/.sherpa/settings.json`, а не в `localStorage` —
 * сервер каждого PR слушает свой порт, и браузерное хранилище к следующему PR не относится.
 */
export async function fetchUiSettings(token: string): Promise<UiSettings> {
    return (await get(UI_ENDPOINTS.settings, token, uiSettingsResponseSchema)).settings;
}

/** Меняет названные поля; в ответе — весь набор после слияния на сервере. */
export async function patchUiSettings(token: string, settings: UiSettingsPatch): Promise<UiSettings> {
    return (await patch(UI_ENDPOINTS.settings, token, settings, uiSettingsResponseSchema)).settings;
}

async function get<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw new ApiError(activeT()('error.serverDown'));
    }
    return validate(response, schema);
}

async function post<T>(path: string, token: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    } catch {
        throw new ApiError(activeT()('error.serverDown'));
    }
    return validate(response, schema);
}

async function patch<T>(
    path: string,
    token: string,
    body: unknown,
    schema: z.ZodType<T>,
    options: { readonly keepalive?: boolean } = {},
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            ...(options.keepalive === true ? { keepalive: true } : {}),
        });
    } catch {
        throw new ApiError(activeT()('error.serverDown'));
    }
    return validate(response, schema);
}

async function validate<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ApiError(errorMessage(payload), response.status);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
        throw new ApiError(activeT()('error.contract'));
    }
    return parsed.data;
}

function errorMessage(payload: unknown): string {
    const parsed = rpcErrorSchema.safeParse(payload);
    if (!parsed.success) {
        return activeT()('error.unknown');
    }

    const { message, details } = parsed.data.error;
    return details === undefined || details.length === 0 ? message : `${message} ${details.join('; ')}`;
}
