import {
    fileContentOf,
    fixtureIteration,
    GALLERY_AVATAR_BROKEN,
    GALLERY_AVATAR_PHOTOS,
    withAvatar,
    withAvatars,
} from '@sherpa/fixtures';
import type { FixtureIterationView, FixtureName } from '@sherpa/fixtures';
import type { Comment, FileDiff, Lens, Thread, UiFileProgress, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { changedLinesOf } from '../../progress/read-state.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import { asFetched } from './fetched.js';

/**
 * Состояния вью «Полный дифф» целиком: левая панель с фильтрами и деревом плюс карточки.
 * Всё считается из фикстур синхронно — ни сервера, ни воркера, ни таймеров, ни `localStorage`:
 * открытие состояния даёт один и тот же кадр.
 */

interface WorkspaceStateProps {
    readonly fixture: FixtureName;
    readonly filter?: string;
    /** Линзы вместо фикстурных: так собираются конфигурации, которых в фикстурах нет. */
    readonly lenses?: UiReviewLensesResponse;
    /** Пути файлов, отмеченных просмотренными: на них видно read-сводку каталогов. */
    readonly viewed?: readonly string[];
    /** Готовые записи прогресса: ими собираются состояния, которых ручными отметками не сделать. */
    readonly records?: readonly UiFileProgress[];
    /** Большая фикстура разбирается лениво — 64 синхронных разбора кадр не переживёт. */
    readonly preloadModels?: boolean;
    /** Оставить в диффе один файл: так собирается однофайловый PR любого вида. */
    readonly onlyPath?: string;
    /** Сузить дифф до перечисленных файлов: так собирается форма дерева, которой в фикстурах нет. */
    readonly paths?: readonly string[];
    /**
     * Переименовать файлы поверх фикстуры: имён нужной длины в фикстурах нет, а заводить их там
     * ради одного кадра дороже. Членство в линзах переезжает вместе с путём, поэтому теги остаются.
     */
    readonly renameTo?: Readonly<Record<string, string>>;
    /** Пути файлов, свёрнутых вручную. */
    readonly collapsed?: readonly string[];
    readonly showThreads?: boolean;
    readonly threads?: readonly Thread[];
    readonly prepareThreads?: (store: ThreadStore, threads: readonly Thread[]) => void;
    /** Фото по логину — автору PR в шапке и авторам тредов. */
    readonly photos?: ReadonlyMap<string, string>;
}

// Стабильные умолчания: смена темы не должна создавать новый store и терять разобранные модели.
const EMPTY_VIEWED: readonly string[] = [];
const EMPTY_RECORDS: readonly UiFileProgress[] = [];

function WorkspaceState({
    fixture,
    filter = 'all',
    lenses,
    viewed = EMPTY_VIEWED,
    records = EMPTY_RECORDS,
    preloadModels = true,
    onlyPath,
    paths,
    renameTo,
    collapsed,
    showThreads = false,
    threads,
    prepareThreads,
    photos,
}: WorkspaceStateProps) {
    const data = useMemo(() => {
        const source = asFetched(fixtureIteration(fixture));
        const keep =
            onlyPath === undefined
                ? paths
                : [onlyPath];
        const narrowed =
            keep === undefined
                ? source
                : {
                      ...source,
                      diff: { ...source.diff, files: source.diff.files.filter((file) => keep.includes(file.path)) },
                  };
        const renamed = renameTo === undefined ? narrowed : renamePaths(narrowed, renameTo);
        const authorPhoto = photos?.get(renamed.pr.author.login);
        return authorPhoto === undefined
            ? renamed
            : { ...renamed, pr: { ...renamed.pr, author: withAvatar(renamed.pr.author, authorPhoto) } };
    }, [fixture, onlyPath, paths, photos, renameTo]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter } }), [filter]);

    const shownThreads = useMemo(() => {
        const source = showThreads ? (threads ?? data.threads) : [];
        return photos === undefined ? source : withAvatars(source, photos);
    }, [data.threads, photos, showThreads, threads]);
    const threadStore = useMemo(() => {
        const created = createThreadStore(shownThreads, new Set(data.diff.files.map((file) => file.fileId)));
        prepareThreads?.(created, shownThreads);
        return created;
    }, [data.diff.files, prepareThreads, shownThreads]);

    const store = useMemo(() => {
        const created = createDiffViewStore({
            files: data.diff.files,
            ...(collapsed === undefined
                ? {}
                : {
                      collapsed: new Map(
                          data.diff.files
                              .filter((file) => collapsed.includes(file.path))
                              .map((file) => [file.fileId, true]),
                      ),
                  }),
        });
        if (preloadModels) {
            for (const file of data.diff.files) {
                created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
            }
        }
        const marked = new Set(viewed);
        created.setProgress([
            ...data.diff.files
                .filter((file) => marked.has(file.path))
                .map((file) => ({ fileId: file.fileId, viewed: true, seenRanges: [] })),
            ...records,
        ]);
        return created;
    }, [collapsed, data, preloadModels, records, viewed]);

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={data.pr}
                diff={data.diff}
                threads={shownThreads}
                threadStore={threadStore}
                lenses={lenses ?? { ownership: data.ownership, extra: data.extraLenses, ownershipSource: 'CODEOWNERS' }}
                prKey={`fixture-${fixture}`}
                session={session}
                store={store}
                threadNow={GALLERY_NOW}
                // Парсер синхронный: воркер в галерее не нужен, кадр от него не зависит.
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                // Ручки прогресса в галерее нет: запись остаётся в сторе, как и выбор диффмода.
                onSetViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
