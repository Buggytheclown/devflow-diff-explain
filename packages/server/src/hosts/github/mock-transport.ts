import { readFileSync } from 'node:fs';

/**
 * Транспорт адаптера на записанном API GitHub (`./mocks`). Живые вызовы в тестах запрещены:
 * контрактный набор и юниты гоняются только через него.
 *
 * Формы ответов взяты из документации схемы GraphQL и REST GitHub: имена полей, енумы состояний,
 * `nodes`/`pageInfo` у связей, отсутствующий `patch` у двоичных файлов.
 *
 * Мок с состоянием: мутации меняют треды, тело pending-ревью, отметки просмотра и вердикты, а
 * запросы отдают изменённое — иначе контрактный набор с записью проверял бы статические файлы.
 * Неизвестная операция или маршрут — ошибка теста, а не пустой ответ.
 */

export const MOCK_OWNER = 'acme';
export const MOCK_REPO = 'sherpa';
export const MOCK_NUMBER = 42;
export const MOCK_VIEWER = 'alice';
/** Фото владельца токена: GitHub отдаёт его в `viewer.avatarUrl`. */
export const MOCK_VIEWER_AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';

export const MOCK_PR_NODE_ID = 'PR_kwDOSherpa42';
export const MOCK_HEAD_OID = '4f1c9a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70';
export const MOCK_BASE_OID = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
export const MOCK_MERGE_BASE = '9e8d7c6b5a4938271605f4e3d2c1b0a998877665';
/** Голова ветки после «пуша» мока (`MockGithubControl.push`). */
export const MOCK_PUSHED_HEAD_OID = 'bb00cc11dd22ee33ff445566778899aabbccddee';
/** Коммит базы после мержа в неё чужих правок (`MockGithubControl.mergeIntoBase`). */
export const MOCK_MOVED_BASE_OID = '77665544332211009988aabbccddeeff00112233';

/**
 * CODEOWNERS записанного репозитория: своя зона ревьюера (`src`), зона чужой команды (`docs`)
 * и зона чужого человека (`assets`). Лежит там, где его ищет GitHub первым делом.
 */
export const MOCK_CODEOWNERS: Readonly<Record<string, string>> = {
    '.github/CODEOWNERS': ['# Mock owners', '/src/ @alice', '/docs/ @acme/docs-team', 'assets/ @bob', ''].join('\n'),
};

/** Команды владельца токена по организациям: `acme/docs-team` в них не входит. */
export const MOCK_TEAMS: Readonly<Record<string, readonly string[]>> = { acme: ['core'] };

export function mockFile(name: string): string {
    return readFileSync(new URL(`./mocks/${name}`, import.meta.url), 'utf8');
}

function readMock(name: string): unknown {
    return JSON.parse(mockFile(name));
}

interface MockActor {
    login: string;
    __typename: string;
    name?: string;
}

interface MockComment {
    id: string;
    databaseId: number;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    author: MockActor;
    reviewId: string | null;
}

interface MockThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    resolvedBy: { login: string } | null;
    path: string;
    line: number | null;
    startLine: number | null;
    diffSide: string;
    startDiffSide: string | null;
    originalLine: number | null;
    originalStartLine: number | null;
    subjectType: string;
    comments: MockComment[];
}

interface MockReview {
    id: string;
    state: string;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    submittedAt: string | null;
    commitOid: string | null;
    author: MockActor;
}

interface MockIssueComment {
    id: string;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    author: MockActor;
}

interface MockBlob {
    text?: string;
    isBinary: boolean;
    byteSize: number;
    base64?: string;
}

interface MockFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
}

interface MockPr {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    merged: boolean;
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
    headRepositoryOwner: { login: string } | null;
    author: MockActor;
    checksState: string | null;
}

/** Ручки мока, которых в API GitHub нет: тест дёргает их сам. */
export interface MockGithubControl {
    /** «Пуш» автора: голова ветки уезжает на новый коммит. */
    push?: () => void;
    /** Мерж в базовую ветку: коммит базы новый, голова прежняя, файлы владельцев можно заменить. */
    mergeIntoBase?: (codeowners?: Readonly<Record<string, string>>) => void;
}

