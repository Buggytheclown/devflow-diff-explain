import { anchor, comment, fixtureIteration, human, thread } from '@sherpa/fixtures';
import type { Comment } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createThreadStore } from './store.js';

const DRAFT: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'мой черновик',
    draft: true,
    issue: null,
    resolved: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

describe('стор тредов', () => {
    it('накладывает resolve и свой драфт на свежий снапшот', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const thread = data.threads.find((candidate) => !candidate.resolved);
        if (thread === undefined) {
            throw new Error('нет открытого треда');
        }

        store.setResolved(thread.id, true);
        store.addDraft({ body: DRAFT.body, parentId: thread.root.id, anchor: null }, DRAFT);
        store.setServerThreads(data.threads);

        const optimistic = store.getSnapshot().threads.find((candidate) => candidate.id === thread.id);
        expect(optimistic?.resolved).toBe(true);
        expect(optimistic?.root.replies.some((reply) => reply.id === DRAFT.id)).toBe(true);
    });

    it('не задваивает драфт, когда тот приехал с сервера по id', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const parent = data.threads[0];
        if (parent === undefined) {
            throw new Error('нет треда');
        }
        store.addDraft({ body: DRAFT.body, parentId: parent.root.id, anchor: null }, DRAFT);
        store.setServerThreads([
            ...data.threads.slice(1),
            { ...parent, root: { ...parent.root, replies: [...parent.root.replies, DRAFT] } },
        ]);

        const ids: string[] = [];
        const visit = (comment: Comment): void => {
            ids.push(comment.id);
            comment.replies.forEach((reply) => {
                visit(reply);
            });
        };
        store.getSnapshot().threads.forEach((thread) => {
            visit(thread.root);
        });
        expect(ids.filter((id) => id === DRAFT.id)).toHaveLength(1);
    });

    it('ввод будит только свой композер, а не подписку списка тредов', () => {
        const store = createThreadStore([], new Set(['f1']));
        const external = vi.fn();
        const local = vi.fn();
        const layout = vi.fn();
        store.subscribe(external);
        store.subscribeComposer('new:f1:new:10', local);
        store.subscribeComposers(layout);
        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        external.mockClear();
        local.mockClear();
        layout.mockClear();

        store.updateComposer('new:f1:new:10', { text: 'символ' });

        expect(local).toHaveBeenCalledTimes(1);
        expect(external).not.toHaveBeenCalled();
        expect(layout).not.toHaveBeenCalled();
    });

    it('гард публикации меняется только между сохранённым и несохранённым состоянием', () => {
        const store = createThreadStore([], new Set());
        const listener = vi.fn();
        store.subscribeComposerGuard(listener);
        store.openComposer({
            key: 'new:pr',
            threadId: null,
            parentId: null,
            anchor: null,
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);

        store.updateComposer('new:pr', { text: 'комментарий' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        store.updateComposer('new:pr', { status: 'saving' });
        expect(listener).toHaveBeenCalledTimes(1);
        store.updateComposer('new:pr', { commentId: 'draft-1', status: 'saved' });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);

        store.updateComposer('new:pr', { text: 'комментарий с правкой', status: 'idle' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(3);

        store.updateComposer('new:pr', { text: '', status: 'idle' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('гард публикации держится до завершения подтверждённого удаления карточки', () => {
        const store = createThreadStore([], new Set());

        store.beginDraftDeletion('draft-1');
        store.beginDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        store.endDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        store.endDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('серверный снапшот снимает временный откат resolve, даже если значение отличается', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => !candidate.resolved);
        if (thread === undefined) {
            throw new Error('нет открытого треда');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        store.restoreResolved(thread.id, false);

        store.setServerThreads(
            data.threads.map((candidate) =>
                candidate.id === thread.id ? { ...candidate, resolved: true } : candidate,
            ),
        );

        expect(store.getSnapshot().threads.find((candidate) => candidate.id === thread.id)?.resolved).toBe(true);
        expect(store.hasResolvedOverride(thread.id)).toBe(false);
    });

    it('дефолт раскрытости: свёрнут только закрытый тред без моего черновика', () => {
        const data = fixtureIteration('large');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const resolved = data.threads.find((candidate) => candidate.resolved);
        const open = data.threads.find((candidate) => !candidate.resolved);
        if (resolved === undefined || open === undefined) {
            throw new Error('фикстуре large нужны закрытый и открытый треды');
        }

        expect(store.getSnapshot().openThreads.has(open.id)).toBe(true);
        expect(store.getSnapshot().openThreads.has(resolved.id)).toBe(false);

        // Черновик в закрытом треде держит его раскрытым: там незаконченная работа ревьюера.
        const withDraft = createThreadStore(
            [{ ...resolved, root: { ...resolved.root, replies: [DRAFT] } }],
            new Set(),
        );
        expect(withDraft.getSnapshot().openThreads.has(resolved.id)).toBe(true);
    });

    it('логин ревьюера приходит из меты PR и черновиков не требует', () => {
        const where = anchor('d1', 'src/a.ts', { side: 'new', line: 10 });
        const root = comment({
            id: 'c-1',
            author: human('alice', 'Alice Ingram'),
            body: 'мой опубликованный',
            createdAt: '2026-08-24T09:00:00.000Z',
        });
        const store = createThreadStore([thread({ anchor: where, root })], new Set([where.fileId]));
        expect(store.getSnapshot().viewerLogin).toBeNull();

        store.setViewer('alice');
        expect(store.getSnapshot().viewerLogin).toBe('alice');

        // Черновик в тредах на личность не влияет: её знает только хост.
        store.setServerThreads([thread({ anchor: where, root: { ...root, replies: [DRAFT] } })]);
        expect(store.getSnapshot().viewerLogin).toBe('alice');

        // Хост личность забыл — «своё» больше не считается.
        store.setViewer(null);
        expect(store.getSnapshot().viewerLogin).toBeNull();
    });

    it('раскрытость двигает только ревьюер: ни Resolve, ни новый ответ её не трогают', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => !candidate.resolved && candidate.anchor !== null);
        if (thread === undefined) {
            throw new Error('нет открытого треда с якорем');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));

        store.toggleThreadOpen(thread.id);
        expect(store.isThreadOpen(thread.id)).toBe(false);

        // Новый ответ от хоста и собственный Resolve свёрнутый тред не раскрывают.
        store.setServerThreads(
            data.threads.map((candidate) =>
                candidate.id === thread.id
                    ? { ...candidate, root: { ...candidate.root, replies: [...candidate.root.replies, DRAFT] } }
                    : candidate,
            ),
        );
        store.setResolved(thread.id, true);
        expect(store.getSnapshot().openThreads.has(thread.id)).toBe(false);

        store.toggleThreadOpen(thread.id);
        expect(store.getSnapshot().openThreads.has(thread.id)).toBe(true);
    });

    it('«свернуть все» и «развернуть все» идут одним обновлением', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const ids = data.threads.map((thread) => thread.id);
        const listener = vi.fn();
        store.subscribe(listener);

        store.setThreadsOpen(ids, false);
        expect(listener).toHaveBeenCalledOnce();
        expect(store.getSnapshot().openThreads.size).toBe(0);

        store.setThreadsOpen(ids, true);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getSnapshot().openThreads.size).toBe(ids.length);

        // Менять нечего — снапшот не пересобирается.
        store.setThreadsOpen(ids, true);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('resolve по комментарию пересчитывает тред по правилу issue', () => {
        const open = thread({
            id: 't-issue',
            anchor: anchor('d1', 'a.ts', { side: 'new', line: 1 }),
            root: comment({
                id: 'c-issue',
                author: human('kai', 'Kai Kennedy'),
                body: 'замечание',
                createdAt: '2026-08-24T10:00:00.000Z',
                issue: true,
                resolved: false,
            }),
        });
        const store = createThreadStore([open], new Set([open.anchor?.fileId ?? '']));

        store.setCommentResolved('c-issue', true);
        expect(store.getSnapshot().threads[0]?.resolved).toBe(true);
        expect(store.getCommentResolved('c-issue')).toBe(true);

        store.restoreCommentResolved('c-issue', false);
        expect(store.getSnapshot().threads[0]?.resolved).toBe(false);
        expect(store.getServerCommentResolved('c-issue')).toBe(false);
    });

    it('kept-in-view хранится отдельно по файлам', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => candidate.anchor !== null);
        if (thread?.anchor === null || thread === undefined) {
            throw new Error('нет файлового треда');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));

        store.keepVisible(thread.id);
        expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(true);
        expect(store.getSnapshot().keptByFile.get(thread.anchor.fileId)?.has(thread.id)).toBe(true);

        store.releaseVisible(thread.id);
        expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(false);
    });
});
