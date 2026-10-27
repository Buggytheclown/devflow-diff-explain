import { z } from 'zod';

/**
 * Схемы ответов Арканума — хост-специфика, наружу за адаптер не выходит (`docs/spec.md`),
 * в `@sherpa/protocol` не выносится. Формы выверены живьём на PR 15138703 / 13614071
 * (`docs/architecture.md`).
 *
 * Строгость разная по назначению поля: структурные (id, entry_id, path, commit_ids) обязательны —
 * без них адаптер соврал бы; косметические (заголовок, ветки, имя бота) необязательны, потому что
 * Арканум опускает пустые значения, и падать всем PR из-за отсутствующей ветки незачем.
 */

const arcUserSchema = z.object({ name: z.string().min(1) });

const capsSchema = z.object({
    /** Отсутствует — считаем стики-шип недоступным: лучше спрятать кнопку, чем словить отказ. */
    disable_sticky_ships: z.boolean().optional(),
});

export const REVIEW_REQUEST_FIELDS =
    'id,url,summary,author(name),state,common_status,updated_at,caps(disable_sticky_ships),' +
    'vcs(from_branch,to_branch,arc_repo_name),active_diff_set(id),review(reviewers(name,action))';

/** Чем PR привязан к тенанту Арканума и к вебу: репозиторий (`arcadia`/`cloudia`) и ссылка. */
export const PR_REF_FIELDS = 'url,vcs(arc_repo_name)';

/**
 * Репозиторий PR — структурное поле: по нему выбираются чекаут `arc`, ручки правил ревью и веб-
 * ссылки. Догадка тут врала бы молча (дифф Cloudia читался бы из чекаута Аркадии), поэтому
 * fail-closed: нет поля — нет ответа. Живьём оно приходит всегда.
 */
const vcsRepoSchema = z.object({ arc_repo_name: z.string().min(1) });

export const prRefSchema = z.object({
    /** Ссылка на PR в вебе: собирать её из id нельзя — веб-адрес знает только хост. */
    url: z.string().min(1),
    vcs: vcsRepoSchema,
});

/**
 * Вердикты ревьюеров: `action` есть только у тех, кто уже высказался; всё остальное
 * (`null`, незнакомое слово) — вердикта нет. Группа необязательная целиком: PR без назначенных
 * ревьюеров Арканум отдаёт без неё.
 *
 * Имя в `fields=review(reviewers(name,action))` приезжает вложенным — `user.name` (живая
 * проверка, `docs/architecture.md` §Вердикты); плоское `name` принимаем на случай, если
 * форма зависит от набора полей.
 */
const reviewerSchema = z.object({
    name: z.string().min(1).nullish(),
    user: z.object({ name: z.string().min(1).nullish() }).nullish(),
    action: z.string().nullish(),
});

const reviewersSchema = z.object({
    /** Незнакомая форма списка не должна валить всю мету PR: вердикты — не структурное поле. */
    reviewers: z.array(reviewerSchema).catch([]).optional(),
});

export const reviewRequestSchema = z.object({
    id: z.number().int(),
    url: z.string().min(1),
    summary: z.string().optional(),
    author: arcUserSchema,
    state: z.string().min(1),
    common_status: z.string().min(1),
    updated_at: z.string().min(1),
    caps: capsSchema.optional(),
    vcs: vcsRepoSchema.extend({
        from_branch: z.string().optional(),
        to_branch: z.string().optional(),
    }),
    active_diff_set: z.object({ id: z.number().int() }),
    review: reviewersSchema.optional().catch(undefined),
});
export type ArcReviewRequest = z.infer<typeof reviewRequestSchema>;

/**
 * Дешёвая ручка поллинга: 90 байт на тик (`docs/architecture.md` §Реактивность).
 * `common_status` — чтобы заметить чужой шип, не перечитывая мету на каждый тик.
 */
export const POLL_FIELDS = 'updated_at,common_status,active_diff_set(id)';

export const pollSchema = z.object({
    updated_at: z.string().min(1),
    /** Необязателен: поллинг важнее одного поля — без статуса тик просто ничего о нём не скажет. */
    common_status: z.string().min(1).optional(),
    active_diff_set: z.object({ id: z.number().int() }),
});

export const ACTIVE_DIFF_FIELDS = 'id,commit_ids(base,head,merge)';

/** Содержимое ревьюится между `base` и `merge`; `head` — вершина ветки, не ревьюируемая сторона. */
export const activeDiffSchema = z.object({
    id: z.number().int(),
    commit_ids: z.object({
        base: z.string().min(1),
        merge: z.string().min(1),
        head: z.string().optional(),
    }),
});

/**
 * Список итераций PR: `GET /pull-requests/{id}/diffs`. Поля плоские — обёртка `diffs(…)` молча
 * отдаёт `[{}]` (`docs/architecture.md` §Дифф). Группа `commit_ids` живьём на этой ручке
 * **не проверена**: её отсутствие не должно ронять разбор, поэтому все поля, кроме `id`, необязательны —
 * диффсет без коммитов адаптер честно не перечисляет.
 */
