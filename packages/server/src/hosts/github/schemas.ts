import { z } from 'zod';

/**
 * Схемы ответов GitHub — только те поля, которые адаптер действительно читает (fail-closed:
 * что не описано, наружу не выходит).
 *
 * Общее правило GraphQL: почти всё может прийти `null` — удалённый автор, PR не того репозитория,
 * пустая связь. Поэтому узлы связей нулевые, а вызывающая сторона отбрасывает пустое сама.
 */

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

/** Связь GraphQL без курсора: узлы могут прийти нулями и по одному, и всем списком. */
function nodesOf<T extends z.ZodType>(item: T) {
    return z.object({ nodes: z.array(item.nullable()).nullable() });
}

/** Связь GraphQL со страницами. */
function connectionOf<T extends z.ZodType>(item: T) {
    return z.object({ pageInfo: pageInfoSchema, nodes: z.array(item.nullable()).nullable() });
}

/** Ненулевые узлы связи — единственный способ пользоваться `nodes` GraphQL. */
export function compact<T>(nodes: readonly (T | null)[] | null | undefined): T[] {
    return (nodes ?? []).filter((node): node is T => node !== null);
}

/** Автор: `name` есть только у `User`, у ботов и организаций его нет вовсе. */
const actorSchema = z.object({
    login: z.string().min(1),
    __typename: z.string(),
    name: z.string().nullable().optional(),
    avatarUrl: z.string().optional(),
});
export type GithubActor = z.infer<typeof actorSchema>;

const commitSchema = z.object({ oid: z.string().min(1) });

export const prMetaSchema = z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().min(1),
    state: z.string(),
    isDraft: z.boolean(),
    merged: z.boolean(),
    updatedAt: z.string().min(1),
    headRefOid: z.string().min(1),
    baseRefOid: z.string().min(1),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRepositoryOwner: z.object({ login: z.string().min(1) }).nullable(),
    author: actorSchema.nullable(),
    commits: nodesOf(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
    latestOpinionatedReviews: nodesOf(
        z.object({ state: z.string(), author: actorSchema.nullable() }),
    ).nullable(),
});
export type GithubPrMeta = z.infer<typeof prMetaSchema>;

export const threadCommentSchema = z.object({
    id: z.string().min(1),
    databaseId: z.number().int().nullable(),
    body: z.string(),
    createdAt: z.string().min(1),
    lastEditedAt: z.string().nullable(),
    author: actorSchema.nullable(),
    pullRequestReview: z
        .object({ id: z.string().min(1), state: z.string(), commit: commitSchema.nullable() })
        .nullable(),
});
export type GithubThreadComment = z.infer<typeof threadCommentSchema>;

export const reviewThreadSchema = z.object({
    id: z.string().min(1),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    resolvedBy: z.object({ login: z.string().min(1) }).nullable(),
    path: z.string().min(1),
    line: z.number().int().nullable(),
    startLine: z.number().int().nullable(),
    diffSide: z.string(),
    startDiffSide: z.string().nullable(),
    originalLine: z.number().int().nullable(),
    originalStartLine: z.number().int().nullable(),
    subjectType: z.string(),
    comments: connectionOf(threadCommentSchema),
});
export type GithubReviewThread = z.infer<typeof reviewThreadSchema>;

export const reviewSchema = z.object({
    id: z.string().min(1),
    state: z.string(),
    body: z.string(),
    createdAt: z.string().min(1),
    lastEditedAt: z.string().nullable(),
    submittedAt: z.string().nullable(),
    commit: commitSchema.nullable(),
    author: actorSchema.nullable(),
});
export type GithubReview = z.infer<typeof reviewSchema>;

export const issueCommentSchema = z.object({
    id: z.string().min(1),
    body: z.string(),
    createdAt: z.string().min(1),
    lastEditedAt: z.string().nullable(),
    author: actorSchema.nullable(),
});
export type GithubIssueComment = z.infer<typeof issueCommentSchema>;

const reviewThreadsSchema = connectionOf(reviewThreadSchema);

/** Ответ запроса шапки PR. */
export const prResponseSchema = z.object({
    repository: z.object({ pullRequest: prMetaSchema.nullable() }).nullable(),
});

/** Ответ тика опроса: шапка, треды и всё, что живёт на уровне PR. */
export const tickResponseSchema = z.object({
    repository: z
        .object({
            pullRequest: prMetaSchema
                .extend({
                    reviewThreads: reviewThreadsSchema,
                    reviews: nodesOf(reviewSchema),
                    comments: nodesOf(issueCommentSchema),
                })
                .nullable(),
        })
        .nullable(),
});
export type GithubTick = z.infer<typeof tickResponseSchema>;

export const threadsPageResponseSchema = z.object({
    repository: z
        .object({ pullRequest: z.object({ reviewThreads: reviewThreadsSchema }).nullable() })
        .nullable(),
});

export const threadCommentsResponseSchema = z.object({
    node: z.object({ comments: connectionOf(threadCommentSchema) }).nullable(),
});

export const filesResponseSchema = z.object({
    repository: z
        .object({
            pullRequest: z
                .object({
                    files: connectionOf(z.object({ path: z.string().min(1), viewerViewedState: z.string().nullable() })),
                })
                .nullable(),
        })
        .nullable(),
});

