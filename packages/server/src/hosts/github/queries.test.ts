import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { makeMockGithubFetch, RATE_LIMIT_ON_MUTATION } from './mock-transport.js';
import * as queries from './queries.js';
import {
    addReviewThreadMutationSchema,
    addReviewThreadReplyMutationSchema,
    blobAliasesResponseSchema,
    codeownersResponseSchema,
    commentMutationSchema,
    fileContentResponseSchema,
    filesResponseSchema,
    orgTeamsResponseSchema,
    prResponseSchema,
    resolveThreadMutationSchema,
    reviewBodyResponseSchema,
    reviewMutationSchema,
    submitReviewMutationSchema,
    threadCommentsResponseSchema,
    threadsPageResponseSchema,
    tickResponseSchema,
    unresolveThreadMutationSchema,
    updateReviewBodyMutationSchema,
    verdictMutationSchema,
    viewedMutationSchema,
    viewerResponseSchema,
} from './schemas.js';

/**
 * Структурные проверки текстов GraphQL — два класса ошибок, которые записанный API поймать не
 * может, потому что отвечает щедрее живого: поле, живущее только на `Query`, и поле схемы,
 * которого запрос не просит. Живой GitHub первое отвергает целиком, а второе роняет на валидаторе.
 */

/** Алиасы, под которые собираются запросы с придуманными именами полей. */
const ALIASES = ['o0'];

/** Пара «текст операции → схема, которой адаптер разбирает её ответ». */
const OPERATIONS: readonly { readonly name: string; readonly query: string; readonly schema: z.ZodType }[] = [
    { name: 'PR_QUERY', query: queries.PR_QUERY, schema: prResponseSchema },
    { name: 'TICK_QUERY', query: queries.TICK_QUERY, schema: tickResponseSchema },
    { name: 'THREADS_PAGE_QUERY', query: queries.THREADS_PAGE_QUERY, schema: threadsPageResponseSchema },
    { name: 'THREAD_COMMENTS_QUERY', query: queries.THREAD_COMMENTS_QUERY, schema: threadCommentsResponseSchema },
    { name: 'FILES_QUERY', query: queries.FILES_QUERY, schema: filesResponseSchema },
    { name: 'REVIEW_BODY_QUERY', query: queries.REVIEW_BODY_QUERY, schema: reviewBodyResponseSchema },
    { name: 'VIEWER_QUERY', query: queries.VIEWER_QUERY, schema: viewerResponseSchema },
    { name: 'FILE_CONTENT_QUERY', query: queries.FILE_CONTENT_QUERY, schema: fileContentResponseSchema },
    { name: 'CODEOWNERS_QUERY', query: queries.CODEOWNERS_QUERY, schema: codeownersResponseSchema },
    { name: 'blobSizesQuery', query: queries.blobSizesQuery(ALIASES), schema: blobAliasesResponseSchema },
    { name: 'blobBinaryQuery', query: queries.blobBinaryQuery(ALIASES), schema: blobAliasesResponseSchema },
    { name: 'orgTeamsQuery', query: queries.orgTeamsQuery(ALIASES), schema: orgTeamsResponseSchema(ALIASES) },
    { name: 'MARK_FILE_VIEWED_MUTATION', query: queries.MARK_FILE_VIEWED_MUTATION, schema: viewedMutationSchema },
    { name: 'UNMARK_FILE_VIEWED_MUTATION', query: queries.UNMARK_FILE_VIEWED_MUTATION, schema: viewedMutationSchema },
    { name: 'RESOLVE_THREAD_MUTATION', query: queries.RESOLVE_THREAD_MUTATION, schema: resolveThreadMutationSchema },
    {
        name: 'UNRESOLVE_THREAD_MUTATION',
        query: queries.UNRESOLVE_THREAD_MUTATION,
        schema: unresolveThreadMutationSchema,
    },
    { name: 'CREATE_REVIEW_MUTATION', query: queries.CREATE_REVIEW_MUTATION, schema: reviewMutationSchema },
    { name: 'VERDICT_REVIEW_MUTATION', query: queries.VERDICT_REVIEW_MUTATION, schema: verdictMutationSchema },
    { name: 'SUBMIT_REVIEW_MUTATION', query: queries.SUBMIT_REVIEW_MUTATION, schema: submitReviewMutationSchema },
    {
        name: 'ADD_REVIEW_THREAD_MUTATION',
        query: queries.ADD_REVIEW_THREAD_MUTATION,
        schema: addReviewThreadMutationSchema,
    },
    {
        name: 'ADD_REVIEW_THREAD_REPLY_MUTATION',
        query: queries.ADD_REVIEW_THREAD_REPLY_MUTATION,
        schema: addReviewThreadReplyMutationSchema,
    },
    {
        name: 'UPDATE_REVIEW_BODY_MUTATION',
        query: queries.UPDATE_REVIEW_BODY_MUTATION,
        schema: updateReviewBodyMutationSchema,
    },
    {
        name: 'UPDATE_REVIEW_COMMENT_MUTATION',
        query: queries.UPDATE_REVIEW_COMMENT_MUTATION,
        schema: commentMutationSchema,
    },
    {
        name: 'DELETE_REVIEW_COMMENT_MUTATION',
        query: queries.DELETE_REVIEW_COMMENT_MUTATION,
        schema: commentMutationSchema,
    },
    {
        name: 'UPDATE_ISSUE_COMMENT_MUTATION',
        query: queries.UPDATE_ISSUE_COMMENT_MUTATION,
        schema: commentMutationSchema,
    },
    {
        name: 'DELETE_ISSUE_COMMENT_MUTATION',
        query: queries.DELETE_ISSUE_COMMENT_MUTATION,
        schema: commentMutationSchema,
    },
];