export interface MockGithubOptions {
    /** Операция или REST-маршрут → HTTP-статус вместо данных. */
    readonly failing?: Readonly<Record<string, number>>;
    /** Операция → текст ошибки GitHub в `errors[]` (код 200, как у живого API). */
    readonly graphqlErrors?: Readonly<Record<string, string>>;
    /** Счётчик вызовов по ключу операции или маршрута — им проверяется кэш. */
    readonly calls?: Map<string, number>;
    /** Логин владельца токена; null — `viewer` отвечает ошибкой. */
    readonly viewer?: string | null;
    readonly control?: MockGithubControl;
    /** Размеры страниц: маленькие включают пагинацию в тестах. */
    readonly threadPageSize?: number;
    readonly commentPageSize?: number;
    readonly filePageSize?: number;
    /** Остаток окна лимита в каждом ответе. */
    readonly rateLimit?: { readonly remaining: number; readonly resetAt: string };
    /** Подмена полей шапки PR: черновик, слияние, статус проверок. */
    readonly prOverrides?: Partial<MockPr>;
    /** Готовое pending-ревью владельца токена с этим телом — как если бы его начали на вебе GitHub. */
    readonly pendingReviewBody?: string;
    /** Файлы CODEOWNERS в базовой ветке по путям; пустая карта — ни одного такого файла нет. */
    readonly codeowners?: Readonly<Record<string, string>>;
    /** Команды владельца токена по организациям; организации вне карты токену не видны. */
    readonly teams?: Readonly<Record<string, readonly string[]>>;
}

interface GraphqlRequest {
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
}

/** Отказ GitHub в форме `errors[]` с кодом 200 — так отвечает живой API на негодный запрос. */
class MockApiError extends Error {}

const NOT_FOUND = Symbol('not-found');

class MockGithubState {
    head = MOCK_HEAD_OID;
    base = MOCK_BASE_OID;
    /** Файлы владельцев на текущем коммите базы: мерж в базу их переписывает. */
    codeowners: Readonly<Record<string, string>> = MOCK_CODEOWNERS;
    updatedAt: string;
    threads: MockThread[] = readMock('threads.json') as MockThread[];
    reviews: MockReview[] = readMock('reviews.json') as MockReview[];
    issueComments: MockIssueComment[] = readMock('comments.json') as MockIssueComment[];
    readonly viewed = new Set<string>();
    readonly pr: MockPr;
    readonly files = readMock('files.json') as MockFile[];
    readonly blobs = readMock('blobs.json') as Record<string, { old?: MockBlob; new?: MockBlob }>;

    /** Счётчик новых узлов начинается высоко: записанные id мок занимать не должен. */
    private nextId = 900;

    constructor(
        readonly viewerLogin: string | null,
        overrides: Partial<MockPr>,
        pendingBody: string | undefined,
    ) {
        this.pr = { ...readMock('pr.json') as MockPr, ...overrides };
        this.updatedAt = this.pr.updatedAt;
        if (pendingBody !== undefined) {
            this.reviews.push({
                id: 'PRR_pending_web',
                state: 'PENDING',
                body: pendingBody,
                createdAt: this.updatedAt,
                lastEditedAt: null,
                submittedAt: null,
                commitOid: this.head,
                author: this.viewer(),
            });
        }
    }

    push(): void {
        this.head = MOCK_PUSHED_HEAD_OID;
        this.touch();
    }

    /** Мерж чужих правок в базу: коммит базы уезжает вперёд, голова PR не двигается. */
    mergeIntoBase(codeowners: Readonly<Record<string, string>> | undefined): void {
        this.base = MOCK_MOVED_BASE_OID;
        if (codeowners !== undefined) {
            this.codeowners = codeowners;
        }
        this.touch();
    }

    touch(): void {
        this.updatedAt = new Date(Date.parse(this.updatedAt) + 60_000).toISOString();
    }

    id(prefix: string): string {
        this.nextId += 1;
        return `${prefix}_${String(this.nextId)}`;
    }

    viewer(): MockActor {
        return { login: this.viewerLogin ?? MOCK_VIEWER, __typename: 'User', name: 'Alice' };
    }

    blob(expression: string): MockBlob | null {
        const separator = expression.indexOf(':');
        const sha = expression.slice(0, separator);
        const path = expression.slice(separator + 1);
        const sides = this.blobs[path];
        if (sides === undefined) {
            return null;
        }
        return (sha === MOCK_MERGE_BASE ? sides.old : sides.new) ?? null;
    }

