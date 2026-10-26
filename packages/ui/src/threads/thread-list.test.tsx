// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, CommentDraft, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import { ThreadPinProvider } from '../iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from '../iterations/thread-pin.tsx';
import { composerControllerFor } from './composer.js';
import { openDraftEditor } from './draft-editor.tsx';
import { flattenThread } from './model.js';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';
import { openReply, OutsideThreads, ThreadList } from './thread-list.tsx';

/**
 * Тело комментария рендерится markdown-ом: боты пишут заголовками, списками,
 * ссылками и блоками кода, и в карточке треда это обязано быть разметкой, а не сырой строкой.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const TRANSPORT = {
    save: () => Promise.reject(new Error('в тесте не сохраняем')),
    update: () => Promise.reject(new Error('в тесте не сохраняем')),
    delete: () => Promise.reject(new Error('в тесте не сохраняем')),
};

const PUBLISHED = {
    setResolved: () => Promise.resolve(),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

const DRAFT: Comment = {
    id: 'draft-reply',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'Проверю гонку ещё раз перед Ship.',
    draft: true,
    issue: null,
    resolved: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

function render(threads: readonly Thread[], store = createThreadStore(threads, FILE_IDS)): string {
    return renderWithStore(threads, store);
}

function renderWithStore(threads: readonly Thread[], store: ThreadStore): string {
    return renderToStaticMarkup(
        <ThreadList
            threads={threads}
            store={store}
            actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
            now={NOW}
        />,
    );
}

function threadOf(login: string): Thread {
    const thread = DATA.threads.find((candidate) => candidate.root.author.login === login);
    if (thread === undefined) {
        throw new Error(`в фикстуре medium нет треда от ${login}`);
    }
    return thread;
}

describe('тело комментария', () => {
    it('бот-разметка становится элементами: заголовок, список, ссылка, блок кода', () => {
        const html = render([threadOf('ai-review-bot')]);
        const body = html.slice(html.indexOf('thread__body'));

        expect(body).toContain('<h5 class="md-heading md-h5">PCI: unmasked PAN in retained logs</h5>');
        expect(body).toContain('<ul class="md-list">');
        expect(body).toContain('<strong class="md-strong">Severity:</strong>');
        expect(body).toContain('<code class="md-code">logs/checkout-*.jsonl</code>');
        expect(body).toContain('<pre class="md-pre" data-lang="ts">');
        // Голый URL — ссылка новой вкладкой без реферера.
        expect(body).toContain('target="_blank" rel="noreferrer"');
        expect(body).not.toContain('`');
    });

    it('ссылка в квадратных скобках доезжает ссылкой, а не текстом', () => {
        const body = render([threadOf('lint-bot')]);

        expect(body).toContain(
            '<a class="md-link" href="https://eslint.org/docs/latest/rules/no-fallthrough" target="_blank" rel="noreferrer">no-fallthrough</a>',
        );
    });

    it('плоский текст человека остаётся одним абзацем', () => {
        const body = render([threadOf('kai')]);

        expect(body).toContain('<p class="md-p">Why is the window a class');
        expect(body).toContain('<code class="md-code">Clock</code>');
    });
});

describe('диапазонный комментарий', () => {
    it('показывает диапазон в мета треда', () => {
        const source = threadOf('kai');
        if (source.anchor?.position == null) {
            throw new Error('у треда нет позиции');
        }
        const ranged: Thread = {
            ...source,
            anchor: { ...source.anchor, position: { ...source.anchor.position, size: 3 } },
        };
        const html = render([ranged]);
        const last = source.anchor.position.line + 2;

        expect(html).toContain(`:${String(source.anchor.position.line)}–${String(last)} ·`);
    });
});

describe('правка комментария у строки', () => {
    it('чужой опубликованный комментарий правки и удаления не предлагает', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS));

        expect(html).not.toContain('Редактировать');
        expect(html).not.toContain('Удалить');
        expect(html).toContain('Ответить');
        expect(html).toContain('Resolve');
    });

    it('свой опубликованный комментарий правится и удаляется только при editPublished', () => {
        const source = threadOf('kai');
        // Своё узнаётся по личности ревьюера из меты PR — черновиков в треде нет.
        const mine: Thread = {
            ...source,
            root: { ...source.root, author: DRAFT.author, replies: [] },
        };
        const store = createThreadStore([mine], FILE_IDS);
        store.setViewer(DRAFT.author.login);
        const withEdit = renderToStaticMarkup(
            <ThreadList
                threads={[mine]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );
        expect(withEdit).toContain(`Редактировать комментарий ${mine.root.id}`);
        expect(withEdit).toContain(`Удалить комментарий ${mine.root.id}`);

        expect(renderWithStore([mine], store)).not.toContain(`Редактировать комментарий ${mine.root.id}`);
    });

    it('сообщение с ответами не удаляется: ссылки «Удалить» нет, «Редактировать» остаётся', () => {
        const source = threadOf('kai');
        const reply = { ...source.root, id: 'reply-of-mine', author: source.root.author, replies: [] };
        const mine: Thread = {
            ...source,
            root: { ...source.root, author: DRAFT.author, replies: [reply] },
        };
        const store = createThreadStore([mine], FILE_IDS);
        store.setViewer(DRAFT.author.login);
        const html = renderToStaticMarkup(
            <ThreadList
                threads={[mine]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );
        expect(html).toContain(`Редактировать комментарий ${mine.root.id}`);
        expect(html).not.toContain(`Удалить комментарий ${mine.root.id}`);
    });

    it('чужой опубликованный комментарий не правится', () => {
        const foreign = threadOf('kai');
        const store = createThreadStore([foreign], FILE_IDS);
        store.setViewer(DRAFT.author.login);

        const html = renderToStaticMarkup(
            <ThreadList
                threads={[foreign]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );

        expect(html).not.toContain(`Редактировать комментарий ${foreign.root.id}`);
        expect(html).not.toContain(`Удалить комментарий ${foreign.root.id}`);
    });

    it('Resolve стоит у каждого issue-комментария, когда хост умеет резолв по комментарию', () => {
        const source = threadOf('kai');
        const withIssue: Thread = {
            ...source,
            root: {
                ...source.root,
                issue: true,
                resolved: false,
                replies: [{ ...DRAFT, id: 'reply-issue', draft: false, issue: true, resolved: true }],
            },
        };
        const store = createThreadStore([withIssue], FILE_IDS);
        const html = renderToStaticMarkup(
            <ThreadList
                threads={[withIssue]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    resolveComment: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );

        expect([...html.matchAll(/thread__resolve(?:"| is-on")/g)]).toHaveLength(2);
        expect(html).toContain('Resolved');
        // Без capability кнопка одна — у корня треда, и она про тред целиком.
        const single = renderWithStore([withIssue], store);
        expect([...single.matchAll(/thread__resolve(?:"| is-on")/g)]).toHaveLength(1);
    });

    it('свой черновик правится на месте с синей кромкой и чипом', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'line-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        let root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });

        const edit = host.querySelector<HTMLButtonElement>('[aria-label="Править черновик line-draft"]');
        expect(host.querySelector('[aria-label="Удалить черновик line-draft"]')).not.toBeNull();
        expect(host.textContent).not.toContain('Resolve');
        expect(host.textContent).not.toContain('Копировать ссылку');
        act(() => {
            edit?.click();
        });

        const row = host.querySelector('.thread__row.is-editing');
        expect(row).not.toBeNull();
        expect(row?.querySelector('.thread__chip--editing')?.textContent).toBe('правится');
        expect(row?.querySelector('.thread-composer__markdown')).not.toBeNull();
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);

        act(() => {
            root.unmount();
        });
        expect(store.getComposer('edit:line-draft')).not.toBeNull();

        root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });
        expect(host.querySelector('.thread__row.is-editing .thread-composer__markdown')).not.toBeNull();

        act(() => {
            store.closeComposer('edit:line-draft');
        });
        expect(host.querySelector('.thread__row.is-editing')).toBeNull();
        expect(host.querySelector('.thread__chip--editing')).toBeNull();
        expect(host.querySelector('.thread__body')?.textContent).toContain(DRAFT.body);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('свой черновик получает правку и удаление без действий опубликованного', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'outside-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const html = renderWithStore([draft], createThreadStore([draft], FILE_IDS));

        expect(html).toContain('Править черновик outside-draft');
        expect(html).toContain('Удалить черновик outside-draft');
        expect(html).not.toContain('Resolve');
        expect(html).not.toContain('Ответить<');
    });

    it('опубликованный outside-тред сохраняет resolve и ответ', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS));

        expect(html).toContain('Resolve');
        expect(html).toContain('Ответить');
    });

    it('корзина удаляет черновик только после подтверждения внутри карточки', async () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'line-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const remove = vi.fn(() => Promise.resolve());
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: { save: TRANSPORT.save, update: TRANSPORT.update, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Удалить черновик line-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Удалить черновик?');
        expect(remove).not.toHaveBeenCalled();

        await act(async () => {
            const confirm = [...host.querySelectorAll<HTMLButtonElement>('.thread__delete-confirm button')].find(
                (button) => button.textContent === 'Удалить',
            );
            confirm?.click();
            await vi.waitFor(() => {
                expect(store.getSnapshot().threads).toHaveLength(0);
            });
        });
        expect(remove).toHaveBeenCalledWith('line-draft');

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('Esc в подтверждении = «Отмена»: тред остаётся раскрытым, удаления не было', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'esc-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const remove = vi.fn(() => Promise.resolve());
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{
                        transport: { ...TRANSPORT, delete: remove },
                        resolve: () => Promise.resolve(true),
                    }}
                    now={NOW}
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Удалить черновик esc-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')).not.toBeNull();

        act(() => {
            host.querySelector('.thread__delete-confirm')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });

        expect(host.querySelector('.thread__delete-confirm')).toBeNull();
        expect(host.querySelector('.thread')).not.toBeNull();
        expect(remove).not.toHaveBeenCalled();

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('корзина удаляет черновик только после подтверждения строкой в карточке', async () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            id: 'outside-draft-thread',
            root: { ...source.root, id: 'outside-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const pendingDelete = deferred<undefined>();
        const remove = vi.fn(() => pendingDelete.promise);
        store.openComposer({
            key: 'stale:outside-draft',
            threadId: draft.id,
            parentId: null,
            anchor: null,
            text: DRAFT.body,
            originalText: DRAFT.body,
            commentId: 'outside-draft',
            status: 'saved',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: { ...TRANSPORT, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Удалить черновик outside-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain(
            'Удалить черновик? Он не будет опубликован',
        );
        expect(remove).not.toHaveBeenCalled();

        act(() => {
            host.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
        });
        expect(remove).toHaveBeenCalledWith('outside-draft');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(store.getComposer('stale:outside-draft')).not.toBeNull();

        await act(async () => {
            pendingDelete.resolve(undefined);
            await vi.waitFor(() => {
                expect(store.getSnapshot().threads.some((thread) => thread.root.id === 'outside-draft')).toBe(false);
            });
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
        expect(store.getComposer('stale:outside-draft')).toBeNull();
        expect(host.querySelector('.thread__delete-confirm')).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

describe('черновик ответа', () => {
    it('в outside-контексте черновик-ответ — обычная строка с карандашом', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const html = render([thread]);

        expect(html).toContain(`Править черновик ${DRAFT.id}`);
        expect(html).toContain(`Удалить черновик ${DRAFT.id}`);
        expect(html).toContain(DRAFT.body);
    });

    it('карандаш outside-ответа открывает ровно один редактор этого черновика', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>(`[aria-label="Править черновик ${DRAFT.id}"]`)?.click();
        });

        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(store.getComposer(`edit:${DRAFT.id}`)).not.toBeNull();
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            openReply(store, thread, false, DRAFT);
        });
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('у кода «Ответить» разворачивает композер под своим сообщением и вкладывает ответ', () => {
        const thread = threadOf('kai');
        const rows = flattenThread(thread.root);
        const first = rows[0]?.comment.id;
        const second = rows[1]?.comment.id;
        if (first === undefined || second === undefined) {
            throw new Error('фикстурному треду нужны корень и ответ');
        }
        const store = createThreadStore([thread], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        const draw = (): void => {
            act(() => {
                root.render(
                    <ThreadList
                        threads={[thread]}
                        store={store}
                        actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                        now={NOW}
                        initialLayout="markdown"
                    />,
                );
            });
        };
        draw();

        const replyUnder = (commentId: string): void => {
            act(() => {
                const row = host.querySelector(`.thread__row[data-comment-id="${commentId}"]`);
                [...(row?.querySelectorAll<HTMLButtonElement>('.thread__row-actions button') ?? [])]
                    .find((button) => button.textContent === 'Ответить')
                    ?.click();
            });
            draw();
        };
        const composerRowId = (): string | null =>
            host.querySelector('.thread-composer')?.closest('.thread__row')?.getAttribute('data-comment-id') ?? null;

        replyUnder(first);
        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(first);
        expect(composerRowId()).toBe(first);

        // Тот же композер переезжает под другое сообщение вместе с родителем ответа.
        replyUnder(second);
        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(second);
        expect(composerRowId()).toBe(second);
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('сохранённый черновик-ответ не переезжает к другому родителю', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);

        openReply(store, thread, false, DRAFT);
        const before = store.getComposer(`reply:${thread.id}`);
        expect(before?.commentId).toBe(DRAFT.id);
        expect(before?.parentId).toBe(thread.root.id);

        openReply(store, thread, false, DRAFT, 'other-comment');

        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(thread.root.id);
        expect(store.getComposer(`reply:${thread.id}`)?.replyUnder).toBe(thread.root.id);
    });

    // Закрытый композер — тот же случай: «Ответить» под чужим сообщением возвращает черновик
    // на его место, а не переподвешивает его к другому родителю.
    it('«Ответить» под чужим сообщением открывает сохранённый черновик на своём месте', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const other = flattenThread(thread.root)[1]?.comment.id;
        if (other === undefined || other === DRAFT.id) {
            throw new Error('фикстурному треду нужен ответ помимо черновика');
        }
        const store = createThreadStore([thread], FILE_IDS);

        openReply(store, thread, false, undefined, other);

        expect(store.getComposer(`reply:${thread.id}`)).toMatchObject({
            commentId: DRAFT.id,
            parentId: thread.root.id,
            replyUnder: thread.root.id,
        });
    });

    // Родитель уходит на хост в первом же save: сменить его потом нельзя, поэтому композер
    // с момента записи стоит там, где его сохранили.
    it('композер не переезжает, пока первое сохранение ответа в полёте', async () => {
        const thread = threadOf('kai');
        const rows = flattenThread(thread.root);
        const first = rows[0]?.comment.id;
        const second = rows[1]?.comment.id;
        if (first === undefined || second === undefined) {
            throw new Error('фикстурному треду нужны корень и ответ');
        }
        const store = createThreadStore([thread], FILE_IDS);
        const key = `reply:${thread.id}`;
        const pending = deferred<{ outcome: 'saved'; comment: Comment }>();
        const save = vi.fn((_draft: CommentDraft, _clientKey: string) => pending.promise);

        openReply(store, thread, false, null, first);
        store.updateComposer(key, { text: 'Ответ корню.' });
        const saving = composerControllerFor({
            store,
            key,
            transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete },
        }).saveNow();

        openReply(store, thread, false, null, second);

        expect(store.getComposer(key)?.parentId).toBe(first);
        expect(store.getComposer(key)?.replyUnder).toBe(first);
        pending.resolve({ outcome: 'saved', comment: { ...DRAFT, id: 'saved-reply', body: 'Ответ корню.' } });
        await saving;
        expect(save.mock.calls[0]?.[0].parentId).toBe(first);
        expect(store.getComposer(key)?.parentId).toBe(first);
    });

    it('после открытия предлагает сохранить изменения', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, DRAFT);

        const html = renderWithStore([thread], store);

        expect(html).toContain('Сохранить изменения');
        expect(html).not.toContain(`Править черновик ${DRAFT.id}`);

        openDraftEditor(store, thread, DRAFT);
        expect(store.getComposer(`reply:${thread.id}`)).not.toBeNull();
        expect(store.getComposer(`edit:${DRAFT.id}`)).toBeNull();
    });

    it('первое сохранение ответа закрывает поле и оставляет одну карточку черновика', async () => {
        const thread = threadOf('kai');
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, null);
        store.updateComposer(`reply:${thread.id}`, { text: 'Новый ответ.' });
        const save = vi.fn(() =>
            Promise.resolve({ outcome: 'saved' as const, comment: { ...DRAFT, id: 'new-draft-reply', body: 'Новый ответ.' } }),
        );
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer__save')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer(`reply:${thread.id}`)).toBeNull();
            });
        });

        expect(save).toHaveBeenCalledOnce();
        act(() => {
            root.render(
                <ThreadList
                    threads={store.getSnapshot().threads}
                    store={store}
                    actions={{ transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(0);
        expect(host.querySelectorAll('[aria-label="Править черновик new-draft-reply"]')).toHaveLength(1);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('Отмена правки ответа возвращает исходный текст и не удаляет Comment', async () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, DRAFT);
        store.updateComposer(`reply:${thread.id}`, { text: 'испорчено', status: 'idle' });
        const update = vi.fn(() => Promise.resolve({ outcome: 'saved' as const }));
        const remove = vi.fn(() => Promise.resolve());
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: { save: TRANSPORT.save, update, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Отмена',
        );

        act(() => {
            cancel?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Удалить черновик?');
        expect(update).not.toHaveBeenCalled();

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer .thread__delete-confirm-button')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer(`reply:${thread.id}`)).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith(DRAFT.id, DRAFT.body, undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

/** В прошлой итерации тред читается, но ни одна запись из него не уходит. */
describe('тред в режиме чтения', () => {
    it('Resolve, правка и удаление черновика выключены с одной причиной', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const html = renderToStaticMarkup(
            <ReadOnlyIterationProvider readOnly>
                <ThreadList
                    threads={[thread]}
                    store={createThreadStore([thread], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ReadOnlyIterationProvider>,
        );

        expect(html).toContain('title="только в активной итерации"');
        expect(/<button[^>]*thread__resolve[^>]*disabled/.exec(html)).not.toBeNull();
        expect(html).toContain('aria-label="Править черновик draft-reply" disabled="" title="только в активной итерации"');
        expect(html).toContain('aria-label="Удалить черновик draft-reply" disabled="" title="только в активной итерации"');
    });
});

describe('пин треда к прошлому коммиту', () => {
    const V2 = fixtureIteration('medium', 1);
    const PINNED = (() => {
        const thread = V2.threads.find((candidate) => candidate.outdated && candidate.pinnedTo !== null);
        if (thread?.pinnedTo == null) {
            throw new Error('фикстуре medium нужен устаревший тред с пином');
        }
        return thread;
    })();
    const ACTIVE_DIFF_ID = V2.diff.diffId;
    const PIN_COMMIT = PINNED.pinnedTo?.commit ?? '';

    function renderPinned(thread: Thread, pin: Partial<ThreadPinContextValue> = {}): string {
        return renderToStaticMarkup(
            <ThreadPinProvider
                value={{
                    activeDiffId: ACTIVE_DIFF_ID,
                    viewingDiffId: ACTIVE_DIFF_ID,
                    openAtPin: () => undefined,
                    ...pin,
                }}
            >
                <ThreadList
                    threads={[thread]}
                    store={createThreadStore([thread], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ThreadPinProvider>,
        );
    }

    it('чип и действие появляются, когда пин не совпадает с активной итерацией', () => {
        const html = renderPinned(PINNED);

        expect(html).toContain(`закреплён за ${PIN_COMMIT.slice(0, 7)}`);
        expect(html).toContain(`title="${PIN_COMMIT}"`);
        expect(html).toContain('Показать на старом коммите');
    });

    it('пин совпал с активной итерацией — ни чипа, ни действия', () => {
        const html = renderPinned(PINNED, { activeDiffId: PINNED.pinnedTo?.diffId ?? null });

        expect(html).not.toContain('закреплён за');
        expect(html).not.toContain('Показать на старом коммите');
    });

    it('pinnedTo === null — хост не знает итерации якоря, говорить нечего', () => {
        const html = renderPinned({ ...PINNED, pinnedTo: null });

        expect(html).not.toContain('закреплён за');
        expect(html).not.toContain('Показать на старом коммите');
    });

    it('активная итерация неизвестна — сравнивать не с чем', () => {
        const html = renderPinned(PINNED, { activeDiffId: null });

        expect(html).not.toContain('закреплён за');
    });

    it('уже смотрим итерацию пина — остаётся чип без перехода', () => {
        const html = renderPinned(PINNED, { viewingDiffId: PINNED.pinnedTo?.diffId ?? null });

        expect(html).toContain('закреплён за');
        expect(html).not.toContain('Показать на старом коммите');
    });

    it('клик по действию открывает тред на итерации его пина', () => {
        const openAtPin = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadPinProvider value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin }}>
                    <ThreadList
                        threads={[PINNED]}
                        store={createThreadStore([PINNED], FILE_IDS)}
                        actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                        now={NOW}
                    />
                </ThreadPinProvider>,
            );
        });

        const action = host.querySelector<HTMLButtonElement>('.thread__pin-action');
        act(() => {
            action?.click();
        });

        expect(openAtPin).toHaveBeenCalledWith(PINNED.pinnedTo?.diffId, PINNED.id);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('группа целиком из тредов с якорями называет ушедшие файлы и несёт то же действие', () => {
        const html = renderToStaticMarkup(
            <ThreadPinProvider
                value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin: () => undefined }}
            >
                <OutsideThreads
                    threads={[PINNED]}
                    store={createThreadStore([PINNED], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    defaultOpen
                />
            </ThreadPinProvider>,
        );

        expect(html).toContain('1 тред на файлах, которых больше нет в PR');
        expect(html).toContain('Показать на старом коммите');
    });

    it('коммит пина называет чип треда: у композера своей шапки больше нет', () => {
        const withDraft = {
            ...PINNED,
            root: { ...PINNED.root, replies: [...PINNED.root.replies, DRAFT] },
        };
        const store = createThreadStore([withDraft], FILE_IDS);
        openReply(store, withDraft, false, DRAFT);

        const html = renderToStaticMarkup(
            <ThreadPinProvider
                value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin: () => undefined }}
            >
                <ThreadList
                    threads={[withDraft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ThreadPinProvider>,
        );

        expect(html).toContain(`закреплён за ${PIN_COMMIT.slice(0, 7)}`);
        expect(html).not.toContain('thread-composer__context');
    });

    it('бот уровня PR в группе — заголовок остаётся про дифф', () => {
        const bot = V2.threads.find((thread) => thread.anchor === null && thread.root.author.bot) ?? {
            ...PINNED,
            anchor: null,
        };
        const html = renderToStaticMarkup(
            <OutsideThreads
                threads={[bot, PINNED]}
                store={createThreadStore([bot, PINNED], FILE_IDS)}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={NOW}
            />,
        );

        expect(html).toContain('2 треда вне диффа');
    });
});