const DRAFT_SAVED_AT = Date.parse('2026-08-24T10:00:00.000Z');

/**
 * Каталог `generated` с единственным файлом рядом с обычными файлами `payments`: каталог стоит
 * своей строкой, а файл под ним несёт только имя (SPEC-theming-2026-09-12 §6a). Это тот самый
 * кейс, который до T7 склеивался в `/psp-schema.…`.
 */
const SINGLE_FILE_DIR_PATHS = [
    'services/orders/src/payments/card-token.ts',
    'services/orders/src/payments/pci-audit.ts',
    'services/orders/src/payments/generated/psp-schema.ts',
];

/**
 * Имя длиннее фикстурного: в узкой панели (320px на 1440px) оно с двумя тегами не влезает,
 * и видно, что обрезается именно имя — с конца, без осиротевшего слэша от каталога.
 */
const SINGLE_FILE_DIR_RENAME = {
    'services/orders/src/payments/generated/psp-schema.ts':
        'services/orders/src/payments/generated/psp-settlement-authorize-schema.ts',
};

/** Пути глубины до 3 от корня панели: проверка того, что имена файлов влезают целиком. */
const DEEP_PATHS = [
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/__tests__/edit-policy.test.ts',
    'services/orders/src/domain/__tests__/edit-window.test.ts',
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/domain/order.ts',
];

const MEDIUM_VIEWED = [
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/schemas.ts',
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/order.ts',
];

/** Плюс верхний файл диффа: активная строка прочитана, а её подпись всё равно не приглушена. */
const READ_DIMMED_VIEWED = [...MEDIUM_VIEWED, 'services/orders/docs/edit-window.md'];

/**
 * Дифф без `.github/`, чтобы верхним был обычный `docs/edit-window.md`: иначе первым встаёт
 * машинный `ci.yml`, а его подпись приглушена как generated.
 */
const READ_DIMMED_PATHS = fixtureIteration('medium')
    .diff.files.map((file) => file.path)
    .filter((path) => !path.startsWith('.github/'));

/**
 * Частичное покрытие файла: диапазоны собираются из его же изменённых строк, поэтому «N из M»
 * в тултипе — настоящий счёт модели, а не выдуманное число.
 */
