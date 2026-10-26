import type { UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Store, StreamHandlers } from './store.js';
import { createStore } from './store.js';

const STATE: UiState = {
    prKey: 'arcanum-1',
    reviewHost: 'arcanum',
    // Мета PR ещё не доехала: сервер наполняет её кеш вне сборки снапшота.
    pr: null,
    worker: { kind: 'never' },
    feedback: { available: true, reason: null },
    iterations: [],
    update: null,
    generationCap: null,
    tasks: [
        {
            id: 1,
            type: 'echo',
            priority: 'interactive',
            status: 'queued',
            heldByWorker: false,
            attempt: 1,
            instructions: 'верни текст',
            progressText: null,
            result: null,
            failReason: null,
            createdAt: '2026-08-19T10:00:00.000Z',
            updatedAt: '2026-08-19T10:00:00.000Z',
        },
    ],
};

const PR_META: NonNullable<UiState['pr']> = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Окно редактирования заказа',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'users/alice/edit-window',
    toBranch: 'trunk',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-19T10:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

interface Harness {
    readonly store: Store;
    readonly emit: (data: string) => void;
    /** Событие `progress`: ревизия прогресса чтения. */
    readonly progress: (data: string) => void;
    /** Событие `review`: ревизия тредов. */
    readonly review: (data: string) => void;
    /** Событие `chat`: ревизия чата и заметок. */
    readonly chat: (data: string) => void;
    /** Обрыв канала; `recoverable: false` — соединение закрыто окончательно. */
    readonly error: (recoverable?: boolean) => void;
    /** URL, с которым стор пошёл подключаться. */
    readonly url: string;
    readonly closed: () => number;
    readonly connects: () => number;
}

/** Канал под ручным управлением: события в тестах подаются вызовом, а не сетью. */
function makeStore(): Harness {
    let handlers: StreamHandlers | null = null;
    let url = '';
    let closes = 0;
    let connects = 0;

    const store = createStore({
        token: 'секрет 1',
        reconnectDelayMs: 1000,
        connect: (streamUrl, streamHandlers) => {
            url = streamUrl;
            handlers = streamHandlers;
            connects += 1;
            return {
                close: () => {
                    closes += 1;
                },
            };
        },
    });

    return {
        store,
        emit: (data) => {
            handlers?.onMessage(data);
        },
        progress: (data) => {
            handlers?.onProgress(data);
        },
        review: (data) => {
            handlers?.onReview(data);
        },
        chat: (data) => {
            handlers?.onChat(data);
        },
        error: (recoverable = true) => {
            handlers?.onError(recoverable);
        },
        url,
        closed: () => closes,
        connects: () => connects,
    };
}

