import { fixtureIteration, GALLERY_AVATAR_BROKEN, GALLERY_AVATAR_PHOTOS, withAvatars } from '@sherpa/fixtures';
import type { Comment, FileDiff, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import type { DiffMode } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { useCardThreads, useThreadsCollapse } from '../../threads/card-threads.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { openDraftEditor } from '../../threads/draft-editor.tsx';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import type { PublishedCommentTransport } from '../../threads/transport.js';

/**
 * Треды у кода после дельта-спеки 2026-09-20 §3: маркер на кромке карточки, раскрытие под
 * строкой, Resolve у каждого issue-комментария, правка и удаление своего опубликованного.
 * Все состояния детерминированы — фикстура плюс заранее открытые композеры, без кликов.
 */

const DATA = fixtureIteration('medium');
const FILE = fileForGallery('services/orders/src/api/handlers.ts');
// Новый файл: дифф доходит до конца файла, за последней строкой нет хвостовой перемычки.
const NEW_FILE = fileForGallery('services/orders/src/infra/clock.ts');
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
// «Я» галереи — тот же ревьюер, что и в фикстуре: по нему считается «своё».
const ME = DATA.currentUser;
const BOT = { login: 'lint-bot', displayName: 'Lint Bot', bot: true, avatarUrl: null };
const OTHER = { login: 'kai', displayName: 'Kai Kennedy', bot: false, avatarUrl: null };
/** Фото для состояний с аватарами: у собеседника и бота фото есть, у ревьюера оно не загружается. */
const PHOTOS = new Map([
    [OTHER.login, GALLERY_AVATAR_PHOTOS[0]],
    [BOT.login, GALLERY_AVATAR_PHOTOS[2]],
    [ME.login, GALLERY_AVATAR_BROKEN],
]);

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
const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

export interface CodeThreadGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const CODE_THREAD_STATES: readonly CodeThreadGalleryState[] = [
    {
        id: 'code-threads-markers',
        title: 'маркеры на кромке: человек, бот, resolved, две беседы на строке',
        render: () => <CardState threads={markerThreads()} collapseAll />,
    },
    {
        id: 'code-threads-open',
        title: 'раскрытый тред: открытый и закрытый под своими строками',
        render: () => <CardState threads={openAndResolved()} />,
    },
    {
        id: 'code-threads-replies',
        title: 'ответы без линий: отступ 27px на уровень, глубже четвёртого — «↳ кому»',
        render: () => <CardState threads={[deepThread()]} />,
    },
    {
        id: 'code-threads-resolve',
        title: 'Resolve у каждого issue-комментария',
        render: () => <CardState threads={[issuesThread()]} />,
    },
    {
        id: 'code-threads-draft-reply',
        title: 'свой черновик-ответ: строка действий без «Ответить»',
        render: () => <CardState threads={[myThread()]} />,
    },
    {
        id: 'code-threads-delete-confirm',
        title: 'подтверждение удаления своего комментария',
        render: () => <CardState threads={[myThread()]} confirmDelete />,
    },
    {
        id: 'code-threads-editing',
        title: 'правка опубликованного на месте текста',
        render: () => <CardState threads={[myThread()]} editing />,
    },
    {
        id: 'code-threads-split',
        title: 'split: маркер правой половины на разделителе',
        render: () => <CardState threads={markerThreads()} mode="split" collapseAll />,
    },
    {
        id: 'code-threads-under-header',
        title: 'строка с маркером наполовину ушла под липкую шапку: маркер уходит вместе с ней',
        render: () => <CardState threads={markerThreads()} collapseAll underHeader />,
    },
    {
        id: 'code-threads-last-line-under-header',
        title: 'новый файл, тред на последней строке: шапка доехала до низа карточки и закрывает маркер',
        render: () => <CardState file={NEW_FILE} threads={lastLineThreads()} collapseAll underHeader />,
    },
    {
        id: 'code-threads-last-line',
        title: 'новый файл, тред на последней строке: маркер на нижнем углу рамки',
        render: () => <CardState file={NEW_FILE} threads={lastLineThreads()} collapseAll />,
    },
    {
        id: 'code-threads-avatars',
        title: 'маркеры с фото: у человека и у бота фото круглое',
        render: () => <CardState threads={withAvatars(markerThreads(), PHOTOS)} collapseAll />,
    },
    {
        id: 'code-threads-avatars-open',
        title: 'раскрытый тред с фото: фото, которое не загрузилось, откатывается на инициалы',
        render: () => <CardState threads={withAvatars(openAndResolved(), PHOTOS)} />,
    },
];

function CardState({
    file = FILE,
    threads,
    mode = 'unified',
    collapseAll = false,
    editing = false,
    confirmDelete = false,
    underHeader = false,
}: {
    file?: FileDiff;
    threads: readonly Thread[];
    mode?: DiffMode;
    /** Треды свёрнуты с самого начала: карточка про сами маркеры. */
    collapseAll?: boolean;
    editing?: boolean;
    confirmDelete?: boolean;
    /** Вью прокручена так, что строка первого маркера наполовину под липкой шапкой. */
    underHeader?: boolean;
}) {
    const store = useMemo(() => {
        const created = createThreadStore(threads, new Set([file.fileId]));
        created.setViewer(DATA.pr.viewer?.login ?? null);
        if (collapseAll) {
            created.setThreadsOpen(
                threads.map((thread) => thread.id),
                false,
            );
        }
        const target = threads[0];
        if (editing && target !== undefined) {
            openDraftEditor(created, target, target.root);
        }
        return created;
    }, [collapseAll, editing, file, threads]);

    return (
        <div className="gallery__viewport" ref={underHeader ? scrollMarkerUnderHeader : undefined}>
            {/* Запас снизу, чтобы до нужной строки хватило прокрутки. */}
            <div style={underHeader ? { padding: 24, paddingBottom: '70vh' } : { padding: 24 }}>
                <Card file={file} store={store} mode={mode} confirmDelete={confirmDelete} />
            </div>
        </div>
    );
}

function Card({
    file,
    store,
    mode,
    confirmDelete,
}: {
    file: FileDiff;
    store: ThreadStore;
    mode: DiffMode;
    confirmDelete: boolean;
}) {
    const model = useMemo(() => parseFileDiff(toParseRequest(file)), [file]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const actions = useMemo<ThreadActions>(
        () => ({
            transport: TRANSPORT,
            resolve: () => Promise.resolve(true),
            resolveComment: () => Promise.resolve(true),
            published: PUBLISHED,
        }),
        [],
    );
    const { threadsUnderHeader, renderAfterLine, renderLineMarker, lineThreadIds } = useCardThreads({
        model,
        rowsShown: true,
        threads: snapshot.byFile.get(file.fileId) ?? [],
        composers: [],
        store,
        actions,
        now: NOW,
        onFocusThread: () => undefined,
        initialLayout: 'markdown',
    });
    const threadsCollapse = useThreadsCollapse(store, lineThreadIds);

    return (
        <div ref={confirmDelete ? clickDelete : undefined}>
            <FileCard
                file={file}
                model={model}
                mode={mode}
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file: FILE, record: null })}
                opened
                showWhitespace={false}
                markdown={false}
                selection={null}
                threadsUnderHeader={threadsUnderHeader}
                renderAfterLine={renderAfterLine}
                renderLineMarker={renderLineMarker}
                threadsCollapse={threadsCollapse}
                actions={ACTIONS}
            />
        </div>
    );
}

