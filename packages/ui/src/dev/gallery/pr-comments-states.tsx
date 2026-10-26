import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { useCallback, useMemo } from 'react';

import { PrCommentsModal } from '../../components/pr-comments-modal.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { openDraftEditor } from '../../threads/draft-editor.tsx';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import type { PublishedCommentTransport } from '../../threads/transport.js';

/**
 * Модалка «Комментарии к PR» после дельта-спеки 2026-09-20 §4: треды уровня PR карточками,
 * свёрнутая строка с превью, ответ на месте. Ширина считается от ширины окна
 * (`clamp(620px, 68vw, 1120px)`), поэтому карточкой её не показать — она проверяется в e2e.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const ME = DATA.pr.viewer ?? { login: 'avery', displayName: 'Avery Vance', bot: false, avatarUrl: null };
const OTHER = { login: 'kai', displayName: 'Kai Kennedy', bot: false, avatarUrl: null };
const BOT = { login: 'lint-bot', displayName: 'Lint Bot', bot: true, avatarUrl: null };

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('галерея не сохраняет')),
    update: () => Promise.resolve({ outcome: 'saved' }),
    delete: () => Promise.resolve(),
};
const PUBLISHED: PublishedCommentTransport = {
    setResolved: () => Promise.resolve(),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

const DRAFT = thread('pr-draft', '2026-08-31T11:42:00.000Z', {
    id: 'pr-draft-root',
    author: ME,
    body: 'Нужно явно зафиксировать поведение при повторном Ship.',
    draft: true,
    issue: true,
});
const WITH_REPLIES = thread('pr-replies', '2026-08-31T11:18:00.000Z', {
    id: 'pr-replies-root',
    author: OTHER,
    body: 'Проверил границы транзакции — **порядок блокировок** теперь однозначный.',
    issue: true,
    replies: [
        reply('pr-replies-1', ME, 'Тогда снимаю замечание: `DISPATCH_LOCK` берётся после чтения состояния.', [
            reply('pr-replies-2', OTHER, 'Да, и ретрай теперь идёт по той же ветке.'),
        ]),
    ],
});
/** Ветка на шесть уровней: отступ упирается в потолок, и в шапке появляется «↳ кому». */
const DEEP = thread('pr-deep', '2026-08-31T10:05:00.000Z', {
    id: 'pr-deep-root',
    author: OTHER,
    body: 'Порядок блокировок стоит описать в `docs/architecture.md` — здесь он неочевиден.',
    replies: [
        reply('pr-deep-1', ME, 'Добавлю абзац в раздел про очередь.', [
            reply('pr-deep-2', OTHER, 'И схему переходов заодно.', [
                reply('pr-deep-3', ME, 'Схему рисовать долго, давайте списком.', [
                    reply('pr-deep-4', OTHER, 'Списком годится, но с примером на ретрае.', [
                        reply('pr-deep-5', ME, 'Пример добавил.', [
                            reply('pr-deep-6', OTHER, 'Теперь читается.'),
                        ]),
                    ]),
                ]),
            ]),
        ]),
    ],
});
const MINE = thread('pr-mine', '2026-08-31T10:40:00.000Z', {
    id: 'pr-mine-root',
    author: ME,
    body: 'Опишите удаление ключа конфига в релизных заметках.',
});
const BOT_THREAD = thread('pr-bot', '2026-08-31T09:20:00.000Z', {
    id: 'pr-bot-root',
    author: BOT,
    body: 'Линтер не видит изменений в `CODEOWNERS`: зона ответственности осталась прежней.',
});
const RESOLVED = thread(
    'pr-resolved',
    '2026-08-31T08:30:00.000Z',
    {
        id: 'pr-resolved-root',
        author: OTHER,
        body: 'Миграция конфига не описана в документации — почините до мержа.',
        issue: true,
        resolved: true,
        replies: [reply('pr-resolved-1', ME, 'Добавил раздел в `docs/edit-window.md`.')],
    },
    true,
);