    reviewById(id: unknown): MockReview {
        const review = this.reviews.find((candidate) => candidate.id === id);
        if (review === undefined) {
            throw new Error(`мок GitHub: нет ревью ${String(id)}`);
        }
        return review;
    }

    threadOfComment(commentId: unknown): MockThread {
        const thread = this.threads.find((candidate) =>
            candidate.comments.some((comment) => comment.id === commentId),
        );
        if (thread === undefined) {
            throw new Error(`мок GitHub: нет комментария ${String(commentId)}`);
        }
        return thread;
    }
}

export function makeMockGithubFetch(
    options: MockGithubOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
    const viewerLogin = options.viewer === undefined ? MOCK_VIEWER : options.viewer;
    const state = new MockGithubState(viewerLogin, options.prOverrides ?? {}, options.pendingReviewBody);
    state.codeowners = options.codeowners ?? MOCK_CODEOWNERS;
    if (options.control !== undefined) {
        options.control.push = (): void => {
            state.push();
        };
        options.control.mergeIntoBase = (codeowners): void => {
            state.mergeIntoBase(codeowners);
        };
    }

    const count = (key: string): void => {
        options.calls?.set(key, (options.calls.get(key) ?? 0) + 1);
    };

    return (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';

        if (url.pathname === '/graphql') {
            const request = parseGraphqlRequest(init);
            count(request.operation);

            const failure = options.failing?.[request.operation];
            if (failure !== undefined) {
                return Promise.resolve(jsonResponse('{"message":"mock failure"}', failure));
            }
            const apiError = options.graphqlErrors?.[request.operation];
            if (apiError !== undefined) {
                return Promise.resolve(apiErrorResponse(apiError));
            }
            // `rateLimit` живёт только на типе `Query`: мутация с ним отвергается целиком.
            if (isMutation(request.query) && request.query.includes('rateLimit')) {
                return Promise.resolve(apiErrorResponse(RATE_LIMIT_ON_MUTATION));
            }

            let data: Record<string, unknown>;
            try {
                data = graphqlData(state, request, options, viewerLogin);
            } catch (error) {
                if (error instanceof MockApiError) {
                    return Promise.resolve(apiErrorResponse(error.message));
                }
                throw error;
            }
            // Остаток окна лимита есть только у чтений: на типе `Mutation` такого поля нет.
            const envelope = isMutation(request.query) ? data : { rateLimit: rateLimitOf(options), ...data };
            return Promise.resolve(jsonResponse(JSON.stringify({ data: envelope }), 200));
        }

        const route = restRouteOf(url, method);
        count(route);
        const failure = options.failing?.[route];
        if (failure !== undefined) {
            return Promise.resolve(jsonResponse('{"message":"mock failure"}', failure));
        }

        const rest = restBody(state, url, route);
        if (rest === NOT_FOUND) {
            return Promise.resolve(jsonResponse('{"message":"Not Found"}', 404));
        }
        if (rest instanceof Uint8Array) {
            return Promise.resolve(
                new Response(rest, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
            );
        }
        return Promise.resolve(jsonResponse(rest, 200));
    };
}

/** Отказ живого GitHub на мутацию с `rateLimit`; тест сверяется ровно с этим текстом. */
export const RATE_LIMIT_ON_MUTATION = "Field 'rateLimit' doesn't exist on type 'Mutation'";

/** Отказ живого GitHub на правку ревью, заведённого без тела. */
const EMPTY_BODY_EDIT_ERROR = 'VALIDATION: Could not edit a review with a missing body.';

function isMutation(query: string): boolean {
    return query.trimStart().startsWith('mutation');
}

function apiErrorResponse(message: string): Response {
    return jsonResponse(JSON.stringify({ data: null, errors: [{ message }] }), 200);
}

function rateLimitOf(options: MockGithubOptions): unknown {
    return {
        cost: 1,
        remaining: options.rateLimit?.remaining ?? 4999,
        resetAt: options.rateLimit?.resetAt ?? '2026-09-20T11:00:00Z',
    };
}

function parseGraphqlRequest(init: RequestInit | undefined): GraphqlRequest {
    const raw = typeof init?.body === 'string' ? init.body : '';
    if (raw === '') {
        throw new Error('мок GitHub: POST /graphql без тела');
    }
    const parsed = JSON.parse(raw) as { query?: unknown; variables?: unknown };
    if (typeof parsed.query !== 'string') {
        throw new Error('мок GitHub: в теле запроса нет `query`');
    }
    const operation = /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(parsed.query)?.[1];
    if (operation === undefined) {
        throw new Error('мок GitHub: операция без имени — адаптер обязан именовать запросы');
    }
    const variables =
        typeof parsed.variables === 'object' && parsed.variables !== null
            ? (parsed.variables as Record<string, unknown>)
            : {};
    return { operation, query: parsed.query, variables };
}

function graphqlData(
    state: MockGithubState,
    request: GraphqlRequest,
    options: MockGithubOptions,
    viewerLogin: string | null,
): Record<string, unknown> {
    const { operation, variables } = request;

    switch (operation) {
        case 'SherpaViewer': {
            if (viewerLogin === null) {
                throw new Error('мок GitHub: тест запретил whoami, но адаптер его спросил');
            }
            return { viewer: { login: viewerLogin, name: state.viewer().name ?? null, avatarUrl: MOCK_VIEWER_AVATAR } };
        }
        case 'SherpaPr':
            return { repository: { pullRequest: metaNode(state) } };
        case 'SherpaPrTick':
            return {
                repository: {
                    pullRequest: {
                        ...metaNode(state),
                        reviewThreads: threadsPage(state, options, variables.threadCursor),
                        reviews: { nodes: state.reviews.map(reviewNode) },
                        comments: { nodes: state.issueComments.map(issueCommentNode) },
                    },
                },
            };
        case 'SherpaReviewThreadsPage':
            return {
                repository: {
                    pullRequest: { reviewThreads: threadsPage(state, options, variables.threadCursor) },
                },
            };
        case 'SherpaThreadComments': {
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`мок GitHub: нет треда ${String(variables.threadId)}`);
            }
            return { node: { comments: commentsPage(state, thread, options, variables.commentCursor) } };
        }
        case 'SherpaPrFiles':
            return { repository: { pullRequest: { files: filesPage(state, options, variables.fileCursor) } } };
        case 'SherpaFileContent':
            return {
                repository: {
                    old: blobNode(state, variables.oldExpression, 'all'),
                    new: blobNode(state, variables.newExpression, 'all'),
                },
            };
        case 'SherpaCodeowners': {
            const files = state.codeowners;
            const blob = (expression: unknown): unknown => {
                const [sha, path] = splitExpression(expression);
                // Владельцев считает база PR: на голове ветки того же файла мок не показывает.
                const text = sha === state.base ? files[path] : undefined;
                return text === undefined ? null : { text };
            };
            return {
                repository: {
                    githubDir: blob(variables.githubDir),
                    root: blob(variables.root),
                    docsDir: blob(variables.docsDir),
                },
            };
        }
        case 'SherpaOrgTeams': {
            const known = options.teams ?? MOCK_TEAMS;
            const orgs: Record<string, unknown> = {};
            for (const [alias, org] of Object.entries(variables)) {
                if (alias === 'viewer' || alias.endsWith('After')) {
                    continue;
                }
                const slugs = known[String(org)];
                orgs[alias] =
                    slugs === undefined
                        ? null
                        : { teams: { pageInfo: lastPage(), nodes: slugs.map((slug) => ({ slug })) } };
            }
            return orgs;
        }
        case 'SherpaBlobSizes':
        case 'SherpaBlobBinary': {
            const field = operation === 'SherpaBlobSizes' ? 'size' : 'binary';
            const repository: Record<string, unknown> = {};
            for (const [alias, expression] of Object.entries(variables)) {
                if (alias === 'owner' || alias === 'repo') {
                    continue;
                }
                repository[alias] = blobNode(state, expression, field);
            }
            return { repository };
        }
        case 'SherpaReviewBody': {
            const review = state.reviewById(variables.reviewId);
            return { node: { id: review.id, state: review.state, body: review.body } };
        }
        case 'SherpaMarkFileAsViewed':
            state.viewed.add(String(variables.path));
            state.touch();
            return { markFileAsViewed: { clientMutationId: null } };
        case 'SherpaUnmarkFileAsViewed':
            state.viewed.delete(String(variables.path));
            state.touch();
            return { unmarkFileAsViewed: { clientMutationId: null } };
        case 'SherpaResolveReviewThread':
        case 'SherpaUnresolveReviewThread': {
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`мок GitHub: нет треда ${String(variables.threadId)}`);
            }
            const resolved = operation === 'SherpaResolveReviewThread';
            thread.isResolved = resolved;
            thread.resolvedBy = resolved ? { login: state.viewer().login } : null;
            state.touch();
            const payload = { thread: { id: thread.id, isResolved: thread.isResolved } };
            return resolved ? { resolveReviewThread: payload } : { unresolveReviewThread: payload };
        }
        case 'SherpaCreateReview': {
            const review: MockReview = {
                id: state.id('PRR_draft'),
                state: 'PENDING',
                // Как у живого GitHub: ревью, заведённое без тела, получает пустое.
                body: typeof variables.body === 'string' ? variables.body : '',
                createdAt: state.updatedAt,
                lastEditedAt: null,
                submittedAt: null,
                commitOid: String(variables.commitOID),
                author: state.viewer(),
            };
            state.reviews.push(review);
            state.touch();
            return { addPullRequestReview: { pullRequestReview: reviewNode(review) } };
        }
        case 'SherpaVerdictReview': {
            const review: MockReview = {
                id: state.id('PRR_verdict'),
                state: eventState(state, variables.event),
                body: '',
                createdAt: state.updatedAt,
                lastEditedAt: null,
                submittedAt: state.updatedAt,
                commitOid: String(variables.commitOID),
                author: state.viewer(),
            };
            state.reviews.push(review);
            state.touch();
            return { addPullRequestReview: { pullRequestReview: { id: review.id, state: review.state } } };
        }
        case 'SherpaSubmitReview': {
            const review = state.reviewById(variables.reviewId);
            if (review.state !== 'PENDING') {
                throw new Error('мок GitHub: сабмит уже опубликованного ревью');
            }
            review.state = eventState(state, variables.event);
            // Тело сабмита задаёт текст ревью — даже у ревью, которое до этого было без тела.
            if (typeof variables.body === 'string') {
                review.body = variables.body;
            }
            review.submittedAt = state.updatedAt;
            state.touch();
            return { submitPullRequestReview: { pullRequestReview: { id: review.id, state: review.state } } };
        }
        case 'SherpaAddReviewThread': {
            const review = state.reviewById(variables.reviewId);
            const comment = newComment(state, String(variables.body), review.id);
            const thread: MockThread = {
                id: state.id('PRRT'),
                isResolved: false,
                isOutdated: false,
                resolvedBy: null,
                path: String(variables.path),
                line: numberOrNull(variables.line),
                startLine: numberOrNull(variables.startLine),
                diffSide: stringOr(variables.side, 'RIGHT'),
                startDiffSide: variables.startSide === null ? null : stringOr(variables.startSide, 'RIGHT'),
                originalLine: numberOrNull(variables.line),
                originalStartLine: numberOrNull(variables.startLine),
                subjectType: stringOr(variables.subjectType, 'LINE'),
                comments: [comment],
            };
            state.threads.push(thread);
            state.touch();
            return {
                addPullRequestReviewThread: {
                    thread: {
                        id: thread.id,
                        comments: { pageInfo: lastPage(), nodes: [commentNode(state, comment)] },
                    },
                },
            };
        }
        case 'SherpaAddReviewThreadReply': {
            const review = state.reviewById(variables.reviewId);
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`мок GitHub: нет треда ${String(variables.threadId)}`);
            }
            const comment = newComment(state, String(variables.body), review.id);
            thread.comments.push(comment);
            state.touch();
            return { addPullRequestReviewThreadReply: { comment: commentNode(state, comment) } };
        }
        case 'SherpaUpdateReviewBody': {
            const review = state.reviewById(variables.reviewId);
            // Живой GitHub: ревью без тела правке не поддаётся — ни первой, ни любой следующей.
            if (review.body === '') {
                throw new MockApiError(EMPTY_BODY_EDIT_ERROR);
            }
            review.body = String(variables.body);
            review.lastEditedAt = state.updatedAt;
            state.touch();
            return { updatePullRequestReview: { pullRequestReview: reviewNode(review) } };
        }
        case 'SherpaUpdateReviewComment': {
            const thread = state.threadOfComment(variables.commentId);
            const comment = thread.comments.find((candidate) => candidate.id === variables.commentId);
            if (comment === undefined) {
                throw new Error('мок GitHub: комментарий исчез между поиском и правкой');
            }
            comment.body = String(variables.body);
            comment.lastEditedAt = state.updatedAt;
            state.touch();
            return {
                updatePullRequestReviewComment: {
                    pullRequestReviewComment: { id: comment.id, body: comment.body },
                },
            };
        }
        case 'SherpaDeleteReviewComment': {
            const thread = state.threadOfComment(variables.commentId);
            // Как у живого GitHub: корень уносит обсуждение целиком, ответ — только себя.
            if (thread.comments[0]?.id === variables.commentId) {
                state.threads = state.threads.filter((candidate) => candidate.id !== thread.id);
            } else {
                thread.comments = thread.comments.filter((candidate) => candidate.id !== variables.commentId);
            }
            state.touch();
            return { deletePullRequestReviewComment: { clientMutationId: null } };
        }
        case 'SherpaUpdateIssueComment': {
            const comment = state.issueComments.find((candidate) => candidate.id === variables.commentId);
            if (comment === undefined) {
                throw new Error(`мок GitHub: нет комментария ${String(variables.commentId)}`);
            }
            comment.body = String(variables.body);
            comment.lastEditedAt = state.updatedAt;
            state.touch();
            return { updateIssueComment: { issueComment: { id: comment.id, body: comment.body } } };
        }
        case 'SherpaDeleteIssueComment': {
            state.issueComments = state.issueComments.filter(
                (candidate) => candidate.id !== variables.commentId,
            );
            state.touch();
            return { deleteIssueComment: { clientMutationId: null } };
        }
        default:
            throw new Error(`мок GitHub не знает операцию ${operation}`);
    }
}