describe('стор UI', () => {
    it('подключается к SSE-ручке с токеном в query', () => {
        const { url } = makeStore();

        expect(url).toBe(`${UI_ENDPOINTS.events}?token=${encodeURIComponent('секрет 1')}`);
    });

    it('до первого события — connecting без состояния', () => {
        const { store } = makeStore();

        expect(store.getSnapshot()).toEqual({
            connection: 'connecting',
            state: null,
            error: null,
            progressRevision: null,
            threadsRevision: null,
            routeRevision: null,
            chatRevision: null,
        });
    });

    it('валидный снапшот переводит в online и будит подписчиков', () => {
        const { store, emit } = makeStore();
        let notifications = 0;
        store.subscribe(() => {
            notifications += 1;
        });

        emit(JSON.stringify(STATE));

        expect(notifications).toBe(1);
        expect(store.getSnapshot().connection).toBe('online');
        expect(store.getSnapshot().state).toEqual(STATE);
    });

    it('мета PR из снапшота доезжает до стора', () => {
        const { store, emit } = makeStore();
        emit(JSON.stringify(STATE));

        emit(JSON.stringify({ ...STATE, pr: PR_META }));

        expect(store.getSnapshot().state?.pr).toEqual(PR_META);
    });

    it('событие прогресса приносит ревизию и не трогает состояние', () => {
        const { store, emit, progress } = makeStore();
        emit(JSON.stringify(STATE));

        progress(JSON.stringify({ progressRevision: 3 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', progressRevision: 3, state: STATE });
    });

    it('событие review приносит ревизию тредов и не трогает состояние', () => {
        const { store, emit, review } = makeStore();
        emit(JSON.stringify(STATE));

        review(JSON.stringify({ threadsRevision: 7 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', threadsRevision: 7, state: STATE });
    });

    it('событие chat приносит ревизию и будит перечитывание только при изменении', () => {
        const { store, emit, chat } = makeStore();
        const listener = vi.fn();
        store.subscribe(listener);
        emit(JSON.stringify(STATE));

        chat(JSON.stringify({ chatRevision: 4 }));
        chat(JSON.stringify({ chatRevision: 4 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', chatRevision: 4, state: STATE });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('кривое событие прогресса игнорируется, канал остаётся живым', () => {
        const { store, emit, progress, closed } = makeStore();
        emit(JSON.stringify(STATE));
        progress(JSON.stringify({ progressRevision: 3 }));

        progress(JSON.stringify({ progressRevision: 'три' }));
        progress('{не json');

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', progressRevision: 3 });
        expect(closed()).toBe(0);
    });

    it('снапшот, не прошедший схему, в стор не попадает — fatal', () => {
        const { store, emit, closed } = makeStore();
        emit(JSON.stringify(STATE));

        emit(JSON.stringify({ ...STATE, tasks: [{ id: 'два' }] }));

        const snapshot = store.getSnapshot();
        expect(snapshot.connection).toBe('fatal');
        expect(snapshot.state).toEqual(STATE);
        expect(snapshot.error).toContain('Обнови Шерпу');
        // Канал закрыт: переподключаться к серверу, которого UI не понимает, бессмысленно.
        expect(closed()).toBe(1);
    });

    it('нечитаемый JSON — тоже fatal', () => {
        const { store, emit } = makeStore();

        emit('{не json');

        expect(store.getSnapshot().connection).toBe('fatal');
    });

    it('обрыв канала — reconnecting с последним известным состоянием', () => {
        const { store, emit, error } = makeStore();
        emit(JSON.stringify(STATE));

        error();

        expect(store.getSnapshot().connection).toBe('reconnecting');
        expect(store.getSnapshot().state).toEqual(STATE);
    });

    it('переподключение возвращает online', () => {
        const { store, emit, error } = makeStore();
        emit(JSON.stringify(STATE));
        error();

        emit(JSON.stringify({ ...STATE, tasks: [] }));

        expect(store.getSnapshot().connection).toBe('online');
        expect(store.getSnapshot().state?.tasks).toEqual([]);
    });

    it('соединение закрыто окончательно — стор переподключается сам', () => {
        vi.useFakeTimers();
        try {
            const { store, error, connects } = makeStore();

            error(false);
            expect(store.getSnapshot().connection).toBe('reconnecting');
            expect(connects()).toBe(1);

            vi.advanceTimersByTime(1000);
            expect(connects()).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('после fatal канал молчит: ни ошибки, ни события состояние не меняют', () => {
        const { store, emit, error } = makeStore();
        emit('{не json');

        error();
        emit(JSON.stringify(STATE));

        expect(store.getSnapshot().connection).toBe('fatal');
        expect(store.getSnapshot().state).toBeNull();
    });

    it('close отписывает и закрывает канал', () => {
        const { store, emit, closed } = makeStore();
        let notifications = 0;
        store.subscribe(() => {
            notifications += 1;
        });

        store.close();
        emit(JSON.stringify(STATE));

        expect(closed()).toBe(1);
        expect(notifications).toBe(0);
        expect(store.getSnapshot().connection).toBe('connecting');
    });
});