export const PR_COMMENTS_STATES = [
    {
        id: 'pr-comments-modal-threads',
        title: 'черновик, тред с ответами, бот и свёрнутый resolved',
        render: () => <ModalState threads={[DRAFT, WITH_REPLIES, BOT_THREAD, RESOLVED]} />,
    },
    {
        id: 'pr-comments-modal-nesting',
        title: 'вложенность: отступ 27px на уровень, глубже четвёртого — «↳ кому»',
        render: () => <ModalState threads={[DEEP]} />,
    },
    {
        id: 'pr-comments-modal-reply',
        title: 'ответ на месте: композер под сообщением, свитчер issue',
        render: () => <ModalState threads={[WITH_REPLIES]} click="reply" />,
    },
    {
        id: 'pr-comments-modal-editing',
        title: 'правка своего комментария на месте текста',
        render: () => <ModalState threads={[MINE, WITH_REPLIES]} editing={MINE.id} />,
    },
    {
        id: 'pr-comments-modal-delete-confirm',
        title: 'подтверждение удаления своего комментария',
        render: () => <ModalState threads={[MINE]} click="delete" />,
    },
    {
        id: 'pr-comments-modal-empty',
        title: 'пусто',
        render: () => <ModalState threads={[]} />,
    },
] as const;

/**
 * Ссылка, которую галерея жмёт за ревьюера: подтверждение удаления живёт в стейте самого
 * треда, ответ на месте — в композере стора; клик собирает оба состояния одним способом.
 */
const CLICK_TARGET = {
    reply: '.thread__row--reply .thread__row-actions button',
    delete: '.thread__action--delete',
} as const;

function ModalState({
    threads,
    editing,
    click,
}: {
    threads: readonly Thread[];
    /** Открытая правка корня этого треда. */
    editing?: string;
    click?: keyof typeof CLICK_TARGET;
}) {
    const store = useMemo(() => {
        const created = createThreadStore(threads, FILE_IDS);
        created.setViewer(ME.login);
        const target = threads.find((thread) => thread.id === editing);
        if (target !== undefined) {
            openDraftEditor(created, target, target.root);
        }
        return created;
    }, [editing, threads]);
    // Модалка живёт порталом в `body`, поэтому ссылка ищется в последней смонтированной.
    const press = useCallback(
        (host: HTMLDivElement | null): void => {
            if (host === null || click === undefined) {
                return;
            }
            const modals = document.querySelectorAll<HTMLElement>('.pr-comments-modal');
            modals[modals.length - 1]?.querySelector<HTMLButtonElement>(CLICK_TARGET[click])?.click();
        },
        [click],
    );
    const actions = useMemo<ThreadActions>(
        () => ({
            transport: TRANSPORT,
            commentIssues: true,
            resolve: () => Promise.resolve(true),
            resolveComment: () => Promise.resolve(true),
            published: PUBLISHED,
        }),
        [],
    );
    return (
        <div ref={press}>
            <PrCommentsModal
                pr={DATA.pr}
                store={store}
                transport={TRANSPORT}
                actions={actions}
                now={NOW}
                initialLayout="markdown"
                onClose={() => undefined}
            />
        </div>
    );
}

function reply(id: string, author: Comment['author'], body: string, replies: Comment[] = []): Comment {
    return {
        id,
        author,
        body,
        draft: false,
        issue: false,
        resolved: false,
        createdAt: '2026-08-31T11:30:00.000Z',
        editedAt: null,
        replies,
    };
}

function thread(
    id: string,
    createdAt: string,
    root: Partial<Comment> & Pick<Comment, 'id' | 'body' | 'author'>,
    resolved = false,
): Thread {
    return {
        id,
        anchor: null,
        resolved,
        resolvedBy: resolved ? OTHER.login : null,
        outdated: false,
        pinnedTo: null,
        root: {
            draft: false,
            // Фикстура medium умеет issue: у комментария без него статус выключен, а не отсутствует.
            issue: false,
            resolved: false,
            createdAt,
            editedAt: null,
            replies: [],
            ...root,
        },
    };
}