/** Прокрутка — состояние экрана, а не сценарий: строка первого маркера встаёт наполовину под шапку. */
function scrollMarkerUnderHeader(viewport: HTMLDivElement | null): void {
    if (viewport === null) {
        return;
    }
    const marker = viewport.querySelector('.thread-marker');
    const header = viewport.querySelector('.file-card__header');
    if (marker === null || header === null) {
        return;
    }
    const markerBox = marker.getBoundingClientRect();
    const markerTop = markerBox.top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTop = markerTop - header.getBoundingClientRect().height + markerBox.height / 2;
}

/** Подтверждение удаления — состояние экрана, а не сценарий: галерея жмёт ссылку за ревьюера. */
function clickDelete(host: HTMLDivElement | null): void {
    host?.querySelector<HTMLButtonElement>('.thread__action--delete')?.click();
}

function threadOf(
    id: string,
    line: number,
    root: Partial<Comment> & Pick<Comment, 'id' | 'body'>,
    resolved = false,
    file: FileDiff = FILE,
): Thread {
    return {
        id,
        anchor: { fileId: file.fileId, path: file.path, position: { side: 'new', line, size: 1 } },
        resolved,
        resolvedBy: resolved ? OTHER.login : null,
        outdated: false,
        pinnedTo: null,
        root: {
            author: OTHER,
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-08-31T10:00:00.000Z',
            editedAt: null,
            replies: [],
            ...root,
        },
    };
}