export const DIFF_SETS_FIELDS = 'id,created_at,published,commit_ids(base,head,merge)';

export const diffSetSchema = z.object({
    id: z.number().int(),
    created_at: z.string().min(1).optional(),
    /** Неопубликованный диффсет ревьюеру не показывают — итерацией он ещё не стал. */
    published: z.boolean().optional(),
    commit_ids: z
        .object({
            base: z.string().min(1).optional(),
            merge: z.string().min(1).optional(),
            head: z.string().min(1).optional(),
        })
        .optional(),
});
export type ArcDiffSet = z.infer<typeof diffSetSchema>;

export const diffSetsSchema = z.array(diffSetSchema);

export const CHANGELIST_FIELDS =
    'path,change_type,node_type,entry_id,reviewed,binary,source(path),' +
    'meta_before(size),meta_after(size),blob_before,blob_after';

export const changeTypeSchema = z.enum(['none', 'add', 'modify', 'delete', 'copy', 'move', 'conflict']);

export const changelistEntrySchema = z.object({
    path: z.string().min(1),
    entry_id: z.string().min(1),
    change_type: changeTypeSchema,
    node_type: z.enum(['none', 'file', 'dir']),
    binary: z.boolean().optional(),
    reviewed: z.boolean().optional(),
    /** Прежний путь при copy/move. */
    source: z.object({ path: z.string().optional() }).optional(),
    /** Точный размер стороны в байтах — гейт «слишком большой» до чтения содержимого. */
    meta_before: z.object({ size: z.number().int().optional() }).optional(),
    meta_after: z.object({ size: z.number().int().optional() }).optional(),
    /**
     * Содержательные хэши блобов arc (не git-sha1): равные стороны — содержимое не менялось.
     * Ими же адресуется чтение сторон локальным `arc show` (`arc-cli.ts`).
     */
    blob_before: z.string().min(1).optional(),
    blob_after: z.string().min(1).optional(),
});
export type ArcChangelistEntry = z.infer<typeof changelistEntrySchema>;

export const changelistSchema = z.array(changelistEntrySchema);

export const positionSchema = z.object({
    side: z.enum(['old', 'new']),
    line: z.number().int(),
    /** Охват строк; бывает > 1, отсутствие трактуем как одну строку. */
    size: z.number().int().optional(),
});

export const commentAnchorSchema = z.object({
    review_request: z
        .object({
            diff: z
                .object({
                    diff_set_xid: z.string().optional(),
                    file: z
                        .object({
                            entry_id: z.string().min(1),
                            path: z.string().min(1),
                            position: positionSchema.optional(),
                        })
                        .optional(),
                })
                .optional(),
        })
        .optional(),
});

export const reviewSystemSchema = z.object({
    slug: z.string().optional(),
    display_name: z.string().optional(),
    is_ai: z.boolean().optional(),
});

export const COMMENT_FIELDS =
    'id,content,created_at,edited_at,updated_at,deleted_at,draft,published_at,issue_status,' +
    'reply_to_id,status_updated_by(name),review_system(slug,display_name,is_ai),user(name),' +
    'anchor(review_request(diff(diff_set_xid,file(entry_id,path,position(side,line,size)))))';

/** `issue_status` отсутствует у комментариев, которые issue никогда не были. */
export const issueStatusSchema = z.enum(['open', 'resolved', 'dropped', 'not_issue']);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export const commentSchema = z.object({
    /** Знаковое число: PR-level комментарии отрицательные, инлайновые положительные. */
    id: z.number().int(),
    user: arcUserSchema,
    content: z.string().optional(),
    created_at: z.string().min(1),
    edited_at: z.string().optional(),
    updated_at: z.string().optional(),
    deleted_at: z.string().optional(),
    published_at: z.string().optional(),
    draft: z.boolean().optional(),
    issue_status: issueStatusSchema.optional(),
    reply_to_id: z.number().int().optional(),
    status_updated_by: arcUserSchema.optional(),
    review_system: reviewSystemSchema.optional(),
    anchor: commentAnchorSchema.optional(),
});
export type ArcComment = z.infer<typeof commentSchema>;

export const commentsSchema = z.array(commentSchema);

/**
 * Ответ ручек, у которых нам нужен только факт «правка легла на тот объект»: PATCH текста
 * черновика и PATCH `issue_status`. Полный комментарий здесь не нужен — сходимость обеспечивает
 * поллинг тредов, а узкая проекция не даст ответу развалиться о необязательное поле.
 */
export const COMMENT_ACK_FIELDS = 'id';

export const commentAckSchema = z.object({ id: z.number().int() });

/**
 * Сбор своих черновиков перед публикацией. Проекция узкая намеренно: пагинации у комментариев
 * нет, и на PR с тысячей комментариев полная выборка — многомегабайтный ответ ради трёх полей.
 */
export const DRAFT_IDS_FIELDS = 'id,draft,deleted_at';

export const draftIdsSchema = z.array(
    z.object({
        id: z.number().int(),
        draft: z.boolean().optional(),
        deleted_at: z.string().optional(),
    }),
);

