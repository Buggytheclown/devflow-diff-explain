import {
    anchor,
    bot,
    comment,
    fixtureIteration,
    GALLERY_AVATAR_BROKEN,
    GALLERY_AVATAR_PHOTOS,
    human,
    thread,
    withAvatars,
} from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { createSessionStore } from '../../session/session-store.js';
import type { ComposerTransport } from '../../threads/composer.js';
import { createThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { OverviewDiscussion } from '../../views/overview-discussion.tsx';
import './discussion-states.css';

/**
 * Карточка «Обсуждение» на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e). Колонка 360px — та же ширина,
 * что в макете: на ней и проверяется, что длинная ссылка и блок кода её не ломают.
 */

const MEDIUM = fixtureIteration('medium');
const MEDIUM_FILE_IDS = new Set(MEDIUM.diff.files.map((file) => file.fileId));
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

const DIFF_ID = 'gallery-1e';
const ALIVE = 'services/orders/src/domain/edit-window.ts';
const GONE = 'services/orders/src/legacy/edit-window-old.ts';
const SCALE_FILE_IDS = new Set([anchor(DIFF_ID, ALIVE).fileId]);

const BOTS = [
    bot('ai-review-bot', 'AI Review'),
    bot('lint-bot', 'Lint Bot'),
    bot('sec-scanner', 'Security Scanner'),
    bot('perf-watch', 'Perf Watch'),
    bot('style-guard', 'Style Guard'),
    bot('deps-bot', 'Deps Bot'),
];
const PEOPLE = [human('morgan', 'Morgan Price'), human('ada', 'Ada Ortiz')];
/** Отвечает в чужом треде и ни одного своего не открывает — строка участника у него всё равно есть. */
const REPLIER = human('drew', 'Drew Kim');

const LONG_LINK =
    'https://github.com/quillmart/quillmart/blob/9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316/services/orders/src/domain/edit-window.ts#L118-L146';

/**
 * Масштаб §1e: 86 тредов, из них 83 бот-треда шести источников, три от людей — и два из этих
 * трёх живут вне диффа (ушедший файл и уровень PR). Девять участников: шесть ботов и три
 * человека, третий из которых только отвечает в чужом треде. Список показывает шесть строк
 * и прячет остальных за «ещё N».
 */
const SCALE_THREADS: readonly Thread[] = [
    ...Array.from({ length: 83 }, (_, index) => {
        const source = BOTS[index % BOTS.length] ?? BOTS[0];
        if (source === undefined) {
            throw new Error('в галерее нужен хотя бы один бот');
        }
        return thread({
            id: `bot-${String(index)}`,
            anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: 10 + index }),
            resolved: index % 5 === 0,
            root: comment({
                id: `bot-${String(index)}-root`,
                author: source,
                body: 'Возможная утечка контекста в обработчике окна редактирования.',
                createdAt: `2026-08-2${String(index % 4)}T09:${String(10 + (index % 40))}:00.000Z`,
            }),
        });
    }),
    thread({
        id: 'human-at-code',
        anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: 118 }),
        root: comment({
            id: 'human-at-code-root',
            author: PEOPLE[0] ?? human('morgan'),
            body: 'Здесь окно считается от `createdAt`, а не от `scheduledAt` — так и задумано?',
            createdAt: '2026-08-24T11:20:00.000Z',
        }),
    }),
    thread({
        id: 'human-gone-file',
        anchor: anchor(DIFF_ID, GONE, { side: 'new', line: 42 }),
        root: comment({
            id: 'human-gone-file-root',
            author: PEOPLE[0] ?? human('morgan'),
            body: [
                '### Старый расчёт окна',
                '',
                'Файл уехал из PR, но вопрос остался: старая ветка считала окно так,',
                'и это поведение где-то ещё живёт.',
                '',
                '```ts',
                'const deadline = createdAt + EDIT_WINDOW_MINUTES * 60_000; // 30 минут от создания',
                '```',
                '',
                `Ссылка на исходник: ${LONG_LINK}`,
            ].join('\n'),
            createdAt: '2026-08-24T10:40:00.000Z',
        }),
    }),
    thread({
        id: 'human-pr-level',
        anchor: null,
        root: comment({
            id: 'human-pr-level-root',
            author: PEOPLE[1] ?? human('ada'),
            body: [
                'Прошлась по PR целиком: логика окна ок, но описание стоит дополнить —',
                'из него не видно, что окно считается в минутах и обрезается по расписанию доставки.',
                'Отдельно проверьте миграцию: она переносит уже созданные заказы без окна,',
                'и на них ручка отдаст 400 вместо понятного текста.',
                'Ссылка на обсуждение в чате: ' + LONG_LINK,
            ].join('\n'),
            createdAt: '2026-08-24T11:50:00.000Z',
            replies: [
                comment({
                    id: 'human-pr-level-reply-1',
                    author: REPLIER,
                    body: 'Описание дополнил, про минуты и обрезку по расписанию доставки написал явно.',
                    createdAt: '2026-08-24T11:55:00.000Z',
                }),
                comment({
                    id: 'human-pr-level-reply-2',
                    author: PEOPLE[1] ?? human('ada'),
                    body: 'Спасибо. Миграцию всё-таки проверьте отдельно — на старых заказах ручка отдаёт 400.',
                    createdAt: '2026-08-24T11:58:00.000Z',
                }),
            ],
        }),
    }),
];