function partialRecord(fixture: FixtureName, path: string, share: number): UiFileProgress {
    const file = fileOf(fixture, path);
    const changed = changedLinesOf(parseFileDiff(toParseRequest(file)));
    const covered = [...(changed?.new ?? [])].sort((a, b) => a - b).slice(0, Math.ceil(share * (changed?.new.size ?? 0)));
    return {
        fileId: file.fileId,
        viewed: false,
        seenRanges: covered.map((line) => ({ side: 'new' as const, start: line, end: line })),
    };
}

/** Явно снятая отметка машинного файла (un-pin, docs/architecture.md §7.7): запись есть, значение — «не прочитан». */
function unpinnedRecord(fixture: FixtureName, path: string): UiFileProgress {
    return { fileId: fileOf(fixture, path).fileId, viewed: false, seenRanges: [] };
}

function fileOf(fixture: FixtureName, path: string): FileDiff {
    const file = fixtureIteration(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре ${fixture} нет файла ${path}`);
    }
    return file;
}

/** Опубликованный, но пустой в этом PR аудит-скоуп: в фикстурах такой конфигурации нет. */
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: true,
    note: 'В этом PR нет файлов аудит-скоупа PCI DSS.',
    zones: null,
};

/** Фикстура под новыми именами файлов: вместе с путём переезжает его членство в линзах. */
function renamePaths(
    view: FixtureIterationView,
    renameTo: Readonly<Record<string, string>>,
): FixtureIterationView {
    const rename = (path: string): string => renameTo[path] ?? path;
    const renameLens = (value: Lens): Lens => ({
        ...value,
        paths: value.paths.map(rename),
        zones: value.zones?.map((zone) => ({ ...zone, paths: zone.paths.map(rename) })) ?? null,
    });
    return {
        ...view,
        diff: { ...view.diff, files: view.diff.files.map((file) => ({ ...file, path: rename(file.path) })) },
        ownership: view.ownership === null ? null : renameLens(view.ownership),
        extraLenses: view.extraLenses.map(renameLens),
    };
}

function prepareDraftComposer(store: ThreadStore, threads: readonly Thread[]): void {
    const thread = threads.find((candidate) => !candidate.resolved && !candidate.root.author.bot);
    if (thread === undefined) {
        return;
    }
    const draft: Comment = {
        id: 'gallery-draft',
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
        body: 'Добавлю проверку на границе окна и обновлю тест.',
        draft: true,
        issue: null,
        resolved: null,
        createdAt: '2026-08-24T10:00:00.000Z',
        editedAt: null,
        replies: [],
    };
    store.addDraft({ body: draft.body, parentId: thread.root.id, anchor: null }, draft);
    store.openComposer({
        key: `reply:${thread.id}`,
        threadId: thread.id,
        parentId: thread.root.id,
        anchor: null,
        text: draft.body,
        commentId: draft.id,
        status: 'saved',
        savedAt: DRAFT_SAVED_AT,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

function prepareFailedComposer(store: ThreadStore): void {
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    const anchor = { fileId: file.fileId, path: file.path, position: { side: 'new' as const, line: 48, size: 1 } };
    store.openComposer({
        key: `new:${file.fileId}:new:48`,
        threadId: null,
        parentId: null,
        anchor,
        issue: true,
        text: 'Поле remainingMs здесь вводит клиента в заблуждение.',
        commentId: null,
        status: 'error',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

function sourceThreadsOnHandlers(): Thread[] {
    const data = fixtureIteration('medium');
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    const position = { side: 'new' as const, line: 48, size: 1 };
    const openPerson = data.threads.find(
        (thread) => thread.anchor?.path === file.path && !thread.resolved && !thread.root.author.bot,
    );
    const bot = data.threads.find((thread) => thread.root.author.bot);
    const resolved = data.threads.find((thread) => thread.resolved);
    return [openPerson, bot, resolved]
        .filter((thread): thread is Thread => thread !== undefined)
        .map((thread) => ({ ...thread, anchor: { fileId: file.fileId, path: file.path, position } }));
}

const HANDLERS = 'services/orders/src/api/handlers.ts';

/** Фото фикстуры `medium`: у автора PR, двух комментаторов и AI-ревью есть, у Айрис не загружается. */
const MEDIUM_PHOTOS: ReadonlyMap<string, string> = new Map([
    [fixtureIteration('medium').pr.author.login, GALLERY_AVATAR_PHOTOS[1]],
    ['alice', GALLERY_AVATAR_PHOTOS[0]],
    ['kai', GALLERY_AVATAR_PHOTOS[2]],
    ['iris', GALLERY_AVATAR_BROKEN],
    ['ai-review-bot', GALLERY_AVATAR_PHOTOS[0]],
]);

/**
 * Свёрнутый файл с тредами у трёх разных строк (бот и человек свёрнуты, ещё один человек раскрыт)
 * и тредом без позиции: у сводки три маркера, под шапкой — раскрытый и тред без позиции.
 */
function collapsedFileThreads(): Thread[] {
    const data = fixtureIteration('medium');
    const file = fileOf('medium', HANDLERS);
    const people = data.threads.filter((thread) => !thread.resolved && !thread.root.author.bot);
    const bot = data.threads.find((thread) => thread.root.author.bot);
    const [folded, opened, general] = people;
    if (bot === undefined || folded === undefined || opened === undefined || general === undefined) {
        return [];
    }
    const at = (thread: Thread, line: number | null): Thread => ({
        ...thread,
        anchor: {
            fileId: file.fileId,
            path: file.path,
            position: line === null ? null : { side: 'new', line, size: 1 },
        },
    });
    return [at(opened, 52), at(bot, 46), at(folded, 58), at(general, null)];
}

function openFirstThread(store: ThreadStore, threads: readonly Thread[]): void {
    store.setThreadsOpen(
        threads.map((thread) => thread.id),
        false,
    );
    const opened = threads[0];
    if (opened !== undefined) {
        store.setThreadsOpen([opened.id], true);
    }
}

function botThreadWithFortyReplies(): Thread[] {
    const source = fixtureIteration('medium').threads.find((thread) => thread.root.author.bot);
    if (source === undefined) {
        return [];
    }
    let replies: Comment[] = [];
    for (let index = 40; index >= 1; index -= 1) {
        replies = [
            {
                id: `bot-reply-${String(index)}`,
                author: source.root.author,
                body: `Автоматический ответ ${String(index)}: проверка всё ещё видит этот путь.`,
                draft: false,
                issue: null,
                resolved: null,
                createdAt: `2026-08-19T08:${String(index).padStart(2, '0')}:00.000Z`,
                editedAt: null,
                replies,
            },
        ];
    }
    return [{ ...source, root: { ...source.root, replies } }];
}

/**
 * Витрина markdown: один тред, в теле которого встречается весь профиль `comment` —
 * включая то, что рендериться не должно: сырой HTML, `javascript:`-ссылка и непарный бэктик
 * обязаны остаться текстом.
 */
const MARKDOWN_SHOWCASE = [
    '# Заголовок первого уровня',
    '## Второго — того же кегля',
    '### Третьего — на ступень мельче',
    '#### Четвёртого — кегль тела',
    '##### Пятого',
    '###### И шестого',
    '',
    'Обычный абзац с **жирным**, *курсивом*, ~~зачёркнутым~~ и инлайн-кодом `EditPolicy.decide()`.',
    'Одиночный перенос строки остаётся переносом — люди пишут плоским текстом.',
    '',
    'Список с вложенностью:',
    '',
    '- первый пункт со ссылкой [на тикет](https://github.com/quillmart/quillmart/issues/2281)',
    '  - вложенный пункт с `кодом`',
    '- второй пункт',
    '',
    '1. нумерованный',
    '2. и второй',
    '',
    '- [x] чек-лист: отмеченный пункт',
    '- [ ] и неотмеченный',
    '',
    '> Цитата: содержимое разбирается тем же парсером.',
    '>',
    '> - и список внутри цитаты тоже',
    '> > Вложенная цитата — второй и последний уровень.',
    '',
    'Таблица с выравниванием и длинной ячейкой:',
    '',
    '| Файл | Строк | Комментарий |',
    '| :--- | ---: | :---: |',
    '| `services/orders/src/domain/edit-window.ts` | 128 | по центру |',
    '| `handlers.ts` | 42 | труба \\| внутри ячейки |',
    '| неразрывный токен services_orders_domain_edit_window_policy_decision_remaining_ms тянет таблицу вправо | 7 | и включает скролл |',
    '',
    'Длинный голый URL переносится, а не растягивает колонку:',
    'https://github.com/quillmart/quillmart/wiki/Orders-security-PCI-incident-response-historical-records-scrubbing#раздел-про-ретеншен',
    'Голый длинный токен без ссылки — тоже: services_orders_domain_edit_window_policy_decision_remaining_ms_threshold_constant',
    '',
    '```ts',
    'const decision = policy.decide(order, clock.now());',
    'if (!decision.allowed) throw new EditWindowClosed(decision.reason, decision.remainingMs);',
    '```',
    '',
    'Незнакомый язык забора подсветки не получает — только `data-lang`:',
    '',
    '```rust',
    'fn main() { println!("{}", 42); }',
    '```',
    '',
    'Сырой HTML остаётся текстом: <img src=x onerror="alert(1)"> и <b>жирный</b>.',
    'Ссылка чужой схемы — тоже текст: [клик](javascript:alert(1)).',
    'Непарный бэктик литерален: поле `slot стало обязательным.',
].join('\n');

function markdownShowcaseThread(): Thread[] {
    const source = fixtureIteration('medium').threads.find((thread) => thread.root.author.bot);
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    if (source === undefined) {
        return [];
    }
    return [
        {
            ...source,
            anchor: { fileId: file.fileId, path: file.path, position: { side: 'new' as const, line: 48, size: 1 } },
            root: { ...source.root, body: MARKDOWN_SHOWCASE, replies: [] },
        },
    ];
}

export interface FullDiffGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const FULL_DIFF_STATES: readonly FullDiffGalleryState[] = [
    {
        id: 'full-diff-tree',
        title: 'дерево и фильтры, 21 файл',
        render: () => <WorkspaceState fixture="medium" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-large',
        title: '64 файла: 8 машинных свёрнуты вперемешку, список виртуализирован',
        render: () => <WorkspaceState fixture="large" preloadModels={false} />,
    },
    {
        id: 'full-diff-pci',
        title: 'фильтр PCI DSS: чип активен',
        render: () => <WorkspaceState fixture="medium" filter="pci" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-single-file-dir',
        title: 'папка с единственным файлом: каталог своей строкой, длинное имя с тегами режется с конца',
        render: () => (
            <WorkspaceState fixture="medium" paths={SINGLE_FILE_DIR_PATHS} renameTo={SINGLE_FILE_DIR_RENAME} />
        ),
    },
    {
        id: 'full-diff-tree-deep',
        title: 'пути глубины 3: имена файлов не обрезаются',
        render: () => <WorkspaceState fixture="medium" paths={DEEP_PATHS} viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-filtered-chains',
        title: 'фильтр поверх цепочек: схлопывание считается по видимым детям',
        render: () => <WorkspaceState fixture="large" filter="generated" preloadModels={false} />,
    },
    {
        id: 'full-diff-zero',
        title: 'скрытая линза из URL откатывается к «Все»',
        render: () => (
            <WorkspaceState
                fixture="medium"
                filter="pci"
                lenses={{ ownership: fixtureIteration('medium').ownership, extra: [EMPTY_PCI], ownershipSource: 'CODEOWNERS' }}
            />
        ),
    },
    {
        id: 'full-diff-mine-disabled',
        title: 'нет зоны CODEOWNERS: «мои файлы» выключены с причиной',
        render: () => <WorkspaceState fixture="edge" />,
    },
    {
        id: 'full-diff-outline',
        title: 'однофайловый PR: вместо дерева аутлайн ханков',
        render: () => <WorkspaceState fixture="small" />,
    },
    {
        id: 'full-diff-read-tri-state',
        title: 'прогресс чтения: прочитано, частично, не начато',
        render: () => (
            <WorkspaceState
                fixture="medium"
                viewed={MEDIUM_VIEWED}
                records={[partialRecord('medium', 'services/orders/src/domain/edit-window.ts', 0.4)]}
            />
        ),
    },
    {
        id: 'full-diff-tree-read-dimmed',
        title: 'прочитанное приглушено: файлы и целиком прочитанные каталоги; частичные и активная строка — нет',
        render: () => (
            <WorkspaceState
                fixture="medium"
                paths={READ_DIMMED_PATHS}
                viewed={READ_DIMMED_VIEWED}
                records={[partialRecord('medium', 'services/orders/src/domain/edit-window.ts', 0.4)]}
            />
        ),
    },
    {
        id: 'full-diff-read-generated',
        title: 'машинные файлы прочитаны по умолчанию, один снят вручную',
        render: () => (
            <WorkspaceState
                fixture="medium"
                filter="generated"
                records={[unpinnedRecord('medium', 'pnpm-lock.yaml')]}
            />
        ),
    },
    {
        id: 'full-diff-outline-binary',
        title: 'однофайловый PR из картинки: оглавлять нечего',
        render: () => <WorkspaceState fixture="edge" onlyPath="services/orders/assets/edit-window-flow.png" />,
    },
    {
        id: 'threads-sources',
        title: 'треды людей, ботов и resolved на одной строке',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                threads={sourceThreadsOnHandlers()}
            />
        ),
    },
    {
        id: 'threads-deep',
        title: 'глубокая вложенность с ограниченным отступом',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/domain/edit-window.ts"
            />
        ),
    },
    {
        id: 'threads-composer-draft',
        title: 'композер и сохранённый черновик',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/domain/edit-window.ts"
                prepareThreads={prepareDraftComposer}
            />
        ),
    },
    {
        id: 'threads-composer-error',
        title: 'черновик не сохранился, текст остался',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                prepareThreads={prepareFailedComposer}
            />
        ),
    },
    {
        id: 'threads-bot-collapsed',
        title: 'бот-тред с сорока ответами: все видны сразу',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/payments/card-token.ts"
                threads={botThreadWithFortyReplies()}
            />
        ),
    },
    {
        id: 'threads-collapsed-file',
        title: 'свёрнутый файл: раскрытый тред под шапкой со своим маркером, свёрнутые — маркерами выше и ниже по строкам',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath={HANDLERS}
                collapsed={[HANDLERS]}
                threads={collapsedFileThreads()}
                prepareThreads={openFirstThread}
            />
        ),
    },
    {
        id: 'threads-markdown',
        title: 'markdown-витрина: весь профиль комментария разом',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                threads={markdownShowcaseThread()}
            />
        ),
    },
    {
        id: 'threads-avatars',
        title: 'фото: автор PR в шапке и авторы тредов, бот тоже; битое фото — инициалы',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/domain/edit-window.ts"
                photos={MEDIUM_PHOTOS}
            />
        ),
    },
    {
        id: 'threads-outside',
        title: 'свёрнутая группа тредов вне диффа',
        render: () => (
            <WorkspaceState
                fixture="edge"
                showThreads
                onlyPath="services/orders/assets/edit-window-flow.png"
                threads={fixtureIteration('medium').threads.filter((thread) => thread.anchor === null)}
            />
        ),
    },
];