function markerThreads(): Thread[] {
    return [
        threadOf('marker-person', 48, {
            id: 'marker-person-root',
            body: 'Клиенту нужен обратный отсчёт, а не абсолютное время.',
            replies: [
                {
                    id: 'marker-person-reply',
                    author: ME,
                    body: 'Согласен, перевёл в остаток.',
                    draft: false,
                    issue: null,
                    resolved: null,
                    createdAt: '2026-08-31T10:05:00.000Z',
                    editedAt: null,
                    replies: [],
                },
            ],
        }),
        threadOf('marker-bot', 49, {
            id: 'marker-bot-root',
            author: BOT,
            body: 'Ветка отказа не покрыта тестом.',
        }),
        threadOf(
            'marker-resolved',
            50,
            {
                id: 'marker-resolved-root',
                body: 'naming: drop() → invalidate().',
                issue: true,
                resolved: true,
            },
            true,
        ),
        threadOf('marker-second', 48, {
            id: 'marker-second-root',
            author: ME,
            body: 'И заодно вынести константу окна в конфиг.',
        }),
    ];
}

/** Тред на последней строке нового файла: у добавленного файла номер последней строки — число добавлений. */
function lastLineThreads(): Thread[] {
    return [
        threadOf(
            'last-line',
            NEW_FILE.additions,
            { id: 'last-line-root', body: 'Экспорт синглтона прячет зависимость от часов.' },
            false,
            NEW_FILE,
        ),
    ];
}

function openAndResolved(): Thread[] {
    const [person, , resolved] = markerThreads();
    return [person, resolved].filter((thread): thread is Thread => thread !== undefined);
}

/**
 * Ветка на шесть уровней: отступ растёт по 27px до четвёртого, дальше стоит на месте,
 * а адресата называет подпись «↳ кому» в шапке сообщения.
 */
function deepThread(): Thread {
    const reply = (
        id: string,
        author: typeof ME,
        body: string,
        minute: number,
        replies: Comment[] = [],
    ): Comment => ({
        id,
        author,
        body,
        draft: false,
        issue: null,
        resolved: null,
        createdAt: `2026-08-31T10:${String(minute).padStart(2, '0')}:00.000Z`,
        editedAt: null,
        replies,
    });
    return threadOf('deep', 48, {
        id: 'deep-root',
        body: 'Почему окно — класс, а не чистая функция от (order, now)?',
        replies: [
            reply('deep-1', ME, 'Дальше идёт окно по категории товара, а это уже состояние.', 10, [
                reply('deep-2', OTHER, 'Тогда конструктор пусть принимает конфиг, а не голый Clock.', 15, [
                    reply('deep-3', ME, 'Сделаю в следующем PR, этот и так большой.', 20, [
                        reply('deep-4', OTHER, 'Сошлитесь тут на тикет, иначе потеряется.', 25, [
                            reply('deep-5', ME, '#2281.', 30, [
                                reply('deep-6', OTHER, 'Спасибо.', 35),
                            ]),
                        ]),
                    ]),
                ]),
            ]),
            reply('deep-side', OTHER, 'Вторая ветка на том же родителе: конфиг заодно уносит флаг из домена.', 12),
        ],
    });
}

function issuesThread(): Thread {
    return threadOf('issues', 48, {
        id: 'issues-root',
        body: 'Цикла повторов ничто не ограничивает.',
        issue: true,
        resolved: true,
        replies: [
            {
                id: 'issues-reply',
                author: ME,
                body: 'И новый потолок не покрыт тестом.',
                draft: false,
                issue: true,
                resolved: false,
                createdAt: '2026-08-31T10:20:00.000Z',
                editedAt: null,
                replies: [],
            },
        ],
    });
}

/** Свой опубликованный комментарий: логин ревьюера галерея задаёт черновиком-ответом. */
function myThread(): Thread {
    return threadOf('mine', 48, {
        id: 'mine-root',
        author: ME,
        body: 'Поле remainingMs здесь вводит клиента в заблуждение.',
        replies: [
            {
                id: 'mine-draft',
                author: ME,
                body: 'Проверю ещё раз перед Ship.',
                draft: true,
                issue: null,
                resolved: null,
                createdAt: '2026-08-31T10:25:00.000Z',
                editedAt: null,
                replies: [],
            },
        ],
    });
}

function fileForGallery(path: string): FileDiff {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`фикстуре medium нужен ${path}`);
    }
    return file;
}
