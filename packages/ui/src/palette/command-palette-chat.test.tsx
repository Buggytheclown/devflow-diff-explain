// @vitest-environment jsdom
import type { AgentNote, ChatAnchor, ChatExchange } from '@sherpa/protocol';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import type { PaletteChat } from './command-palette.tsx';
import { CommandPalette } from './command-palette.tsx';

/** Режим `@`: история чата этого PR в палитре (docs/design/SPEC-elements.md §2.18). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const LIVE_FILE = 'file-live';
const GONE_FILE = 'file-gone';

function anchor(fileId: string, path: string): ChatAnchor {
    return { diffId: 'diff-1', fileId, path, side: 'new', start: 48, end: 54 };
}

function exchange(spec: Partial<ChatExchange> & { id: number; question: string }): ChatExchange {
    return {
        anchor: null,
        status: 'done',
        taskId: null,
        answer: null,
        progressText: null,
        error: null,
        locale: null,
        createdAt: `2026-08-20T09:${String(spec.id).padStart(2, '0')}:00.000Z`,
        updatedAt: `2026-08-20T09:${String(spec.id).padStart(2, '0')}:00.000Z`,
        ...spec,
    };
}

const EXCHANGES: readonly ChatExchange[] = [
    exchange({ id: 11, question: 'Почему закрытое окно отвечает 409?', anchor: anchor(LIVE_FILE, 'api/handlers.ts'), answer: 'Статус выбирается по причине отказа.' }),
    exchange({ id: 12, question: 'Разложи PR по механике', answer: 'Правило 30 минут переехало в домен.' }),
    exchange({ id: 13, question: 'Что с курьером?', anchor: anchor(GONE_FILE, 'domain/edit-policy.ts'), answer: 'Отправка закрывает окно.' }),
    exchange({ id: 14, question: 'Есть ли риск утечки?', status: 'running' }),
    exchange({ id: 15, question: 'Сравни контракт с прежним', status: 'cancelled' }),
    exchange({ id: 16, question: 'Проверь статусы', status: 'failed', error: 'Агент не ответил.' }),
    exchange({ id: 17, question: 'Как считается смешанная корзина?', answer: 'По минимальному окну.' }),
    exchange({ id: 18, question: 'Зачем политике explain?', answer: 'Ради тестов.' }),
    exchange({ id: 19, question: 'Что с аудитом?', answer: 'Пишется в тот же обработчик.' }),
];

const NOTES: readonly AgentNote[] = [
    {
        id: 1,
        exchangeId: 13,
        anchor: anchor(GONE_FILE, 'domain/edit-policy.ts'),
        text: 'Отправка закрывает окно.',
        lostAnchor: true,
        origin: { commit: 'c0ffee', anchor: anchor(GONE_FILE, 'domain/edit-policy.ts') },
        createdAt: '2026-08-20T09:13:00.000Z',
    },
];

const selected: { exchange: ChatExchange; anchorAlive: boolean }[] = [];
const mounted: (() => void)[] = [];

afterEach(() => {
    selected.length = 0;
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

type ChatOverrides = Partial<Pick<PaletteChat, 'exchanges' | 'loading' | 'error'>>;

function Harness({ query, chat = true, overrides }: { query: string; chat?: boolean; overrides?: ChatOverrides | undefined }) {
    const [registry] = useState(() => createShortcutRegistry());
    const [prState] = useState(() => createUiPrStateStore());
    const [open, setOpen] = useState(true);
    const [paletteChat] = useState<PaletteChat>(() => ({
        exchanges: EXCHANGES,
        notes: NOTES,
        liveFileIds: new Set([LIVE_FILE]),
        now: NOW,
        onSelect: (exchange, anchorAlive) => {
            selected.push({ exchange, anchorAlive });
        },
        ...overrides,
    }));

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <CommandPalette
                    open={open}
                    source={null}
                    chat={chat ? paletteChat : undefined}
                    initialQuery={query}
                    onOpen={() => {
                        setOpen(true);
                    }}
                    onClose={() => {
                        setOpen(false);
                    }}
                />
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function mount(query: string, options: { chat?: boolean; overrides?: ChatOverrides } = {}): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Harness query={query} chat={options.chat ?? true} overrides={options.overrides} />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function rows(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('.command-palette__item')];
}

function rowText(host: HTMLElement, index: number): string {
    const row = rows(host)[index];
    if (row === undefined) {
        throw new Error(`в выдаче палитры нет строки ${String(index)}`);
    }
    return row.textContent;
}

function notice(host: HTMLElement): string | undefined {
    return host.querySelector('.command-palette__notice')?.textContent;
}

function announcement(host: HTMLElement): string | undefined {
    return host.querySelector('[role="status"]')?.textContent;
}

function pressEnter(host: HTMLElement): void {
    const overlay = host.querySelector('.command-palette__overlay');
    if (overlay === null) {
        throw new Error('палитра не открыта');
    }
    act(() => {
        overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
}

describe('история чата в палитре', () => {
    it('пустой @ показывает последние восемь обменов, новые сверху', () => {
        const host = mount('@');

        expect(rows(host)).toHaveLength(8);
        expect(rowText(host, 0)).toContain('Что с аудитом?');
        expect(host.querySelector('.command-palette__group-label')?.textContent).toBe('История чата');
        // Одиннадцатый обмен — девятый по свежести, в выдачу не попадает.
        expect(host.textContent).not.toContain('Почему закрытое окно отвечает 409?');
    });

    it('текст после @ ищет и по вопросу, и по ответу', () => {
        const host = mount('@ окно');

        expect(rows(host).map((row) => row.textContent)).toEqual([
            expect.stringContaining('Что с курьером?'),
            expect.stringContaining('Почему закрытое окно отвечает 409?'),
        ]);
    });

    it('строка называет время, место и пометки якоря', () => {
        const host = mount('@ окно');

        expect(rowText(host, 0)).toContain('edit-policy.ts:48–54');
        expect(rowText(host, 0)).toContain('якорь не в этой итерации');
        expect(rowText(host, 0)).toContain('заметка потеряла якорь');
        expect(rowText(host, 1)).toContain('handlers.ts:48–54');
        expect(rowText(host, 1)).not.toContain('якорь не в этой итерации');
        expect(rowText(host, 1)).toContain('назад');
    });

    it('вопрос без якоря и незавершённые обмены помечены', () => {
        const host = mount('@');

        expect(rowText(host, 5)).toContain('Есть ли риск утечки?');
        expect(rowText(host, 5)).toContain('вопрос ко всему PR');
        expect(rowText(host, 5)).toContain('ещё отвечает');
        expect(rowText(host, 4)).toContain('отменён');
        expect(rowText(host, 3)).toContain('без ответа');
    });

    it('⏎ отдаёт обмен с живым якорем', () => {
        const host = mount('@ 409');

        pressEnter(host);

        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(11);
        expect(selected[0]?.anchorAlive).toBe(true);
        expect(host.querySelector('.command-palette')).toBeNull();
    });

    it('⏎ на мёртвом якоре и на вопросе без якоря отдаёт anchorAlive false', () => {
        const gone = mount('@ курьер');
        pressEnter(gone);
        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(13);
        expect(selected[0]?.anchorAlive).toBe(false);

        selected.length = 0;
        const wholePr = mount('@ механик');
        pressEnter(wholePr);
        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(12);
        expect(selected[0]?.anchorAlive).toBe(false);
    });

    it('без истории @ не предлагает искать в диффе', () => {
        const host = mount('@', { chat: false });

        expect(rows(host)).toEqual([]);
        expect(host.querySelector('.command-palette__notice')?.textContent).toContain('История чата пуста');
        expect(host.textContent).not.toContain('Искать в содержимом диффа');
    });

    it('поиск без попаданий говорит про запрос', () => {
        const host = mount('@ кэш');

        expect(rows(host)).toEqual([]);
        expect(host.querySelector('.command-palette__notice')?.textContent).toBe('Ничего не нашлось по «кэш»');
    });

    it('незагруженная история не выдаётся за пустую', () => {
        const loading = mount('@', { overrides: { exchanges: [], loading: true } });
        expect(notice(loading)).toBe('История чата ещё загружается');

        const failed = mount('@ окно', { overrides: { exchanges: [], error: 'сервер молчит' } });
        expect(notice(failed)).toBe('Не удалось загрузить историю чата: сервер молчит');
    });

    it('пустая история — подсказка состояния, а не результат поиска', () => {
        const host = mount('@', { overrides: { exchanges: [] } });

        expect(notice(host)).toBe('История чата пуста — спросите агента о выделении или о PR');
        expect(announcement(host)).toBe('История чата пуста — спросите агента о выделении или о PR');
        // Непустой запрос — уже поиск: скринридеру произносится короткое «ничего не нашлось».
        expect(announcement(mount('@ кэш'))).toBe('Ничего не нашлось');
    });
});