/** Тексты всех операций адаптера: константы плюс то, что собирают функции. */
function allQueries(): { name: string; query: string }[] {
    const built = Object.entries(queries).flatMap(([name, value]) =>
        typeof value === 'string' ? [{ name, query: value }] : [],
    );
    return [
        ...built,
        { name: 'blobSizesQuery', query: queries.blobSizesQuery(ALIASES) },
        { name: 'blobBinaryQuery', query: queries.blobBinaryQuery(ALIASES) },
        { name: 'orgTeamsQuery', query: queries.orgTeamsQuery(ALIASES) },
    ];
}

/** Оболочки схемы снимаются до объекта: связь, массив узлов, `nullable`, запись с алиасами. */
function unwrap(schema: z.ZodType): z.ZodType {
    if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
        return unwrap(schema.unwrap() as z.ZodType);
    }
    if (schema instanceof z.ZodArray) {
        return unwrap(schema.element as z.ZodType);
    }
    if (schema instanceof z.ZodRecord) {
        return unwrap(schema.valueType as z.ZodType);
    }
    return schema;
}

/**
 * Имена полей, без которых схема отбросит ответ целиком. Необязательные ветки не обходятся:
 * их отсутствие валидацию не рушит, а схемы вроде `commentMutationSchema` описывают сразу
 * несколько мутаций — требовать от каждой все поля соседей нельзя.
 */
function requiredFields(schema: z.ZodType, into = new Set<string>()): Set<string> {
    const inner = unwrap(schema);
    if (!(inner instanceof z.ZodObject)) {
        return into;
    }
    for (const [name, field] of Object.entries<z.ZodType>(inner.shape)) {
        // Необязательное поле валидацию не рушит: ответ без него схема примет.
        if (field.safeParse(undefined).success) {
            continue;
        }
        into.add(name);
        requiredFields(field, into);
    }
    return into;
}

describe('тексты операций GitHub', () => {
    it('`rateLimit` есть в каждом чтении и ни в одной мутации', () => {
        const texts = allQueries();
        const mutations = texts.filter((entry) => entry.query.trimStart().startsWith('mutation'));
        const reads = texts.filter((entry) => entry.query.trimStart().startsWith('query'));

        // Поле живёт только на типе `Query`: мутацию с ним GitHub отвергает целиком.
        expect(mutations.filter((entry) => entry.query.includes('rateLimit')).map((entry) => entry.name)).toEqual([]);
        expect(reads.filter((entry) => !entry.query.includes('rateLimit')).map((entry) => entry.name)).toEqual([]);
        expect(texts).toHaveLength(mutations.length + reads.length);
        expect(mutations.length).toBeGreaterThan(10);
        expect(reads.length).toBeGreaterThan(5);
    });

    it('каждое обязательное поле схемы ответа запрошено в тексте операции', () => {
        const missing: string[] = [];
        for (const { name, query, schema } of OPERATIONS) {
            for (const field of requiredFields(schema)) {
                if (!new RegExp(`\\b${field}\\b`).test(query)) {
                    missing.push(`${name}: ${field}`);
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('все операции адаптера сверены со схемами', () => {
        const covered = new Set(OPERATIONS.map((entry) => entry.name));
        expect(allQueries().filter((entry) => !covered.has(entry.name)).map((entry) => entry.name)).toEqual([]);
    });

    it('мок отвечает на мутацию с `rateLimit` отказом живого GitHub', async () => {
        const response = await makeMockGithubFetch()('https://api.github.test/graphql', {
            method: 'POST',
            body: JSON.stringify({
                query: `mutation SherpaProbe($pullRequestId: ID!, $path: String!) {
    rateLimit { cost remaining resetAt }
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`,
                variables: { pullRequestId: 'PR_1', path: 'src/service.ts' },
            }),
        });

        const envelope = (await response.json()) as { errors?: { message: string }[] };
        expect(envelope.errors?.[0]?.message).toBe(RATE_LIMIT_ON_MUTATION);
    });
});