function metaNode(state: MockGithubState): Record<string, unknown> {
    const { checksState, ...pr } = state.pr;
    return {
        ...pr,
        id: MOCK_PR_NODE_ID,
        updatedAt: state.updatedAt,
        headRefOid: state.head,
        baseRefOid: state.base,
        commits: {
            nodes: [{ commit: { statusCheckRollup: checksState === null ? null : { state: checksState } } }],
        },
        latestOpinionatedReviews: { nodes: opinionatedReviews(state) },
    };
}

/** «Последние значащие ревью»: по одному на автора, только апрув и запрос правок. */
function opinionatedReviews(state: MockGithubState): unknown[] {
    const byAuthor = new Map<string, MockReview>();
    for (const review of state.reviews) {
        if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
            byAuthor.set(review.author.login, review);
        }
    }
    return [...byAuthor.values()].map((review) => ({
        state: review.state,
        author: { login: review.author.login, __typename: review.author.__typename },
    }));
}

function reviewNode(review: MockReview): Record<string, unknown> {
    return {
        id: review.id,
        state: review.state,
        body: review.body,
        createdAt: review.createdAt,
        lastEditedAt: review.lastEditedAt,
        submittedAt: review.submittedAt,
        commit: review.commitOid === null ? null : { oid: review.commitOid },
        author: review.author,
    };
}