/** Тот же масштаб с фото: у двух людей и одного бота фото есть, у отвечающего оно не загружается. */
const AVATAR_THREADS = withAvatars(
    SCALE_THREADS,
    new Map([
        ['morgan', GALLERY_AVATAR_PHOTOS[0]],
        ['ada', GALLERY_AVATAR_PHOTOS[1]],
        ['ai-review-bot', GALLERY_AVATAR_PHOTOS[2]],
        [REPLIER.login, GALLERY_AVATAR_BROKEN],
    ]),
);

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
    update: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
    delete: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
};

function Card({
    threads,
    fileIds,
    outsideOpen = false,
    replyTo,
}: {
    threads: readonly Thread[];
    fileIds: ReadonlySet<string>;
    outsideOpen?: boolean;
    /** Тред, у которого композер ответа открыт с самого начала: состояние рендерится, а не кликается. */
    replyTo?: string;
}) {
    const session = useMemo(
        () =>
            createSessionStore({
                initial: {
                    view: 'overview',
                    filter: 'all',
                },
            }),
        [],
    );
    const store = useMemo(() => {
        const created = createThreadStore(threads, fileIds);
        created.setViewer(MEDIUM.pr.viewer?.login ?? null);
        const target = threads.find((candidate) => candidate.id === replyTo);
        if (target !== undefined) {
            openReply(created, target, true);
        }
        return created;
    }, [fileIds, replyTo, threads]);
    return (
        <div className="gallery-discussion-column">
            <OverviewDiscussion
                threads={threads}
                fileIds={fileIds}
                session={session}
                store={store}
                transport={TRANSPORT}
                now={GALLERY_NOW}
                loading={false}
                error={null}
                onWritePrComment={() => undefined}
                outsideOpenByDefault={outsideOpen}
            />
        </div>
    );
}

export const DISCUSSION_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'discussion-empty',
        title: 'обсуждение: ни одного треда',
        render: () => <Card threads={EMPTY} fileIds={MEDIUM_FILE_IDS} />,
    },
    {
        id: 'discussion-people',
        title: 'обсуждение: только люди (фикстура medium)',
        render: () => <Card threads={MEDIUM.threads} fileIds={MEDIUM_FILE_IDS} />,
    },
    {
        id: 'discussion-scale',
        title: 'обсуждение: масштаб 86 тредов, люди и боты',
        render: () => <Card threads={SCALE_THREADS} fileIds={SCALE_FILE_IDS} />,
    },
    {
        id: 'discussion-outside-open',
        title: 'обсуждение: «вне диффа» раскрыто, ответ пишется',
        render: () => (
            <Card
                threads={SCALE_THREADS}
                fileIds={SCALE_FILE_IDS}
                outsideOpen
                replyTo="human-pr-level"
            />
        ),
    },
    {
        id: 'discussion-avatars',
        title: 'обсуждение: фото участников, бота тоже; битое фото — инициалы',
        render: () => <Card threads={AVATAR_THREADS} fileIds={SCALE_FILE_IDS} outsideOpen />,
    },
];

const EMPTY: readonly Thread[] = [];