export type GithubFilesResponse = z.infer<typeof filesResponseSchema>;

export const viewerResponseSchema = z.object({
    viewer: z.object({
        login: z.string().min(1),
        name: z.string().nullable().optional(),
        avatarUrl: z.string().optional(),
    }),
});

export const reviewBodyResponseSchema = z.object({
    node: z.object({ id: z.string().min(1), state: z.string(), body: z.string() }).nullable(),
});

const blobSchema = z
    .object({
        text: z.string().nullable().optional(),
        isBinary: z.boolean().nullable().optional(),
        byteSize: z.number().int().min(0).optional(),
    })
    .nullable();

export const fileContentResponseSchema = z.object({
    repository: z.object({ old: blobSchema, new: blobSchema }).nullable(),
});

/**
 * Блобы приезжают алиасами, имена которых адаптер придумывает на лету: так читаются и размеры
 * сторон картинок, и двоичность файлов без патча.
 */
export const blobAliasesResponseSchema = z.object({
    repository: z.record(z.string(), blobSchema).nullable(),
});

export const reviewMutationSchema = z.object({
    addPullRequestReview: z.object({ pullRequestReview: reviewSchema.nullable() }).nullable(),
});

export const verdictMutationSchema = z.object({
    addPullRequestReview: z
        .object({ pullRequestReview: z.object({ id: z.string().min(1), state: z.string() }).nullable() })
        .nullable(),
});

export const submitReviewMutationSchema = z.object({
    submitPullRequestReview: z
        .object({ pullRequestReview: z.object({ id: z.string().min(1), state: z.string() }).nullable() })
        .nullable(),
});

export const updateReviewBodyMutationSchema = z.object({
    updatePullRequestReview: z.object({ pullRequestReview: reviewSchema.nullable() }).nullable(),
});

export const addReviewThreadMutationSchema = z.object({
    addPullRequestReviewThread: z
        .object({
            thread: z
                .object({ id: z.string().min(1), comments: connectionOf(threadCommentSchema) })
                .nullable(),
        })
        .nullable(),
});

export const addReviewThreadReplyMutationSchema = z.object({
    addPullRequestReviewThreadReply: z
        .object({ comment: threadCommentSchema.nullable() })
        .nullable(),
});

export const resolveThreadMutationSchema = z.object({
    resolveReviewThread: z.object({ thread: z.object({ id: z.string().min(1) }).nullable() }).nullable(),
});

export const unresolveThreadMutationSchema = z.object({
    unresolveReviewThread: z.object({ thread: z.object({ id: z.string().min(1) }).nullable() }).nullable(),
});

export const viewedMutationSchema = z.object({
    markFileAsViewed: z.object({ clientMutationId: z.string().nullable() }).nullable().optional(),
    unmarkFileAsViewed: z.object({ clientMutationId: z.string().nullable() }).nullable().optional(),
});

export const commentMutationSchema = z.object({
    updatePullRequestReviewComment: z
        .object({ pullRequestReviewComment: z.object({ id: z.string().min(1) }).nullable() })
        .nullable()
        .optional(),
    deletePullRequestReviewComment: z.object({ clientMutationId: z.string().nullable() }).nullable().optional(),
    updateIssueComment: z
        .object({ issueComment: z.object({ id: z.string().min(1) }).nullable() })
        .nullable()
        .optional(),
    deleteIssueComment: z.object({ clientMutationId: z.string().nullable() }).nullable().optional(),
});

/** Элемент `GET /repos/{owner}/{repo}/pulls/{number}/files`. */
export const restFileSchema = z.object({
    filename: z.string().min(1),
    status: z.string(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    /** Патча нет у двоичного, у слишком большого и у чистого переименования; кто из них — см. адаптер. */
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
});
export type GithubRestFile = z.infer<typeof restFileSchema>;

export const restFilesSchema = z.array(restFileSchema);

/** `GET /repos/{owner}/{repo}/compare/{base}...{head}`: из всего ответа нужна одна общая база. */
export const compareSchema = z.object({ merge_base_commit: z.object({ sha: z.string().min(1) }) });

/** Три места CODEOWNERS одним ответом: у каждого алиаса — либо блоб с текстом, либо `null`. */
const codeownersBlobSchema = z.object({ text: z.string().nullable().optional() }).nullable();

export const codeownersResponseSchema = z.object({
    repository: z
        .object({
            githubDir: codeownersBlobSchema,
            root: codeownersBlobSchema,
            docsDir: codeownersBlobSchema,
        })
        .nullable(),
});

const orgTeamsSchema = z
    .object({ teams: connectionOf(z.object({ slug: z.string().min(1) })) })
    .nullable();
export type GithubOrgTeams = z.infer<typeof orgTeamsSchema>;

/**
 * Команды ревьюера по алиасам организаций. Схема собирается под список алиасов: имена придумывает
 * адаптер на лету, а `rateLimit` того же ответа в неё не входит и отбрасывается.
 */
export function orgTeamsResponseSchema(aliases: readonly string[]): z.ZodType<Record<string, GithubOrgTeams>> {
    return z.object(Object.fromEntries(aliases.map((alias) => [alias, orgTeamsSchema])));
}
