// @vitest-environment jsdom
import type { AgentNote, ChatAnchor, ChatExchange, UiTask, WorkerStatus } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatPanelProps } from './chat-panel.tsx';
import {
    chatActivityState,
    chatAnchorLabel,
    ChatPanel,
    expandChatExchanges,
    queueBannerText,
    sameChatAnchor,
} from './chat-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'worker-1',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
};
const ANCHOR: ChatAnchor = {
    diffId: 'iter-1',
    fileId: 'file-1',
    path: 'src/cache.ts',
    side: 'new',
    start: 41,
    end: 43,
};

function exchange(id: number, status: ChatExchange['status'], overrides: Partial<ChatExchange> = {}): ChatExchange {
    return {
        id,
        question: `Вопрос ${String(id)}`,
        anchor: null,
        status,
        taskId: id,
        answer: status === 'done' ? 'Ответ **агента**.' : null,
        progressText: status === 'running' ? 'Читаю связанные вызовы' : null,
        error: status === 'failed' ? 'Модель не вернула ответ.' : null,
        locale: null,
        createdAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        updatedAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        ...overrides,
    };
}

function task(
    id: number,
    type: UiTask['type'],
    status: UiTask['status'],
    heldByWorker = status === 'leased',
): UiTask {
    return {
        id,
        type,
        priority: 'interactive',
        status,
        heldByWorker,
        attempt: 1,
        instructions: 'задача',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
    };
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalScrollIntoView === undefined) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    }
});

function mountPanel(overrides: Partial<ChatPanelProps> = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let props: ChatPanelProps = {
        worker: CONNECTED,
        tasks: [],
        exchanges: [],
        notes: [],
        loading: false,
        error: null,
        reconnectCommand: '/sherpa arcanum-4821',
        anchor: null,
        focusRequest: 0,
        scrollRequest: null,
        onScrollRequestHandled: () => undefined,
        onClose: () => undefined,
        onRemoveAnchor: () => undefined,
        onAsk: () => Promise.resolve(exchange(99, 'queued')),
        onCancel: () => Promise.resolve(),
        onRetry: () => Promise.resolve(),
        onNavigate: () => undefined,
        onNavigateToNote: () => undefined,
        ...overrides,
    };
    const render = (next: Partial<ChatPanelProps> = {}): void => {
        props = { ...props, ...next };
        act(() => {
            root.render(<ChatPanel {...props} />);
        });
    };
    render();
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, render };
}

describe('модель чат-панели', () => {
    it('разворачивает обмены по времени и связывает заметку по exchangeId', () => {
        const note: AgentNote = {
            id: 8,
            exchangeId: 2,
            anchor: ANCHOR,
            text: 'Ответ',
            lostAnchor: false,
            origin: { commit: 'abcdef1', anchor: ANCHOR },
            createdAt: '2026-09-01T10:01:00.000Z',
        };

        expect(expandChatExchanges([exchange(2, 'done'), exchange(1, 'done')], [note])).toEqual([
            { exchange: exchange(1, 'done'), note: null },
            { exchange: exchange(2, 'done'), note },
        ]);
    });

    it('выбирает 5 контрактных состояний и спокойную историю', () => {
        expect(chatActivityState(CONNECTED, [])).toBe('empty');
        expect(chatActivityState(CONNECTED, [exchange(1, 'queued')])).toBe('queued');
        expect(chatActivityState(CONNECTED, [exchange(1, 'running')])).toBe('answering');
        expect(chatActivityState(CONNECTED, [exchange(1, 'failed')])).toBe('failed');
        expect(chatActivityState({ kind: 'never' }, [])).toBe('disconnected');
        expect(chatActivityState(CONNECTED, [exchange(1, 'done')])).toBe('idle');
    });

    it('баннер различает генерацию маршрута и другую занятую задачу', () => {
        expect(queueBannerText([task(1, 'route.section', 'leased')])).toBe('chat.queue.route');
        expect(queueBannerText([task(1, 'echo', 'leased')])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'chat', 'leased')])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'chat', 'done')])).toBeNull();
    });

    it('правку по замечаниям баннер называет своими словами', () => {
        expect(queueBannerText([task(1, 'review.feedback', 'leased')])).toBe('chat.queue.feedback');
        expect(queueBannerText([task(1, 'review.feedback', 'cancelled', true)])).toBe('chat.queue.busy');
    });

    it('держание отменённой маршрутной задачи не выдаётся за идущую генерацию', () => {
        expect(queueBannerText([task(1, 'route.section', 'cancelled', true)])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'route.section', 'cancelled', false)])).toBeNull();
    });

    it('сравнивает якоря по диапазону, а не по объектной ссылке', () => {
        expect(sameChatAnchor(ANCHOR, { ...ANCHOR })).toBe(true);
        expect(sameChatAnchor(ANCHOR, { ...ANCHOR, end: 44 })).toBe(false);
        expect(sameChatAnchor(null, null)).toBe(true);
    });

    it('показывает basename, сохраняя полный путь для подсказки', () => {
        expect(chatAnchorLabel({ ...ANCHOR, path: 'services/cache/src/cache.ts' })).toBe('cache.ts:41–43');
    });
});

