// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, DraftBufferEntry, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from '../threads/composer.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';
import { PR_COMPOSER_KEY, replyComposerKey } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import { createThreadStore } from '../threads/store.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';

/**
 * Модалка «Комментарии к PR» (docs/design/SPEC-changes-2026-09-20.md §4): треды уровня PR
 * карточками, свёрнутая строка с превью, ответ на месте. Анатомия сообщений и действия —
 * общие с тредами у кода, они проверяются в `threads/thread-list.test.tsx`.
 */

const DATA = fixtureIteration('medium');
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const HUMAN = { login: 'alice', displayName: 'Элис Ингрэм', bot: false, avatarUrl: null } as const;
const BOT = { login: 'ai-review-bot', displayName: 'AI Review', bot: true, avatarUrl: null } as const;
const PUBLISHED = thread({
    id: 'pr-published',
    author: HUMAN,
    body: 'Опубликованный **PR-level** комментарий.',
    draft: false,
    createdAt: '2026-08-31T10:00:00.000Z',
    replies: [
        comment({
            id: 'pr-published-reply',
            author: HUMAN,
            body: 'Ответ в опубликованном треде.',
            draft: false,
            createdAt: '2026-08-31T10:30:00.000Z',
        }),
    ],
});
const DRAFT = thread({
    id: 'pr-draft',
    author: HUMAN,
    body: 'Мой черновик к PR.',
    draft: true,
    createdAt: '2026-08-31T11:00:00.000Z',
});
const BOT_PR = thread({
    id: 'pr-bot',
    author: BOT,
    body: 'Бот-тред уровня PR.',
    draft: false,
    createdAt: '2026-08-31T09:00:00.000Z',
});
const RESOLVED = thread({
    id: 'pr-resolved',
    author: HUMAN,
    body: 'Закрытое замечание к PR.',
    draft: false,
    createdAt: '2026-08-31T08:30:00.000Z',
    resolved: true,
    replies: [
        comment({
            id: 'pr-resolved-reply',
            author: HUMAN,
            body: 'Поправил.',
            draft: false,
            createdAt: '2026-08-31T08:40:00.000Z',
        }),
    ],
});
const DISAPPEARED = thread({
    id: 'disappeared',
    author: HUMAN,
    body: 'Тред исчезнувшего файла.',
    draft: false,
    createdAt: '2026-08-31T08:00:00.000Z',
    anchor: { fileId: 'missing-file', path: 'removed.ts', position: null },
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom не умеет прокрутку: модалка подводит к вопросу про сброс, и это единственное её место.
const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.style.overflow = '';
});

