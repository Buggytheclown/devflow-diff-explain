import type { AgentNote, ChatAnchor, ChatExchange, UiTask, WorkerStatus } from '@sherpa/protocol';

import { ChatPanel } from '../../components/chat-panel.tsx';

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
};
const ANCHOR: ChatAnchor = {
    diffId: 'gallery-iteration',
    fileId: 'gallery-chat-file',
    path: 'src/review/cache.ts',
    side: 'new',
    start: 41,
    end: 43,
};
const ROUTE_TASK: UiTask = {
    id: 91,
    type: 'route.section',
    priority: 'background',
    status: 'leased',
    heldByWorker: true,
    attempt: 1,
    instructions: 'Заполнить остановку маршрута',
    progressText: 'Читаю изменения',
    result: null,
    failReason: null,
    createdAt: '2026-09-01T09:59:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

function exchange(
    id: number,
    status: ChatExchange['status'],
    overrides: Partial<ChatExchange> = {},
): ChatExchange {
    return {
        id,
        question: 'Почему проверка кеша стоит до загрузки данных?',
        anchor: ANCHOR,
        status,
        taskId: id,
        answer: status === 'done' ? 'Проверка отделяет **попадание в кеш** от загрузки. Это сохраняет быстрый путь.' : null,
        progressText: status === 'running' ? 'Проверяю вызывающие функции' : null,
        error: status === 'failed' ? 'Модель завершила задачу без ответа.' : null,
        locale: null,
        createdAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        updatedAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        ...overrides,
    };
}

const HISTORY = [
    exchange(1, 'done'),
    exchange(2, 'done', {
        question: 'Какие изменения в PR требуют ручной проверки?',
        anchor: null,
        answer: 'Проверьте отмену запроса и повтор после ошибки: оба пути меняют состояние очереди.',
        createdAt: '2026-09-01T10:02:00.000Z',
        updatedAt: '2026-09-01T10:03:00.000Z',
    }),
];
const NOTE: AgentNote = {
    id: 31,
    exchangeId: 1,
    anchor: ANCHOR,
    text: 'Проверка отделяет попадание в кеш от загрузки.',
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: ANCHOR },
    createdAt: '2026-09-01T10:01:00.000Z',
};

export const CHAT_PANEL_STATES = [
    {
        id: 'chat-empty',
        title: 'empty',
        render: () => <ChatState worker={CONNECTED} exchanges={[]} tasks={[]} />,
    },
    {
        id: 'chat-queued',
        title: 'queued',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'queued')]} tasks={[ROUTE_TASK]} />,
    },
    {
        id: 'chat-answering',
        title: 'answering с progressText',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'running')]} tasks={[]} />,
    },
    {
        id: 'chat-failed',
        title: 'failed',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'failed')]} tasks={[]} />,
    },
    {
        id: 'chat-disconnected',
        title: 'disconnected',
        render: () => <ChatState worker={{ kind: 'never' }} exchanges={HISTORY} tasks={[]} />,
    },
    {
        id: 'chat-history',
        title: 'история с якорем и заметкой',
        render: () => <ChatState worker={CONNECTED} exchanges={HISTORY} notes={[NOTE]} tasks={[]} />,
    },
] as const;

function ChatState({
    worker,
    exchanges,
    notes = [],
    tasks,
}: {
    worker: WorkerStatus;
    exchanges: readonly ChatExchange[];
    notes?: readonly AgentNote[];
    tasks: readonly UiTask[];
}) {
    return (
        <div className="gallery-chat-panel">
            <ChatPanel
                worker={worker}
                tasks={tasks}
                exchanges={exchanges}
                notes={notes}
                loading={false}
                error={null}
                reconnectCommand="/sherpa fixture-4821"
                anchor={exchanges.at(-1)?.anchor ?? null}
                focusRequest={0}
                scrollRequest={null}
                onScrollRequestHandled={() => undefined}
                onClose={() => undefined}
                onRemoveAnchor={() => undefined}
                onAsk={() => Promise.resolve(exchange(9, 'queued'))}
                onCancel={() => Promise.resolve()}
                onRetry={() => Promise.resolve()}
                onNavigate={() => undefined}
                onNavigateToNote={() => undefined}
                now={Date.parse('2026-09-01T10:00:20.000Z')}
            />
        </div>
    );
}