describe('лента чат-панели', () => {
    it('показывает индикатор через 300 мс и долгую работу после 60 с от createdAt', () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-09-01T10:00:00.000Z');
        const running = exchange(1, 'running', {
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z',
        });
        const { host, render } = mountPanel({ exchanges: [running] });

        expect(host.textContent).not.toContain('Отвечаю');
        act(() => {
            vi.advanceTimersByTime(299);
        });
        expect(host.textContent).not.toContain('Отвечаю');
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(host.textContent).toContain('Отвечаю');

        render({
            exchanges: [
                {
                    ...running,
                    progressText: 'Проверяю ещё один вызов',
                    updatedAt: '2026-09-01T10:00:30.000Z',
                },
            ],
        });
        expect(host.textContent).toContain('Отвечаю');
        act(() => {
            vi.advanceTimersByTime(59_700);
        });
        expect(host.textContent).toContain('Отвечаю');
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(host.textContent).toContain('Всё ещё работаю');
    });

    it('держание отменённой задачи ставит строку под её обмен, а новый вопрос — в очередь за ней', () => {
        const { host } = mountPanel({
            // Обмен 1 отменён, но его задача всё ещё у воркера; обмен 2 ждёт своей очереди.
            tasks: [task(1, 'chat', 'cancelled', true)],
            exchanges: [exchange(1, 'cancelled'), exchange(2, 'queued')],
        });

        expect(host.textContent).toContain('Агент занят · ваш вопрос следующий');
        expect(host.querySelector('[data-exchange="1"]')?.textContent).toContain(
            'Агент ещё занят отменённой задачей',
        );
        expect(host.querySelector('[data-exchange="2"]')?.textContent).not.toContain(
            'Агент ещё занят отменённой задачей',
        );
    });

    it('чужая живая аренда строку под отменённым обменом не даёт', () => {
        const { host, render } = mountPanel({
            // Воркер уже отозвался по задаче 1 и взял задачу другого вопроса.
            tasks: [task(1, 'chat', 'cancelled', false), task(2, 'chat', 'leased')],
            exchanges: [exchange(1, 'cancelled'), exchange(2, 'running')],
        });

        expect(host.textContent).not.toContain('Агент ещё занят отменённой задачей');

        // Держание снялось, пока обмен оставался отменённым, — строка уходит и без смены обмена.
        render({ tasks: [task(1, 'chat', 'cancelled', true)], exchanges: [exchange(1, 'cancelled')] });
        expect(host.textContent).toContain('Агент ещё занят отменённой задачей');
        render({ tasks: [task(1, 'chat', 'cancelled', false)], exchanges: [exchange(1, 'cancelled')] });
        expect(host.textContent).not.toContain('Агент ещё занят отменённой задачей');
    });

    it('показывает загрузку и ошибку истории вместо ложного пустого чата', () => {
        const { host, render } = mountPanel({ loading: true });

        expect(host.textContent).toContain('Загружаю историю чата');
        expect(host.textContent).not.toContain('Спросите о PR');

        render({ loading: false, error: 'Сервер ответил 500' });
        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
            'Не удалось загрузить историю чата: Сервер ответил 500',
        );
        expect(host.textContent).not.toContain('Спросите о PR');
    });

    it('скроллит вниз при росте ленты, но явная цель ждёт DOM и имеет приоритет', () => {
        const targets: string[] = [];
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value(this: HTMLElement) {
                targets.push(this.closest('[data-exchange]')?.getAttribute('data-exchange') ?? 'none');
            },
        });
        const onScrollRequestHandled = vi.fn();
        const running = exchange(1, 'running');
        const { host, render } = mountPanel({ exchanges: [running], onScrollRequestHandled });
        const feed = host.querySelector<HTMLElement>('.chat-panel__feed');
        if (feed === null) {
            throw new Error('нет ленты чата');
        }
        Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 500 });
        feed.scrollTop = 0;

        render({ exchanges: [{ ...running, updatedAt: '2026-09-01T10:00:30.000Z' }] });
        expect(feed.scrollTop).toBe(500);

        feed.scrollTop = 0;
        render({ exchanges: [], scrollRequest: { id: 7, target: 'error' } });
        expect(targets).toEqual([]);
        expect(onScrollRequestHandled).not.toHaveBeenCalled();

        render({ exchanges: [exchange(2, 'failed'), exchange(3, 'cancelled')] });
        expect(targets).toEqual(['3']);
        expect(feed.scrollTop).toBe(0);
        expect(onScrollRequestHandled).toHaveBeenCalledWith(7);

        render({
            exchanges: [exchange(9, 'done')],
            scrollRequest: { id: 8, target: { kind: 'exchange', exchangeId: 9 } },
        });
        expect(targets).toEqual(['3', '9']);
        expect(onScrollRequestHandled).toHaveBeenCalledWith(8);
    });

    it('не прокручивает к старой ошибке без запроса и хранит полный путь в title', () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: scrollIntoView,
        });
        const anchor = { ...ANCHOR, path: 'services/cache/src/cache.ts' };
        const { host } = mountPanel({
            anchor,
            exchanges: [exchange(1, 'failed', { anchor })],
        });

        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(host.textContent).toContain('cache.ts:41–43');
        expect(host.querySelector('[title="services/cache/src/cache.ts:41–43"]')).not.toBeNull();
    });

    it('переходит к самой заметке и гасит отметку после удаления из общего списка', () => {
        const attached: AgentNote = {
            id: 31,
            exchangeId: 1,
            anchor: ANCHOR,
            text: 'Ответ',
            lostAnchor: false,
            origin: { commit: 'abcdef1', anchor: ANCHOR },
            createdAt: '2026-09-01T10:01:00.000Z',
        };
        const onNavigate = vi.fn();
        const onNavigateToNote = vi.fn();
        const { host, render } = mountPanel({
            exchanges: [exchange(1, 'done')],
            notes: [attached],
            onNavigate,
            onNavigateToNote,
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('.chat-message__note')?.click();
        });
        expect(onNavigateToNote).toHaveBeenCalledWith(attached);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Закреплено заметкой');
        expect(host.textContent).toContain('Заметки 1');

        render({ notes: [] });
        expect(host.textContent).not.toContain('Закреплено заметкой');
        expect(host.textContent).not.toContain('Заметки 1');
    });
});

