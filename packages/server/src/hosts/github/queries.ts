/**
 * Тексты GraphQL-операций GitHub. Каждая операция именованная: имя уходит в тексты ошибок
 * и по нему же записанный API разбирает запрос в тестах.
 *
 * Полей запрашивается ровно столько, сколько читает адаптер: карта операций и их стоимость —
 * `docs/architecture.md`.
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

/** Шапка PR отдельным запросом: `getPr` и `listIterations` тредов не читают. */
export const PR_QUERY = `query SherpaPr($owner: String!, $repo: String!, $number: Int!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${PR_META} }
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