function issueCommentNode(comment: MockIssueComment): Record<string, unknown> {
    return {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        author: comment.author,
    };
}

function commentNode(state: MockGithubState, comment: MockComment): Record<string, unknown> {
    const review = state.reviews.find((candidate) => candidate.id === comment.reviewId) ?? null;
    return {
        id: comment.id,
        databaseId: comment.databaseId,
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        author: comment.author,
        pullRequestReview:
            review === null
                ? null
                : {
                      id: review.id,
                      state: review.state,
                      commit: review.commitOid === null ? null : { oid: review.commitOid },
                  },
    };
}

function newComment(state: MockGithubState, body: string, reviewId: string): MockComment {
    return {
        id: state.id('PRRC'),
        databaseId: 2000 + state.threads.length,
        body,
        createdAt: state.updatedAt,
        lastEditedAt: null,
        author: state.viewer(),
        reviewId,
    };
}

function threadsPage(
    state: MockGithubState,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.threadPageSize ?? 50;
    const start = cursorIndex(cursor);
    const page = state.threads.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, state.threads.length),
        nodes: page.map((thread) => threadNode(state, thread, options)),
    };
}

function threadNode(
    state: MockGithubState,
    thread: MockThread,
    options: MockGithubOptions,
): Record<string, unknown> {
    return { ...thread, comments: commentsPage(state, thread, options, null) };
}

