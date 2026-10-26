// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiSettingsPatch } from '@sherpa/protocol';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { ComposerTransport } from './composer.js';
import { NewCommentComposer, openNewComposer, openPrComposer, openReply, ThreadList } from './thread-list.tsx';
import { createThreadStore } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

function mount(
    layout?: 'visual' | 'markdown',
    options: {
        commentIssues?: boolean;
        kind?: 'pr' | 'line';
        save?: ComposerTransport['save'];
        update?: ComposerTransport['update'];
        delete?: ComposerTransport['delete'];
    } = {},
) {
    const transport: ComposerTransport = {
        save: options.save ?? (() => Promise.reject(new Error('тест не сохраняет'))),
        update: options.update ?? (() => Promise.resolve({ outcome: 'saved' as const })),
        delete: options.delete ?? (() => Promise.resolve()),
    };
    // Раскладка приезжает из глобальных настроек, а не из localStorage: их шов и подменяем.
    const patches: UiSettingsPatch[] = [];
    const settings = createUiSettingsStore({
        ...(layout === undefined ? {} : { initial: { composerLayout: layout } }),
        send: (patch) => {
            patches.push(patch);
            return Promise.resolve(settings.getSnapshot());
        },
    });
    const store = createThreadStore([], new Set(['f1']));
    const key = options.kind === 'line' ? 'new:f1:new:10' : 'new:pr';
    if (options.kind === 'line') {
        openNewComposer(
            store,
            key,
            { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            options.commentIssues ?? true,
        );
    } else {
        openPrComposer(store, options.commentIssues ?? true);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <NewCommentComposer composerKey={key} store={store} transport={transport} />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, settings, patches };
}

function mountReply() {
    const thread = {
        id: 'thread-1',
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: 'root-1',
            author: { login: 'reviewer', displayName: null, bot: false, avatarUrl: null },
            body: 'корень',
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-08-24T10:00:00.000Z',
            editedAt: null,
            replies: [],
        },
    };
    const store = createThreadStore([thread], new Set());
    openReply(store, thread, true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ThreadList
                threads={[thread]}
                store={store}
                actions={{
                    transport: {
                        save: () => Promise.reject(new Error('тест не сохраняет')),
                        update: () => Promise.resolve({ outcome: 'saved' as const }),
                        delete: () => Promise.resolve(),
                    },
                    resolve: () => Promise.resolve(true),
                }}
                now={Date.parse('2026-08-24T10:01:00.000Z')}
                initialLayout="markdown"
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

describe('композер комментария', () => {
    it('показывает включённый issue-свитчер на PR-level композере', () => {
        const { host, store } = mount('markdown');
        const issue = host.querySelector<HTMLButtonElement>('.thread-composer__issue');

        expect(issue?.textContent).toContain('Открыть issue');
        expect(issue?.getAttribute('role')).toBe('switch');
        expect(issue?.getAttribute('aria-checked')).toBe('true');
        expect(issue?.getAttribute('aria-label')).toBe('Открыть issue, включено');

        act(() => {
            issue?.click();
        });
        expect(store.getComposer('new:pr')?.issue).toBe(false);
        expect(issue?.getAttribute('aria-checked')).toBe('false');
        expect(issue?.getAttribute('aria-label')).toBe('Открыть issue, выключено');
    });

    it('свитчер — первая строка композера, сразу над рамкой редактора', () => {
        const { host } = mount('markdown');
        const composer = host.querySelector('.thread-composer');
        const order = [...(composer?.children ?? [])].map((node) => node.className);

        expect(order.slice(0, 2)).toEqual(['thread-composer__issue-row', 'thread-composer__editor']);
        expect(host.querySelector('.thread-composer__context')).toBeNull();
    });

    it('показывает issue-свитчер на новом комментарии к строке', () => {
        const { host } = mount('markdown', { kind: 'line' });
        expect(host.querySelector('.thread-composer__issue')).not.toBeNull();
    });

    it('у хоста без capability строки issue нет в DOM', () => {
        const { host } = mount('markdown', { commentIssues: false });
        expect(host.querySelector('.thread-composer__issue')).toBeNull();
        expect(host.querySelector('.thread-composer__issue-row')).toBeNull();
    });

    it('показывает issue-свитчер у ответа', () => {
        const issue = mountReply().querySelector('.thread-composer__issue');
        expect(issue?.getAttribute('aria-checked')).toBe('true');
    });

    it('держит статус автосейва под полем, а не в строке кнопок', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'текст', status: 'error' });
        });
        const status = host.querySelector('.thread-composer__status-line .thread-composer__status');

        expect(status?.className).toContain('is-error');
        expect(host.querySelector('.thread-composer__actions .thread-composer__status')).toBeNull();
    });

    it('тулбар Markdown оборачивает выделение и забирает ⌘K у глобального шортката', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'текст' });
        });
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('нет Markdown textarea');
        }
        textarea.setSelectionRange(0, 5);
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(store.getComposer('new:pr')?.text).toBe('[текст](https://)');
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    it.each([
        ['⌘B', 'и', 'KeyB', '**текст**'],
        ['⌘I', 'ш', 'KeyI', '*текст*'],
        ['⌘K', 'л', 'KeyK', '[текст](https://)'],
    ])('распознаёт %s по физической клавише на кириллической раскладке', (_title, key, code, expected) => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'текст' });
        });
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('нет Markdown textarea');
        }
        textarea.setSelectionRange(0, 5);

        act(() => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, metaKey: true, bubbles: true }));
        });

        expect(store.getComposer('new:pr')?.text).toBe(expected);
    });

    it('уносит раскладку в глобальные настройки и не добавляет плейсхолдер в markdown', async () => {
        const { host, store, settings, patches } = mount('markdown');
        const visualButton = [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__layout button')].find(
            (button) => button.textContent === 'Визуально',
        );
        act(() => {
            visualButton?.click();
        });

        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        expect(settings.getSnapshot().composerLayout).toBe('visual');
        expect(patches).toEqual([{ composerLayout: 'visual' }]);
        expect(host.querySelector('.thread-composer__placeholder')?.textContent).toContain('Общее замечание');
        expect(host.querySelector('.ProseMirror')?.textContent).toBe('');
        expect(store.getComposer('new:pr')?.text).toBe('');
    });

    it('не придумывает время сохранения без savedAt', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'черновик', commentId: 'draft-1', status: 'saved' });
        });

        expect(host.querySelector('.thread-composer__status')?.textContent.trim()).toBe('сохранено как черновик');
    });

    it('у композера нового комментария нет заголовка-контекста над свитчером', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(
            store,
            'new:f1:new:10',
            {
                fileId: 'f1',
                path: 'src/app.ts',
                position: { side: 'new', line: 10, size: 3 },
            },
            true,
        );
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <NewCommentComposer
                    composerKey="new:f1:new:10"
                    store={store}
                    transport={{
                        save: () => Promise.reject(new Error('тест не сохраняет')),
                        update: () => Promise.resolve({ outcome: 'saved' as const }),
                        delete: () => Promise.resolve(),
                    }}
                    initialLayout="markdown"
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.querySelector('.thread-composer__context')).toBeNull();
        expect(host.querySelector('.thread-composer__issue-row')).not.toBeNull();
        expect(host.textContent).not.toContain('новый комментарий');
    });

    it('после ввода показывает честный статус до явного сохранения', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'несохранённый текст', status: 'idle' });
        });

        expect(host.querySelector('.thread-composer__status')?.textContent).toBe('не сохранено — ⌘⏎ или кнопка');
    });

    // Буфер черновиков: текст на сервере, хост его ещё не принял.
    it('буферный композер обещает довезти текст и предлагает повтор', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', {
                text: 'подождёт связи',
                status: 'buffered',
                bufferEntry: {
                    id: 'ck-1',
                    draft: { body: 'подождёт связи', parentId: null, anchor: null },
                    commentId: null,
                    state: 'failed',
                    error: 'Арканум: 502',
                    attempts: 1,
                    createdAt: '2026-09-03T10:00:00.000Z',
                    updatedAt: '2026-09-03T10:00:00.000Z',
                },
            });
        });

        const status = host.querySelector('.thread-composer__status');
        expect(status?.textContent).toBe('сохраним, когда связь вернётся · повторить');
        expect(status?.getAttribute('title')).toBe('Арканум: 502');
        // Текст остаётся редактируемым: буфер держит его, а не запирает.
        expect(host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown')?.disabled).toBe(false);
    });

    it('после первого сохранения закрывает поле, оставляя карточку черновика', async () => {
        const save = vi.fn(() =>
            Promise.resolve({
                outcome: 'saved' as const,
                comment: {
                    id: 'draft-1',
                    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
                    body: 'готовый черновик',
                    draft: true,
                    issue: null,
                    resolved: null,
                    createdAt: '2026-08-24T10:00:00.000Z',
                    editedAt: null,
                    replies: [],
                },
            }),
        );
        const { host, store } = mount('markdown', {
            save,
            update: () => Promise.resolve({ outcome: 'saved' as const }),
            delete: () => Promise.resolve(),
        });
        act(() => {
            store.updateComposer('new:pr', { text: 'готовый черновик' });
        });

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer__save')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer('new:pr')).toBeNull();
            });
        });

        expect(save).toHaveBeenCalledOnce();
        expect(store.getSnapshot().threads[0]?.root).toMatchObject({ id: 'draft-1', body: 'готовый черновик' });
        expect(host.querySelector('.thread-composer')).toBeNull();
    });

    it('Отмена при непустом новом тексте просит подтверждение удаления', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'не потерять', status: 'idle' });
        });
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Отмена',
        );

        act(() => {
            cancel?.click();
        });

        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Удалить черновик?');
        // Подтверждение встаёт на место кнопок: второй «Отмены» и «Сохранить черновик» на экране нет.
        expect(host.querySelector('.thread-composer__actions')).toBeNull();
        expect(host.querySelector('.thread-composer__status')).toBeNull();
        expect(store.getComposer('new:pr')).not.toBeNull();
    });

    it('Отмена правки сохранённого черновика сначала просит подтверждение', async () => {
        const update = vi.fn(() => Promise.resolve({ outcome: 'saved' as const }));
        const { host, store } = mount('markdown', {
            save: () => Promise.reject(new Error('первого сохранения здесь нет')),
            update,
            delete: () => Promise.resolve(),
        });
        act(() => {
            store.updateComposer('new:pr', {
                text: 'исходный текст',
                originalText: 'исходный текст',
                commentId: 'draft-1',
                status: 'saved',
            });
            store.updateComposer('new:pr', { text: '', status: 'idle' });
        });

        act(() => {
            [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Отмена')?.click();
        });

        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Удалить черновик?');
        expect(update).not.toHaveBeenCalled();
        expect(store.getComposer('new:pr')?.text).toBe('');

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer('new:pr')).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith('draft-1', 'исходный текст', undefined, expect.any(String));
    });

    it.each(['c', 'v'])('Markdown забирает обычную клавишу %s у глобальных шорткатов', (key) => {
        const { host } = mount('markdown');
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('нет Markdown textarea');
        }
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            textarea.dispatchEvent(
                new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true }),
            );
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    it.each(['c', 'v'])('визуальная раскладка забирает обычную клавишу %s у глобальных шорткатов', async (key) => {
        const { host } = mount('visual');
        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        const editor = host.querySelector<HTMLElement>('.ProseMirror');
        if (editor === null) {
            throw new Error('нет ProseMirror');
        }
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    it('визуальная раскладка форматирует по ⌘K и не открывает глобальную палитру', async () => {
        const { host, store } = mount('visual');
        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        const editor = host.querySelector<HTMLElement>('.ProseMirror');
        if (editor === null) {
            throw new Error('нет ProseMirror');
        }
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        await vi.waitFor(() => {
            expect(store.getComposer('new:pr')?.text).toBe('[текст](https://)');
        });
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    /**
     * Пересозданный ProseMirror ставит курсор в начало документа, и набор шёл задом наперёд.
     * Узел редактора обязан пережить смену текста композера.
     */
    it('визуальная раскладка не пересоздаёт редактор на каждую букву', async () => {
        const { host, store } = mount('visual');
        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        const editor = host.querySelector('.ProseMirror');

        for (const text of ['а', 'аб', 'абв']) {
            act(() => {
                store.updateComposer('new:pr', { text });
            });
        }

        expect(host.querySelector('.ProseMirror')).toBe(editor);
    });
});
