/**
 * Тексты GraphQL-операций GitHub. Каждая операция именованная: имя уходит в тексты ошибок
 * и по нему же записанный API разбирает запрос в тестах.
 *
 * Полей запрашивается ровно столько, сколько читает адаптер: карта операций и их стоимость —
 * `docs/research/github-api.md`.
 */

/**
 * Остаток окна лимита едет в каждом чтении: по нему клиент решает, не пора ли подождать.
 * В мутациях поля нет — `rateLimit` живёт только на типе `Query`, и GitHub отвергает запрос целиком.
 */
const RATE_LIMIT = 'rateLimit { cost remaining resetAt }';

/** Автор комментария, ревью или PR; `name` есть только у людей, у ботов и организаций его нет. */
const AUTHOR = 'author { login __typename avatarUrl(size: 100) ... on User { name } }';

/** Шапка PR: всё, из чего собираются `PrMeta`, итерация и адреса файлов в вебе. */
const PR_META = `
    id
    number
    title
    url
    state
    isDraft
    merged
    updatedAt
    headRefOid
    baseRefOid
    headRefName
    baseRefName
    headRepositoryOwner { login }
    ${AUTHOR}
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    latestOpinionatedReviews(first: 100) { nodes { state ${AUTHOR} } }
`;

const THREAD_COMMENT = `
    id
    databaseId
    body
    createdAt
    lastEditedAt
    ${AUTHOR}
    pullRequestReview { id state commit { oid } }
`;

const REVIEW_THREADS = `
    reviewThreads(first: 50, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
            id
            isResolved
            isOutdated
            resolvedBy { login }
            path
            line
            startLine
            diffSide
            startDiffSide
            originalLine
            originalStartLine
            subjectType
            comments(first: 10) {
                pageInfo { hasNextPage endCursor }
                nodes { ${THREAD_COMMENT} }
            }
        }
    }
`;

const PR_LEVEL = `
    reviews(last: 50) {
        nodes {
            id
            state
            body
            createdAt
            lastEditedAt
            submittedAt
            commit { oid }
            ${AUTHOR}
        }
    }
    comments(last: 50) {
        nodes {
            id
            body
            createdAt
            lastEditedAt
            ${AUTHOR}
        }
    }
`;

/** Шапка PR отдельным запросом: `getPr` и `listIterations` тредов не читают. */
export const PR_QUERY = `query SherpaPr($owner: String!, $repo: String!, $number: Int!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${PR_META} }
    }
}`;

/** Тик опроса: шапка, треды диффа, ревью и комментарии уровня PR — одним запросом. */
export const TICK_QUERY = `query SherpaPrTick($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            ${PR_META}
            ${REVIEW_THREADS}
            ${PR_LEVEL}
        }
    }
}`;

/** Дочитывание тредов: их больше 50 — редкость, но список обязан доезжать целиком. */
export const THREADS_PAGE_QUERY = `query SherpaReviewThreadsPage($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${REVIEW_THREADS} }
    }
}`;

/** Дочитывание комментариев одного треда: в тредах глубже десяти ответов. */
export const THREAD_COMMENTS_QUERY = `query SherpaThreadComments($threadId: ID!, $commentCursor: String) {
    ${RATE_LIMIT}
    node(id: $threadId) {
        ... on PullRequestReviewThread {
            id
            comments(first: 50, after: $commentCursor) {
                pageInfo { hasNextPage endCursor }
                nodes { ${THREAD_COMMENT} }
            }
        }
    }
}`;

/** Отметки «просмотрено» по файлам: в REST-списке файлов их нет. */
export const FILES_QUERY = `query SherpaPrFiles($owner: String!, $repo: String!, $number: Int!, $fileCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            files(first: 100, after: $fileCursor) {
                pageInfo { hasNextPage endCursor }
                nodes { path viewerViewedState }
            }
        }
    }
}`;

/** Одно ревью: тело нужно правке абзаца, чтобы не перечитывать весь тик. */
export const REVIEW_BODY_QUERY = `query SherpaReviewBody($reviewId: ID!) {
    ${RATE_LIMIT}
    node(id: $reviewId) {
        ... on PullRequestReview { id state body }
    }
}`;

/** Владелец токена: он же личность ревьюера в шапке PR (`PrMeta.viewer`). */
export const VIEWER_QUERY = `query SherpaViewer {
    ${RATE_LIMIT}
    viewer { login name avatarUrl(size: 100) }
}`;

/** Обе стороны файла одним запросом: старая на merge-base, новая на голове ветки. */
export const FILE_CONTENT_QUERY = `query SherpaFileContent($owner: String!, $repo: String!, $oldExpression: String!, $newExpression: String!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        old: object(expression: $oldExpression) { ... on Blob { text isBinary byteSize } }
        new: object(expression: $newExpression) { ... on Blob { text isBinary byteSize } }
    }
}`;

/**
 * Размеры сторон картинок одним запросом с алиасами: `size` нужен контракту `ImageSide`,
 * а поштучные запросы за ним стоили бы по очку на сторону.
 */
export function blobSizesQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!`).join(', ');
    const fields = aliases
        .map((alias) => `${alias}: object(expression: $${alias}) { ... on Blob { byteSize } }`)
        .join('\n        ');
    return `query SherpaBlobSizes($owner: String!, $repo: String!, ${variables}) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        ${fields}
    }
}`;
}

/**
 * Двоичность файлов, у которых REST не отдал патча, — одним запросом с алиасами. В списке файлов
 * такого признака нет, а по статистике его не вывести: у чистого переименования она нулевая.
 */
export function blobBinaryQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!`).join(', ');
    const fields = aliases
        .map((alias) => `${alias}: object(expression: $${alias}) { ... on Blob { isBinary } }`)
        .join('\n        ');
    return `query SherpaBlobBinary($owner: String!, $repo: String!, ${variables}) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        ${fields}
    }
}`;
}