function commentsPage(
    state: MockGithubState,
    thread: MockThread,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.commentPageSize ?? 10;
    const start = cursorIndex(cursor);
    const page = thread.comments.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, thread.comments.length),
        nodes: page.map((comment) => commentNode(state, comment)),
    };
}

function filesPage(
    state: MockGithubState,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.filePageSize ?? 100;
    const start = cursorIndex(cursor);
    const page = state.files.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, state.files.length),
        nodes: page.map((file) => ({
            path: file.filename,
            viewerViewedState: state.viewed.has(file.filename) ? 'VIEWED' : 'UNVIEWED',
        })),
    };
}

/** Блоб ровно в том объёме, в каком его запросила операция: содержимое, размер или двоичность. */
function blobNode(state: MockGithubState, expression: unknown, fields: 'all' | 'size' | 'binary'): unknown {
    if (typeof expression !== 'string') {
        throw new Error('мок GitHub: адрес блоба обязан быть строкой');
    }
    const blob = state.blob(expression);
    if (blob === null) {
        return null;
    }
    if (fields === 'size') {
        return { byteSize: blob.byteSize };
    }
    if (fields === 'binary') {
        return { isBinary: blob.isBinary };
    }
    return { text: blob.text ?? null, isBinary: blob.isBinary, byteSize: blob.byteSize };
}