describe('композер чат-панели', () => {
    it('без якоря ряда контекста нет, подсказка — две строки', () => {
        const { host } = mountPanel();

        expect(host.querySelector('.chat-panel__contexts')).toBeNull();
        const hint = [...host.querySelectorAll('.chat-panel__composer-hint > span')].map((line) => line.textContent);
        expect(hint).toEqual(['Enter — отправить', 'Shift+Enter — новая строка']);
    });

    it('Enter отправляет, Shift+Enter оставляет перенос, чип диапазона снимается отдельно', async () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(3, 'queued', { anchor: ANCHOR })));
        const onRemoveAnchor = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ChatPanel
                    worker={CONNECTED}
                    tasks={[]}
                    exchanges={[]}
                    notes={[]}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa arcanum-4821"
                    anchor={ANCHOR}
                    focusRequest={0}
                    scrollRequest={null}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={onRemoveAnchor}
                    onAsk={onAsk}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).not.toContain('PR 4821');
        expect(host.querySelectorAll('.chat-panel__context')).toHaveLength(1);
        expect(host.textContent).toContain('cache.ts:41–43');
        const textarea = host.querySelector('textarea');
        if (textarea === null) {
            throw new Error('нет поля вопроса');
        }
        act(() => {
            Object.defineProperty(textarea, 'value', {
                configurable: true,
                value: 'Почему здесь отдельная проверка?',
                writable: true,
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        });
        expect(onAsk).not.toHaveBeenCalled();

        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(onAsk).toHaveBeenCalledWith('Почему здесь отдельная проверка?', ANCHOR);

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Убрать диапазон из контекста"]')?.click();
        });
        expect(onRemoveAnchor).toHaveBeenCalledTimes(1);
    });

    it('при отключённом агенте блокирует поле и показывает команду переподключения', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ChatPanel
                    worker={{ kind: 'never' }}
                    tasks={[]}
                    exchanges={[]}
                    notes={[]}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa fixture-medium"
                    anchor={null}
                    focusRequest={0}
                    scrollRequest={null}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={() => undefined}
                    onAsk={() => Promise.resolve(exchange(1, 'queued'))}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
        expect(host.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe('/sherpa fixture-medium');
    });
});