export const MARK_FILE_VIEWED_MUTATION = `mutation SherpaMarkFileAsViewed($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

export const UNMARK_FILE_VIEWED_MUTATION = `mutation SherpaUnmarkFileAsViewed($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

export const RESOLVE_THREAD_MUTATION = `mutation SherpaResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

export const UNRESOLVE_THREAD_MUTATION = `mutation SherpaUnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/**
 * Ленивое заведение pending-ревью: без `event` GitHub оставляет ревью черновиком.
 * Тело обязательно и непусто: ревью, заведённое без тела, GitHub больше не даёт редактировать
 * (`docs/research/github-api.md`), поэтому в него сразу едет заглушка.
 */
export const CREATE_REVIEW_MUTATION = `mutation SherpaCreateReview($pullRequestId: ID!, $commitOID: GitObjectID!, $body: String!) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, body: $body }) {
        pullRequestReview { id state body createdAt lastEditedAt submittedAt commit { oid } ${AUTHOR} }
    }
}`;

/** Вердикт без единого комментария: pending-ревью заводить не за чем. */
export const VERDICT_REVIEW_MUTATION = `mutation SherpaVerdictReview($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event }) {
        pullRequestReview { id state }
    }
}`;

/**
 * Публикация: итоговое тело ревью едет параметром самого сабмита. Отдельной правки тела перед
 * ним нет — заглушка иначе уехала бы в опубликованное ревью, а стереть её `updatePullRequestReview`
 * уже не дал бы.
 */
export const SUBMIT_REVIEW_MUTATION = `mutation SherpaSubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String!) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
        pullRequestReview { id state }
    }
}`;

export const ADD_REVIEW_THREAD_MUTATION = `mutation SherpaAddReviewThread($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
    addPullRequestReviewThread(input: {
        pullRequestReviewId: $reviewId,
        path: $path,
        body: $body,
        line: $line,
        side: $side,
        startLine: $startLine,
        startSide: $startSide,
        subjectType: $subjectType
    }) {
        thread {
            id
            comments(first: 1) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } }
        }
    }
}`;

export const ADD_REVIEW_THREAD_REPLY_MUTATION = `mutation SherpaAddReviewThreadReply($reviewId: ID!, $threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {
        pullRequestReviewId: $reviewId,
        pullRequestReviewThreadId: $threadId,
        body: $body
    }) {
        comment { ${THREAD_COMMENT} }
    }
}`;

/** Тело ревью — единственное место, куда GitHub пускает черновик уровня PR. */
export const UPDATE_REVIEW_BODY_MUTATION = `mutation SherpaUpdateReviewBody($reviewId: ID!, $body: String!) {
    updatePullRequestReview(input: { pullRequestReviewId: $reviewId, body: $body }) {
        pullRequestReview { id state body createdAt lastEditedAt submittedAt commit { oid } ${AUTHOR} }
    }
}`;

export const UPDATE_REVIEW_COMMENT_MUTATION = `mutation SherpaUpdateReviewComment($commentId: ID!, $body: String!) {
    updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
        pullRequestReviewComment { id body }
    }
}`;

export const DELETE_REVIEW_COMMENT_MUTATION = `mutation SherpaDeleteReviewComment($commentId: ID!) {
    deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId }
}`;

export const UPDATE_ISSUE_COMMENT_MUTATION = `mutation SherpaUpdateIssueComment($commentId: ID!, $body: String!) {
    updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id body } }
}`;

export const DELETE_ISSUE_COMMENT_MUTATION = `mutation SherpaDeleteIssueComment($commentId: ID!) {
    deleteIssueComment(input: { id: $commentId }) { clientMutationId }
}`;

/**
 * CODEOWNERS базовой ветки: три места, где его ищет GitHub, одним запросом с алиасами.
 * Владельцев считает файл базы PR, а не головы ветки, — иначе правку CODEOWNERS в самом PR
 * пришлось бы применять к нему же.
 */
export const CODEOWNERS_QUERY = `query SherpaCodeowners($owner: String!, $repo: String!, $githubDir: String!, $root: String!, $docsDir: String!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        githubDir: object(expression: $githubDir) { ... on Blob { text } }
        root: object(expression: $root) { ... on Blob { text } }
        docsDir: object(expression: $docsDir) { ... on Blob { text } }
    }
}`;

/**
 * Команды ревьюера в организациях владельцев CODEOWNERS: по одному алиасу на организацию.
 * Требует скоупа `read:org` — без него GitHub отвечает ошибкой, и владение по командам
 * не считается (`docs/research/github-api.md`).
 */
export function orgTeamsQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!, $${alias}After: String`).join(', ');
    const fields = aliases
        .map(
            (alias) => `${alias}: organization(login: $${alias}) {
        teams(first: 100, userLogins: [$viewer], after: $${alias}After) {
            pageInfo { hasNextPage endCursor }
            nodes { slug }
        }
    }`,
        )
        .join('\n    ');
    return `query SherpaOrgTeams($viewer: String!, ${variables}) {
    ${RATE_LIMIT}
    ${fields}
}`;
}