const BUFFERED_PR: DraftBufferEntry = {
    id: 'ck-pr',
    draft: { body: 'Комментарий к PR, который ждёт связи.', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'Арканум: 502',
    attempts: 1,
    createdAt: '2026-08-31T11:30:00.000Z',
    updatedAt: '2026-08-31T11:30:00.000Z',
};

describe('модалка комментариев к PR', () => {
    it('показывает все PR-level треды новым сверху, с ответами и без тредов файлов', () => {
        mountModal([PUBLISHED, DRAFT, BOT_PR, DISAPPEARED]);

        expect(threadIds()).toEqual([DRAFT.id, PUBLISHED.id, BOT_PR.id]);
        expect(document.body.textContent).toContain('Мой черновик к PR.');
        expect(document.body.textContent).toContain('Бот-тред уровня PR.');
        // Ответы видны без клика: треды вне диффа короткие (§4, чеклист §7.9).
        expect(document.body.textContent).toContain('Ответ в опубликованном треде.');
        expect(document.body.textContent).not.toContain('Тред исчезнувшего файла.');
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
        expect(document.body.style.overflow).toBe('hidden');
    });

    // Шапка отдаёт всё место заголовку: счётчика черновиков и «свернуть все» в ней нет (§6a).
    it('в шапке нет счётчика черновиков и сводки нерешённых', () => {
        mountModal([PUBLISHED, DRAFT], {}, () => undefined, [BUFFERED_PR]);

        const header = document.querySelector('.pr-comments-modal__header')?.textContent ?? '';
        expect(header).toBe('Комментарии к PRвне диффа · 4821');
        expect(document.querySelector('.pr-comments-modal__draft-count')).toBeNull();
        expect(document.querySelector('.pr-comments-modal__open-threads')).toBeNull();
    });

    it('черновик и бот раскрыты, resolved-тред свёрнут в строку с превью', () => {
        mountModal([PUBLISHED, DRAFT, BOT_PR, RESOLVED]);

        expect(collapsedIds()).toEqual([RESOLVED.id]);
        const row = threadNode(RESOLVED.id);
        expect(row?.querySelector('.thread__preview')?.textContent).toBe('Закрытое замечание к PR.');
        expect(row?.querySelector('.thread__reply-count')?.textContent).toBe('1 ответ');
        expect(row?.textContent).not.toContain('Поправил.');
        expect(row?.querySelector('.thread__chevron')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('шеврон раскрывает и сворачивает тред, клик по превью — тоже', () => {
        mountModal([RESOLVED, PUBLISHED]);

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__preview')?.click();
        });
        expect(collapsedIds()).toEqual([]);
        expect(threadNode(RESOLVED.id)?.textContent).toContain('Поправил.');

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
        });
        expect(collapsedIds()).toEqual([RESOLVED.id]);
    });

    it('«Ответить» разворачивает композер со свитчером issue под своим сообщением', () => {
        mountModal([PUBLISHED]);

        const rows = [...(threadNode(PUBLISHED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Ответить')?.click();
        });

        const composer = rows[1]?.querySelector('.thread-composer');
        expect(composer).not.toBeNull();
        expect(rows[0]?.querySelector('.thread-composer')).toBeNull();
        expect(composer?.querySelector('[role="switch"]')?.getAttribute('aria-label')).toBe(
            'Открыть issue, включено',
        );
        // Заголовка-контекста у ответа на месте нет: сообщение над ним и так видно.
        expect(composer?.querySelector('.thread-composer__context')).toBeNull();
    });

    it('шеврон сперва закрывает пустой композер ответа, сворачивает тред следующий клик', async () => {
        mountModal([PUBLISHED]);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Ответить')?.click();
        });
        await act(async () => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
            await Promise.resolve();
        });

        expect(threadNode(PUBLISHED.id)?.querySelector('.thread-composer')).toBeNull();
        expect(collapsedIds()).toEqual([]);

        act(() => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
        });
        expect(collapsedIds()).toEqual([PUBLISHED.id]);
    });

    it('шеврон не уносит набранный ответ в свёрнутую строку, а спрашивает про сброс', async () => {
        const { store } = mountModal([PUBLISHED]);

        const rows = [...(threadNode(PUBLISHED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Ответить')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(PUBLISHED.id), { text: 'Почти дописал.' });
        });
        await act(async () => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
            await Promise.resolve();
        });

        expect(collapsedIds()).toEqual([]);
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))?.text).toBe('Почти дописал.');
        expect(threadNode(PUBLISHED.id)?.textContent).toContain('Удалить черновик?');
    });

    it('размонтирование закрывает пустой композер ответа', () => {
        const { store } = mountModal([PUBLISHED]);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Ответить')?.click();
        });
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))).not.toBeNull();

        const unmount = mounted.pop();
        unmount?.();

        expect(store.getComposer(replyComposerKey(PUBLISHED.id))).toBeNull();
    });

    it('набранный ответ переживает закрытие модалки и остаётся под своим сообщением', () => {
        const { store } = mountModal([RESOLVED]);

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__preview')?.click();
        });
        const rows = [...(threadNode(RESOLVED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Ответить')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(RESOLVED.id), { text: 'Ещё допишу.' });
        });
        // Тред помечен свёрнутым (шеврон у кода), но композер с текстом держит его раскрытым.
        act(() => {
            store.setThreadsOpen([RESOLVED.id], false);
        });
        expect(collapsedIds()).toEqual([]);

        const unmount = mounted.pop();
        unmount?.();
        expect(store.getComposer(replyComposerKey(RESOLVED.id))?.text).toBe('Ещё допишу.');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        mountModal([RESOLVED], {}, () => undefined, [], store);

        const reopened = [...(threadNode(RESOLVED.id)?.querySelectorAll('.thread__row') ?? [])];
        expect(collapsedIds()).toEqual([]);
        expect(reopened[0]?.querySelector('.thread-composer')).toBeNull();
        expect(reopened[1]?.querySelector<HTMLTextAreaElement>('.thread-composer textarea')?.value).toBe(
            'Ещё допишу.',
        );
    });

    it('Esc гасит открытый композер, а модалку закрывает только следующий', async () => {
        const onClose = vi.fn();
        mountModal([PUBLISHED], {}, onClose);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Ответить')?.click();
        });
        const textarea = threadNode(PUBLISHED.id)?.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea).not.toBeNull();

        await act(async () => {
            textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(threadNode(PUBLISHED.id)?.querySelector('textarea')).toBeNull();
        // Тред по Esc не сворачивается — сворачивает только шеврон.
        expect(collapsedIds()).toEqual([]);

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('✕ с набранным ответом спрашивает про сброс, а не закрывает модалку молча', async () => {
        const onClose = vi.fn();
        const { store } = mountModal([PUBLISHED], {}, onClose);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Ответить')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(PUBLISHED.id), { text: 'Ещё пишу.' });
        });

        await act(async () => {
            closeButton()?.click();
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(threadNode(PUBLISHED.id)?.textContent).toContain('Удалить черновик?');
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))?.text).toBe('Ещё пишу.');
        // Вопрос может быть ниже видимой части списка — модалка к нему подводит.
        expect(scrollIntoView).toHaveBeenCalled();

        await act(async () => {
            confirmAction(threadNode(PUBLISHED.id), 'Удалить')?.click();
            await Promise.resolve();
        });
        await act(async () => {
            closeButton()?.click();
            await Promise.resolve();
        });
        expect(onClose).toHaveBeenCalledOnce();
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('Esc мимо редактора и клик по фону тоже не уносят набранный текст в невидимый гард', async () => {
        const onClose = vi.fn();
        const { store } = mountModal([PUBLISHED], {}, onClose);
        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, { text: 'Новый комментарий к PR.' });
        });

        // Фокус на ✕: Esc идёт не через редактор, а сразу на слой модалки.
        await act(async () => {
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector('.pr-comments-modal__composer')?.textContent).toContain(
            'Удалить черновик?',
        );

        await act(async () => {
            confirmAction(document.querySelector('.pr-comments-modal__composer'), 'Отмена')?.click();
            await Promise.resolve();
        });
        await act(async () => {
            document
                .querySelector<HTMLElement>('.pr-comments-modal__overlay')
                ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(store.getComposer(PR_COMPOSER_KEY)?.text).toBe('Новый комментарий к PR.');
    });

    it('второй Esc закрывает модалку после сброса пустого нижнего композера', async () => {
        const onClose = vi.fn();
        mountModal([], {}, onClose);
        const textarea = document.querySelector<HTMLTextAreaElement>('.pr-comments-modal__composer textarea');

        await act(async () => {
            textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('композер нового комментария идёт без заголовка-контекста', () => {
        mountModal([]);

        const composer = document.querySelector('.pr-comments-modal__composer .thread-composer');
        expect(composer).not.toBeNull();
        expect(composer?.querySelector('.thread-composer__context')).toBeNull();
    });

    it('черновик правится и удаляется ссылками под текстом, без карандаша в шапке', async () => {
        const deleteDraft = vi.fn(() => Promise.resolve());
        const { store } = mountModal([DRAFT, PUBLISHED], { delete: deleteDraft });

        const draftRow = threadNode(DRAFT.id)?.querySelector('.thread__row');
        expect(draftRow?.querySelector('[data-icon="pencil"]')).toBeNull();
        expect(draftRow?.querySelector('[data-icon="trash"]')).toBeNull();

        act(() => {
            action(draftRow, 'Редактировать')?.click();
        });
        expect(store.getComposer(`edit:${DRAFT.root.id}`)).not.toBeNull();
        act(() => {
            store.closeComposer(`edit:${DRAFT.root.id}`);
        });

        act(() => {
            action(draftRow, 'Удалить')?.click();
        });
        expect(document.body.textContent).toContain('Удалить черновик? Он не будет опубликован');
        await act(async () => {
            draftRow?.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
            await Promise.resolve();
        });

        expect(deleteDraft).toHaveBeenCalledWith(DRAFT.root.id);
        expect(threadNode(DRAFT.id)).toBeNull();
    });

    it('не показывает карточку черновика, открытого в нижнем композере', () => {
        const { store } = mountModal([DRAFT, PUBLISHED]);

        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, {
                text: DRAFT.root.body,
                commentId: DRAFT.root.id,
                status: 'saved',
            });
        });

        expect(threadNode(DRAFT.id)).toBeNull();
        expect(threadNode(PUBLISHED.id)).not.toBeNull();
    });

    it('размонтирование закрывает невидимый edit-композер с ошибкой', () => {
        const { store } = mountModal([DRAFT]);
        act(() => {
            action(threadNode(DRAFT.id)?.querySelector('.thread__row'), 'Редактировать')?.click();
            store.updateComposer(`edit:${DRAFT.root.id}`, { text: 'Не сохранено.', status: 'error' });
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        const unmount = mounted.pop();
        unmount?.();

        expect(store.getComposer(`edit:${DRAFT.root.id}`)).toBeNull();
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    // Композера у записи может не быть вовсе (черновик правился у строки прошлой итерации),
    // а ship она держит: этот список — единственное место, где её видно и можно снять.
    it('показывает буферные записи со сбросом и повтором, включая правки', async () => {
        const discardBuffered = vi.fn(() => Promise.resolve());
        const retryBuffered = vi.fn(() => Promise.resolve());
        mountModal([PUBLISHED, DRAFT], { discardBuffered, retryBuffered }, () => undefined, [
            BUFFERED_PR,
            { ...BUFFERED_PR, id: 'ck-edit', commentId: 'draft-9' },
        ]);

        const section = document.querySelector('.pr-comments-modal__buffered');
        expect(section?.textContent).toContain('2 черновика ждут связи с сервером');
        expect(section?.querySelectorAll('.pr-comments-modal__buffered-item')).toHaveLength(2);

        await act(async () => {
            section?.querySelector<HTMLButtonElement>('.pr-comments-modal__delete-button')?.click();
            await Promise.resolve();
        });
        expect(discardBuffered).toHaveBeenCalledWith('ck-pr');

        await act(async () => {
            section?.querySelector<HTMLButtonElement>('.pr-comments-modal__keep-button')?.click();
            await Promise.resolve();
        });
        expect(retryBuffered).toHaveBeenCalledWith('ck-pr');
    });

    it('Tab возвращает фокус внутрь модалки, если активен body', () => {
        mountModal([]);
        const close = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть комментарии к PR"]');
        document.body.tabIndex = -1;
        document.body.focus();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

        expect(document.activeElement).toBe(close);
        document.body.removeAttribute('tabindex');
    });
});

function threadIds(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-thread-id]')].map(
        (node) => node.dataset.threadId ?? '',
    );
}

function collapsedIds(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-thread-id].is-collapsed')].map(
        (node) => node.dataset.threadId ?? '',
    );
}