/** Выборочная публикация: id черновиков, которые Арканум действительно опубликовал. */
export const publishedDraftsSchema = z.object({ published: z.array(z.number().int()) });

export const REVIEW_RULES_FIELDS =
    'review(rules(roles,configs(path),assign,ship,reviewers_names))';

const reviewRuleSchema = z.object({
    roles: z.array(z.string()).optional(),
    configs: z.array(z.object({ path: z.string().min(1) })).optional(),
    /** Сколько ревьюеров правило назначает само; `0` — правило только считает шипы, не призывает. */
    assign: z.number().optional(),
    /** Сколько шипов правило требует; `0` у групп, которые призывают вне дежурства. */
    ship: z.number().optional(),
    /** Логины ревьюеров PR, которых Арканум относит к этому правилу. */
    reviewers_names: z.array(z.string()).optional(),
});
export type ArcReviewRule = z.infer<typeof reviewRuleSchema>;

export const reviewRulesSchema = z.object({
    review: z.object({ rules: z.array(reviewRuleSchema).optional() }).optional(),
});

/** Недокументированная ручка UI Арканума: роли (в т. ч. выражения с `&&`, `!`) → логины. */
export const resolveMembersSchema = z.object({
    members_by_role: z.record(z.string(), z.array(z.object({ login: z.string().min(1) }))),
});

/**
 * `POST /v1/repos/{repo}/abc`: путь файла → владеющий его a.yaml. Порядок ответа не повторяет
 * порядок запроса — сопоставляется по `path`. Проекции `fields` эта ручка не понимает (живая
 * проверка: лишние поля приходят всё равно), поэтому её тут и нет.
 */
export const abcPathsSchema = z.array(
    z.object({
        path: z.string().min(1),
        /** Файла нет в дереве — Арканум всё равно называет ближайший по пути a.yaml. */
        abc_project: z
            .object({ config: z.object({ path: z.string().min(1) }).optional() })
            .optional(),
    }),
);

/** Резолвнутый человек правила: `gaps` (отпуска) нам не нужны. */
const previewMemberSchema = z.object({ login: z.string().min(1) });

/** Тело правила ревью: содержимое `rule_assignees.value` уровня иерархии. */
const previewRuleValueSchema = z.object({
    alias: z.string().optional(),
    /** Ролевые предикаты правила: элемент может быть выражением с `!` и запятыми. */
    rules: z.array(z.string()).optional(),
    members_by_rule: z.record(z.string(), z.array(z.string())).optional(),
    /** Каждый элемент — список шаблонов через запятую, как он записан в a.yaml. */
    subpaths_filter: z.array(z.string()).optional(),
    /** Предикаты `authors` правила; пустой список — правило действует на любого автора. */
    authors_filter: z.array(z.string()).optional(),
    /** Те же предикаты, уже резолвнутые в логины: по ним и проверяется автор PR. */
    members_by_author: z.record(z.string(), z.array(z.string())).optional(),
    /** Глобы `branches` правила; Арканум их не резолвит (см. `review-rules.ts`). */
    branches_filter: z.array(z.string()).optional(),
    reviewers: z.array(previewMemberSchema).optional(),
});
export type ArcPreviewRuleValue = z.infer<typeof previewRuleValueSchema>;

/**
 * Правило ревью уровня иерархии. Значения полей Арканум опускает (правило без `subpaths_filter` —
 * законное «всё поддерево»), а вот пофилдовый `is_active` шлёт всегда: наследование гасит правило
 * отдельно от уровня, и без этого флага мёртвое правило нельзя отличить от живого.
 */
const previewRuleSchema = z.object({
    rule_assignees: z
        .object({ is_active: z.boolean(), value: previewRuleValueSchema.optional() })
        .optional(),
});

/**
 * `GET /v1/repos/preview/a-yaml`: уровни иерархии a.yaml с готовым `is_active` (наследование
 * Арканум применил сам) и резолвнутыми людьми. Ответ приходит **без конверта `{data}`** — тело
 * лежит в корне (проверено живьём).
 *
 * `is_active` и `config_path` уровня обязательны: живьём приходят всегда, а тихий пропуск любого
 * из них врёт молча — уровень станет «неактивным», либо его правила посчитаются относительно
 * чужого каталога. Лучше провалить разбор и уехать на каталожную линзу.
 */
export const previewAYamlSchema = z.object({
    a_yaml: z.object({
        arcanum: z.object({
            /** Уровни от ближайшего a.yaml к корню репозитория. */
            review: z
                .array(
                    z.object({
                        is_active: z.boolean(),
                        config_path: z.object({ path: z.string().min(1) }),
                        rules: z.array(previewRuleSchema).optional(),
                    }),
                )
                .optional(),
        }),
    }),
});

export const PCI_FIELDS = 'commit(id,state),files';

export const pciSchema = z.object({
    commit: z.object({
        state: z.enum(['not_reviewed', 'shipped', 'approved', 'fixed', 'failed', 'free', 'unknown']),
    }),
    /** Готовое пересечение файлов коммита со скоупом PCI DSS — просто пути. */
    files: z.array(z.string()).optional(),
});