/** Адрес блоба `<коммит>:<путь>` на части. */
function splitExpression(expression: unknown): [string, string] {
    if (typeof expression !== 'string') {
        throw new Error('мок GitHub: адрес блоба обязан быть строкой');
    }
    const separator = expression.indexOf(':');
    return [expression.slice(0, separator), expression.slice(separator + 1)];
}

function restRouteOf(url: URL, method: string): string {
    const path = url.pathname;
    if (path.endsWith('/files')) {
        return 'rest:files';
    }
    if (path.includes('/compare/')) {
        return 'rest:compare';
    }
    if (path.includes('/contents/')) {
        return 'rest:contents';
    }
    throw new Error(`мок GitHub не знает маршрут ${method} ${path}`);
}

function restBody(state: MockGithubState, url: URL, route: string): string | Uint8Array | typeof NOT_FOUND {
    switch (route) {
        case 'rest:files':
            return JSON.stringify(state.files);
        case 'rest:compare':
            return JSON.stringify({ merge_base_commit: { sha: MOCK_MERGE_BASE } });
        case 'rest:contents': {
            const path = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
            const ref = url.searchParams.get('ref') ?? '';
            const blob = state.blob(`${ref}:${path}`);
            if (blob === null) {
                return NOT_FOUND;
            }
            return blob.base64 === undefined
                ? new TextEncoder().encode(blob.text ?? '')
                : Uint8Array.from(Buffer.from(blob.base64, 'base64'));
        }
        default:
            throw new Error(`мок GitHub не знает маршрут ${route}`);
    }
}

function jsonResponse(body: string, status: number): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function pageInfoOf(end: number, total: number): { hasNextPage: boolean; endCursor: string | null } {
    return end < total ? { hasNextPage: true, endCursor: `c${String(end)}` } : lastPage();
}

function lastPage(): { hasNextPage: boolean; endCursor: string | null } {
    return { hasNextPage: false, endCursor: null };
}

function cursorIndex(cursor: unknown): number {
    if (typeof cursor !== 'string' || !cursor.startsWith('c')) {
        return 0;
    }
    const index = Number(cursor.slice(1));
    return Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * Состояние ревью после события. На своём PR живой GitHub отказывает автору и в апруве, и в
 * запросе правок — отказ приходит в `errors[]`, как у живого API.
 */
function eventState(state: MockGithubState, event: unknown): string {
    const own = state.pr.author.login.toLowerCase() === state.viewer().login.toLowerCase();
    if (event === 'COMMENT') {
        return 'COMMENTED';
    }
    if (event === 'APPROVE') {
        if (own) {
            throw new MockApiError('Review Can not approve your own pull request');
        }
        return 'APPROVED';
    }
    if (event === 'REQUEST_CHANGES') {
        if (own) {
            throw new MockApiError('Review Can not request changes on your own pull request');
        }
        return 'CHANGES_REQUESTED';
    }
    throw new Error(`мок GitHub: незнакомое событие ревью ${String(event)}`);
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}