function threadNode(threadId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
}

/** Ссылка-действие под текстом сообщения: «Ответить», «Редактировать», «Удалить». */
function action(row: Element | null | undefined, label: string): HTMLButtonElement | null {
    return (
        [...(row?.querySelectorAll<HTMLButtonElement>('.thread__row-actions button') ?? [])].find(
            (button) => button.textContent === label,
        ) ?? null
    );
}

/** Кнопка «сбросить» / «продолжить» в вопросе композера про сброс черновика. */
function confirmAction(scope: Element | null | undefined, label: string): HTMLButtonElement | null {
    return (
        [...(scope?.querySelectorAll<HTMLButtonElement>('.thread-composer .thread__delete-confirm button') ?? [])].find(
            (button) => button.textContent === label,
        ) ?? null
    );
}

function closeButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('[aria-label="Закрыть комментарии к PR"]');
}

function mountModal(
    threads: readonly Thread[],
    transportOverrides: Partial<ComposerTransport> = {},
    onClose: () => void = () => undefined,
    draftBuffer: readonly DraftBufferEntry[] = [],
    /** Стор прошлого открытия: модалку закрывают и открывают заново, стор переживает это. */
    reuse: ThreadStore | null = null,
): { readonly store: ThreadStore } {
    // Раскладка markdown детерминирована: обычная textarea вместо ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const store = reuse ?? createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId)));
    const transport: ComposerTransport = {
        save: () => Promise.reject(new Error('тест не сохраняет новый черновик')),
        update: () => Promise.resolve({ outcome: 'saved' as const }),
        delete: () => Promise.resolve(),
        ...transportOverrides,
    };
    // Esc модалки живёт на лестнице реестра: без провайдера закрывать её нечем.
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={registry}>
                <SettingsProvider store={settings}>
                    <PrCommentsModal
                        pr={DATA.pr}
                        store={store}
                        transport={transport}
                        draftBuffer={draftBuffer}
                        now={NOW}
                        onClose={onClose}
                    />
                </SettingsProvider>
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });
    return { store };
}

function comment({
    id,
    author,
    body,
    draft,
    createdAt,
    replies = [],
}: {
    id: string;
    author: Comment['author'];
    body: string;
    draft: boolean;
    createdAt: string;
    replies?: Comment['replies'];
}): Comment {
    return {
        id,
        author,
        body,
        draft,
        issue: null,
        resolved: null,
        createdAt,
        editedAt: null,
        replies,
    };
}

function thread({
    id,
    author,
    body,
    draft,
    createdAt,
    replies = [],
    anchor = null,
    resolved = false,
}: {
    id: string;
    author: Comment['author'];
    body: string;
    draft: boolean;
    createdAt: string;
    replies?: Comment['replies'];
    anchor?: Thread['anchor'];
    resolved?: boolean;
}): Thread {
    return {
        id,
        anchor,
        resolved,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: comment({ id: `${id}-comment`, author, body, draft, createdAt, replies }),
    };
}