describe('подстановка вопроса в композер', () => {
    it('ставит текст запроса и не отправляет его', () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(99, 'queued')));
        const { host } = mountPanel({ prefillRequest: { id: 1, text: 'Разложи эти диапазоны' }, onAsk });

        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.value).toBe('Разложи эти диапазоны');
        expect(textarea?.selectionStart).toBe('Разложи эти диапазоны'.length);
        expect(onAsk).not.toHaveBeenCalled();
    });

    it('после правки повторный запрос с тем же текстом снова подставляет его', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 1, text: 'Разложи эти диапазоны' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('нет поля вопроса');
        }

        act(() => {
            setTextareaValue(textarea, 'моя правка');
        });
        expect(textarea.value).toBe('моя правка');

        render({ prefillRequest: { id: 2, text: 'Разложи эти диапазоны' } });
        expect(textarea.value).toBe('Разложи эти диапазоны');
    });

    it('тот же запрос не переписывает набранное заново', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 1, text: 'Разложи эти диапазоны' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('нет поля вопроса');
        }

        act(() => {
            setTextareaValue(textarea, 'моя правка');
        });
        render({ focusRequest: 1 });

        expect(textarea.value).toBe('моя правка');
    });

    it('снятый запрос не стирает набранное', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 7, text: 'Вопрос' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('нет поля вопроса');
        }

        act(() => {
            setTextareaValue(textarea, 'Вопрос с уточнением');
        });
        render({ prefillRequest: null });

        expect(textarea.value).toBe('Вопрос с уточнением');
    });
});

describe('примеры вопросов в пустом состоянии', () => {
    it('клик подставляет текст в композер и ничего не отправляет', () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(99, 'queued')));
        const { host } = mountPanel({ onAsk });

        const example = host.querySelector<HTMLButtonElement>('.chat-panel__example');
        expect(example?.textContent).toBe('Какие изменения здесь самые рискованные?');
        act(() => {
            example?.click();
        });

        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.value).toBe('Какие изменения здесь самые рискованные?');
        expect(textarea?.selectionStart).toBe('Какие изменения здесь самые рискованные?'.length);
        expect(onAsk).not.toHaveBeenCalled();
    });

    it('при отключённом агенте примеров нет: кликабельного обещания панель не даёт', () => {
        const { host } = mountPanel({ worker: { kind: 'never' } });

        expect(host.querySelector('.chat-panel__example')).toBeNull();
        expect(host.textContent).toContain('Агент отключён. Новые вопросы недоступны.');
    });
});

/** Контролируемому полю значение ставится нативным сеттером, иначе React не увидит ввод. */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- сеттер прототипа зовётся через call
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
