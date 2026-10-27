import { z } from 'zod';

import { relativeCodePathSchema } from './code-link.js';
import { flowStateSchema, flowText } from './flow-diagram.js';
import { localeSchema } from './locale.js';
import { rawStoryEvidenceBlockSchema, storyEvidenceBlockSchema } from './story-evidence.js';
import { hostIdSchema } from './review.js';

/**
 * Маршрут: схема снапшота и схемы результатов генеративных задач.
 * Канон — здесь (`docs/architecture.md §5`); JSON-схемы для payload задач генерятся из этих же zod-схем.
 * Принцип 3 продукта (`docs/product.md §3`): UI не потребляет ничего, что не прошло fail-closed
 * валидатор, — сырые выводы модели в снапшот не попадают.
 *
 * Снапшот хранит только модельное (заголовки, абзацы, якоря, дайджест);
 * всё производное — file chips, счётчики, read state, доли coverage strip,
 * содержимое «Прочего» (непокрытые диапазоны) — UI считает сам от якорей
 * и своей модели диффа. Производных полей в снапшоте нет — им неоткуда врать.
 */

/**
 * Бюджет видимого текста описания остановки (`docs/design/SPEC-changes-2026-09-20.md §2`), в символах:
 * не зависит ни от размера текста, ни от ширины окна.
 * Держит его валидатор секции, а не схема: модели нужен текст с советом, что делать.
 */
export const STOP_PARAGRAPH_MAX_CHARS = 840;

export type RoutePresentation = 'legacy' | 'story';

/**
 * Тир важности. `high`/`medium`/`low` назначает модель; `other` — синтетический
 * стоп «Прочее», который синтезирует валидатор (модель про него не знает).
 */
export const routeTierSchema = z.enum(['high', 'medium', 'low', 'other']);
export type RouteTier = z.infer<typeof routeTierSchema>;

/** Статус заполнения стопа при прогрессивной генерации (`docs/protocol.md §6`). */
export const routeStopStatusSchema = z.enum(['queued', 'filling', 'ready', 'failed']);
export type RouteStopStatus = z.infer<typeof routeStopStatusSchema>;

/**
 * Якорь стопа: диапазон строк одной стороны файла диффа (не файл целиком — файл
 * может быть разнесён по остановкам). Резолвится валидатором: `path` из вывода
 * модели превращается в `fileId` активной итерации. `collapsed` — директива
 * отображения «свернуть по умолчанию» (свёртка видима со счётчиком, принцип 3).
 */
export const routeAnchorSchema = z.object({
    fileId: hostIdSchema,
    path: z.string().min(1),
    side: z.enum(['old', 'new']),
    /** Включительно; `end >= start`. Нумерация — строки файла соответствующей стороны. */
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    collapsed: z.boolean(),
});
export type RouteAnchor = z.infer<typeof routeAnchorSchema>;

/**
 * Утверждение поведенческого дайджеста тестов (`docs/product.md §6`). `weakened` — первосортный
 * сигнал; `uncovered` — честная инверсия «изменённое поведение без покрытия».
 * Якорь на тест обязателен для new/changed/weakened (иначе валидатор отбрасывает
 * утверждение со счётчиком `droppedClaims`); у `uncovered` якоря на тест нет
 * по построению — `anchor: null` или якорь на код, который остался без покрытия.
 */
export const routeTestClaimKindSchema = z.enum(['new', 'changed', 'weakened', 'uncovered']);
export type RouteTestClaimKind = z.infer<typeof routeTestClaimKindSchema>;

export const routeTestClaimSchema = z.object({
    kind: routeTestClaimKindSchema,
    /** Человеческим языком: «отклоняет редактирование позже 30-минутного окна». */
    text: z.string().min(1).max(1000),
    anchor: z
        .object({
            fileId: hostIdSchema,
            path: z.string().min(1),
            line: z.number().int().positive(),
        })
        .nullable(),
});
export type RouteTestClaim = z.infer<typeof routeTestClaimSchema>;

/**
 * Провенанс генерации (`docs/product.md §3`, принцип 7): чем и на каком языке сгенерировано.
 * Коммит — на уровне снапшота. `locale` — язык UI в момент запуска генерации;
 * null у снапшотов старого формата — они русские, UI читает null как `ru`.
 */
export const routeProvenanceSchema = z.object({
    harness: z.string().nullable(),
    model: z.string().nullable(),
    locale: localeSchema.nullable().default(null),
});
export type RouteProvenance = z.infer<typeof routeProvenanceSchema>;

/**
 * Классификация стопа относительно прошлого снапшота (`docs/design/README.md §1` бейджи `changed`/`new`,
 * блок «why this stop changed»). Считает сервер детерминированно по интердиффу между
 * итерациями снапшотов: `new` — все строки якорей затронуты или файл появился,
 * `changed` — часть; модель классификацию не выбирает, только объясняет (`reason`).
 * `threadIds` — треды на затронутых диапазонах, которые модель назвала причиной;
 * валидатор оставляет только существующие.
 */
export const routeStopChangeSchema = z.object({
    kind: z.enum(['new', 'changed']),
    /** «Why this stop changed» словами модели, на языке снапшота; null — модель объяснения не дала. */
    reason: z.string().nullable(),
    threadIds: z.array(hostIdSchema),
});
export type RouteStopChange = z.infer<typeof routeStopChangeSchema>;

/**
 * Остановка маршрута. План (id, planIndex, tier, title) фиксируется скелетом
 * и не меняется заполнением: номера план-фиксированные (`docs/design/SPEC-elements.md §8` п. 4) —
 * фильтры и подъём «Прочего» переупорядочивают рендер, но не номера.
 *
 * Синтетический стоп «Прочее»: `id: 'other'`, `tier: 'other'`, последний
 * `planIndex`; его заголовок задаёт сервер на языке генерации (ревьюер-читаемое),
 * `status: 'ready'` сразу — заполнять нечего, содержимое (непокрытые диапазоны)
 * считает UI. UI прячет его сам, пока маршрут не достроен и при нуле непокрытых строк
 * (`docs/design/SPEC-elements.md §4.3`).
 */
/** Объяснение привязано к сохранённому файлу; все его ханки показывает UI. */
export const guidedAnnotationSchema = z.object({
    side: z.enum(['old', 'new']), start: z.number().int().positive(), end: z.number().int().positive(),
    text: z.string().trim().min(1).max(840),
}).strict().refine((note) => note.end >= note.start && note.end - note.start < 40, 'Use an ordered range of at most 40 lines.');
export const readableExampleSchema = z.object({ text: z.string().trim().min(1).max(260), evidence: storyEvidenceBlockSchema }).strict();
export const rawReadableExampleSchema = z.object({ text: z.string().trim().min(1).max(260), evidence: rawStoryEvidenceBlockSchema }).strict();
export type ReadableExample = z.infer<typeof readableExampleSchema>;
export const guidedFileSchema = z.object({
    fileId: hostIdSchema, path: relativeCodePathSchema,
    explanation: z.string().min(1).max(840).nullable(),
    example: readableExampleSchema.nullable().optional(),
    annotations: z.array(guidedAnnotationSchema).max(12),
    status: z.enum(['queued', 'filling', 'ready', 'failed']).optional(),
    failure: z.string().nullable().optional(),
});
export type GuidedFile = z.infer<typeof guidedFileSchema>;
export type GuidedAnnotation = z.infer<typeof guidedAnnotationSchema>;

export const routeStopSchema = z.object({
    id: z.string().min(1),
    /** Позиция в плане, с 1. Порядок массива `stops` — триаж (по убыванию важности). */
    planIndex: z.number().int().positive(),
    tier: routeTierSchema,
    title: z.string().min(1).max(300),
    status: routeStopStatusSchema,
    /**
     * Поля заполнения; null до готовности секции. Формула абзаца: «что изменилось → какие следствия».
     * Разметка — урезанное подмножество markdown (`docs/design/SPEC-changes-2026-09-20.md §2`): абзацы,
     * список до 4 пунктов без вложенности, инлайн-код, жирный, ссылки. Всё прочее валидатор отвергает.
     */
    paragraph: z.string().nullable(),
    /** Связка-переход к следующему стопу; отдельная от абзаца, может отсутствовать и у готового стопа. */
    bridge: z.string().nullable(),
    anchors: z.array(routeAnchorSchema),
    storyEvidence: storyEvidenceBlockSchema.optional(),
    guidedFiles: z.array(guidedFileSchema).optional(),
    example: readableExampleSchema.nullable().optional(),
    relatedFiles: z.array(z.object({ fileId: hostIdSchema, path: relativeCodePathSchema })).optional(),
    tests: z.array(routeTestClaimSchema),
    /** Сколько утверждений дайджеста отбросил валидатор («2 claims dropped — no matching test»). */
    droppedClaims: z.number().int().min(0),
    /** Ревьюер-читаемые пометки валидатора на языке снапшота: «диапазон уехал в стоп 02» и т. п. */
    validationNotes: z.array(z.string()),
    /** Провенанс секции, если отличается от снапшота (агент сменился по ходу генерации, `docs/design/SPEC-elements.md §4.4`). */
    provenance: routeProvenanceSchema.nullable(),
    /** null — стоп не затронут пушем или снапшот первый (сравнивать не с чем). */
    change: routeStopChangeSchema.nullable(),
});
export type RouteStop = z.infer<typeof routeStopSchema>;

/**
 * Почему перенос отметок дал ноль. Причина смотрит на итерацию-источник: `no_marks` —
 * отметок просмотра на ней не было, переносить нечего; `no_overlap` — отметки были, но ни одной
 * остановки целиком не осталось; `no_interdiff` — отметки были, а хост не отдал интердифф.
 */
export const routeCarriedZeroReasonSchema = z.enum(['no_interdiff', 'no_marks', 'no_overlap']);
export type RouteCarriedZeroReason = z.infer<typeof routeCarriedZeroReasonSchema>;

/**
 * Итог переноса отметок просмотра от предыдущего снапшота (баннер второго захода, `docs/design/README.md §9`).
 * `total` — остановки, которым перенос вообще возможен: с якорями; синтетическое «Прочее» и стопы
 * без якорей в знаменатель не входят, потому что в числитель попасть не могут.
 */
export const routeCarriedSchema = z.object({
    kept: z.number().int().min(0),
    total: z.number().int().min(0),
    /** null — `kept > 0`; снапшоты старого формата поля не несут — читается как null. */
    zeroReason: routeCarriedZeroReasonSchema.nullable().default(null),
});
export type RouteCarried = z.infer<typeof routeCarriedSchema>;

/**
 * Снапшот маршрута. Появляется с момента принятого скелета и дополняется
 * по мере сдачи секций; неизменяемым становится в фазе `ready`
 * (`contentHash` считается тогда же). Снапшотов у PR много — по одному на
 * каждую (пере)генерацию; сервер хранит все, текущий — один.
 */
const routeSnapshotBase = z.object({
    presentation: z.enum(['legacy', 'story']).optional(),
    storyContractVersion: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    summaryEvidence: storyEvidenceBlockSchema.optional(),
    flow: flowStateSchema.optional(),
    snapshotId: z.string().min(1),
    /** Ревьюируемый коммит (headCommit диффа) и итерация, для которых строился маршрут. */
    commit: z.string().min(1),
    baseCommit: z.string().min(1),
    diffId: hostIdSchema,
    createdAt: z.iso.datetime(),
    provenance: routeProvenanceSchema,
    /** От какого снапшота перенесён прогресс и относительно какого посчитаны `stops[].change`; null — первый. */
    previousSnapshotId: z.string().nullable(),
    /** Итог переноса прогресса; null — переносить было не от чего. */
    carried: routeCarriedSchema.nullable(),
    /**
     * Summary PR словарём описания остановки (профиль `stop`, без бюджета длины). Приезжает целиком
     * со скелетом: токен-стриминга в петле нет (`docs/protocol.md §6`).
     */
    summary: z.string(),
    /** Триаж-порядок; синтетическое «Прочее» — последним. */
    stops: z.array(routeStopSchema),
    /** Порядок «полного тура» — перестановка id всех стопов, включая «Прочее» (последним). */
    tourOrder: z.array(z.string().min(1)),
    /** Контент-хеш готового снапшота; null, пока фаза не `ready`. */
    contentHash: z.string().nullable(),
});

/** Общие инварианты объяснения для собственного хранения и совместимой HTTP-проекции. */
export function checkExplanationSnapshot(snapshot: {
    storyContractVersion?: 2 | 3 | 4 | 5 | undefined;
    presentation?: 'story' | 'legacy' | undefined;
    summaryEvidence?: z.infer<typeof storyEvidenceBlockSchema> | undefined;
    flow?: z.infer<typeof flowStateSchema> | undefined;
    commit: string;
    stops: readonly Pick<RouteStop, 'status' | 'storyEvidence' | 'guidedFiles'>[];
}, ctx: z.RefinementCtx): void {
    if (snapshot.storyContractVersion === undefined) return;
    if (snapshot.presentation !== 'story' || snapshot.summaryEvidence === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Story needs its introduction evidence.' });
    }
    if (snapshot.flow?.status === 'pending' || snapshot.flow?.status === 'ready') {
        const contexts = snapshot.flow.contexts;
        if (new Set(contexts.map((entry) => entry.id)).size !== contexts.length || contexts.some((entry) => entry.revision !== snapshot.commit)) {
            ctx.addIssue({ code: 'custom', path: ['flow', 'contexts'], message: 'Flow context must have unique IDs and match the saved head revision.' });
        }
        if (snapshot.flow.status === 'ready' && [...snapshot.flow.diagram.nodes, ...snapshot.flow.diagram.edges].some((item) => item.sources.some((source) => source.kind === 'context' && !contexts.some((entry) => entry.id === source.id)))) {
            ctx.addIssue({ code: 'custom', path: ['flow'], message: 'Flow sources must reference saved context.' });
        }
    }
    const owners = new Set<string>();
    snapshot.stops.forEach((stop, index) => {
        if (stop.status === 'ready' && stop.storyEvidence === undefined) {
            ctx.addIssue({ code: 'custom', path: ['stops', index, 'storyEvidence'], message: 'A ready story section needs evidence.' });
        }
        if (snapshot.storyContractVersion === 2) return;
        if (stop.guidedFiles === undefined || stop.guidedFiles.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['stops', index], message: 'A guided block needs its ordered files.' });
        }
        for (const file of stop.guidedFiles ?? []) {
            if (owners.has(file.fileId) || (stop.status === 'ready' && file.explanation === null)) {
                ctx.addIssue({ code: 'custom', path: ['stops', index, 'guidedFiles'], message: 'Files need one owner and ready explanations.' });
            }
            owners.add(file.fileId);
        }
    });
}
export const routeSnapshotSchema = routeSnapshotBase.superRefine(checkExplanationSnapshot);
export type RouteSnapshot = z.infer<typeof routeSnapshotSchema>;

/**
 * Результат задачи `route.skeleton` — то, что возвращает модель (валидируется
 * fail-closed при приёме `complete`; эта схема уходит в payload задачи файлом).
 * Стопы — в триаж-порядке; id и «Прочее» назначает сервер после валидации.
 */
export const routeSkeletonResultSchema = z.object({
    /** Summary PR на языке генерации — словарём описания остановки, без бюджета длины; разметку проверяет сервер. */
    summary: z.string().min(1).max(20_000),
    stops: z
        .array(
            z.object({
                title: z.string().min(1).max(300),
                tier: z.enum(['high', 'medium', 'low']),
                /**
                 * Черновой замысел стопа для задач заполнения: какие файлы/диапазоны
                 * он примерно покрывает и о чём рассказывает. В UI не показывается.
                 */
                intent: z.string().min(1).max(2000),
            }),
        )
        .min(1)
        .max(40),
    /** Порядок «полного тура»: перестановка плановых номеров (1-based). */
    tourOrder: z.array(z.number().int().positive()),
});
export type RouteSkeletonResult = z.infer<typeof routeSkeletonResultSchema>;

/**
 * Результат задачи `route.section`: заполнение одного или нескольких стопов плана
 * (батчирование секций — ручка сервера, не протокола). Якоря — по `path`;
 * в `fileId` их резолвит валидатор против итерации снапшота.
 *
 * После пуша та же задача получает в контексте предыдущий маршрут и интердифф;
 * `changeReason`/`changeThreadIds` — объяснение «why this stop changed» для стопов,
 * которые сервер классифицировал как `new`/`changed` (`RouteStop.change`). У прочих
 * стопов валидатор их отбрасывает, неизвестные id тредов — тоже.
 */
export const routeSectionResultSchema = z.object({
    stops: z
        .array(
            z.object({
                planIndex: z.number().int().positive(),
                /**
                 * Потолок схемы — санити-предел; бюджет `STOP_PARAGRAPH_MAX_CHARS` проверяет
                 * валидатор секции, чтобы модель получила текст с советом, а не отказ zod.
                 */
                paragraph: z.string().min(1).max(4000),
                bridge: z.string().min(1).max(1000).optional(),
                changeReason: z.string().min(1).max(1000).optional(),
                changeThreadIds: z.array(hostIdSchema).max(20).optional(),
                anchors: z
                    .array(
                        z.object({
                            path: z.string().min(1),
                            side: z.enum(['old', 'new']),
                            start: z.number().int().positive(),
                            end: z.number().int().positive(),
                            collapsed: z.boolean().optional(),
                        }),
                    )
                    .min(1)
                    .max(200),
                tests: z
                    .array(
                        z.object({
                            kind: routeTestClaimKindSchema,
                            text: z.string().min(1).max(1000),
                            testPath: z.string().min(1).optional(),
                            testLine: z.number().int().positive().optional(),
                        }),
                    )
                    .max(100)
                    .optional(),
            }),
        )
        .min(1)
        .max(40),
});
export type RouteSectionResult = z.infer<typeof routeSectionResultSchema>;

/** Краткий рассказ использует тот же жизненный цикл, без требований ревью к содержимому. */
export const storySkeletonResultSchema = z.object({
    contractVersion: z.literal(2),
    summary: z.string().min(1).max(840),
    evidence: rawStoryEvidenceBlockSchema,
    stops: z.array(z.object({ title: z.string().min(1).max(300), intent: z.string().min(1).max(2000) }).strict()).min(1).max(10),
}).strict();
export const storySectionResultSchema = z.object({
    contractVersion: z.literal(2),
    stops: z.array(z.object({
        planIndex: z.number().int().positive(),
        paragraph: z.string().min(1).max(4000),
        evidence: rawStoryEvidenceBlockSchema,
    }).strict()).min(1).max(10),
}).strict();

/** Новый генератор; v2 сохранён только для совместимого чтения/завершения старых задач. */
export const guidedSkeletonResultSchema = z.object({
    contractVersion: z.literal(3), summary: z.string().min(1).max(840), evidence: rawStoryEvidenceBlockSchema,
    stops: z.array(z.object({
        title: z.string().min(1).max(300), intent: z.string().min(1).max(2000),
        files: z.array(relativeCodePathSchema).min(1), relatedFiles: z.array(relativeCodePathSchema).max(20),
    }).strict()).min(1).max(20),
}).strict();
export const guidedSectionResultSchema = z.object({
    contractVersion: z.literal(3), stops: z.array(z.object({
        planIndex: z.number().int().positive(), paragraph: z.string().min(1).max(840), evidence: rawStoryEvidenceBlockSchema,
        files: z.array(z.object({
            path: relativeCodePathSchema, explanation: z.string().trim().min(1).max(840),
            annotations: z.array(guidedAnnotationSchema).max(12),
        }).strict()).min(1),
    }).strict()).min(1).max(20),
}).strict();

/** Понятная подача: пример входит в общий бюджет файла; схема строится независимо. */
export const readableSkeletonResultSchema = z.object({
    contractVersion: z.literal(4), summary: z.string().trim().min(1).max(500), evidence: rawStoryEvidenceBlockSchema,
    stops: z.array(z.object({ title: z.string().min(1).max(100), intent: z.string().min(1).max(2000), files: z.array(relativeCodePathSchema).min(1), relatedFiles: z.array(relativeCodePathSchema).max(20) }).strict()).min(1).max(20),
}).strict();
export const readableSectionResultSchema = z.object({ contractVersion: z.literal(4), stops: z.array(z.object({
    planIndex: z.number().int().positive(), paragraph: z.string().trim().min(1).max(400), evidence: rawStoryEvidenceBlockSchema,
    example: rawReadableExampleSchema.nullable(),
    files: z.array(z.object({ path: relativeCodePathSchema, explanation: z.string().trim().min(1).max(360), example: rawReadableExampleSchema.nullable(), annotations: z.array(guidedAnnotationSchema).max(12) }).strict()
        .refine((file) => file.explanation.length + (file.example?.text.length ?? 0) <= 620, 'Keep the file introduction and example within 620 characters.')).min(1),
}).strict().refine((stop) => stop.paragraph.length + (stop.example?.text.length ?? 0) <= 620, 'Keep the block introduction and example within 620 characters.')).min(1).max(20) }).strict();

/** Обзор и частичное заполнение назначенных файлов; предел описания — защитный размер payload. */
export const overviewSkeletonResultSchema = readableSkeletonResultSchema.extend({
    contractVersion: z.literal(5), summary: z.string().trim().min(1).max(20_000),
});
export const sectionAssignmentSchema = z.object({ files: z.array(relativeCodePathSchema).min(1).max(3), introduction: z.boolean() }).strict();
export type SectionAssignment = z.infer<typeof sectionAssignmentSchema>;
export const progressiveSectionResultSchema = z.object({
    contractVersion: z.literal(5),
    stops: z.array(z.object({
        planIndex: z.number().int().positive(),
        paragraph: z.string().trim().min(1).max(400).nullable(),
        evidence: rawStoryEvidenceBlockSchema.nullable(), example: rawReadableExampleSchema.nullable(),
        files: z.array(z.object({
            path: relativeCodePathSchema, explanation: z.string().trim().min(1).max(360),
            example: rawReadableExampleSchema.nullable(), annotations: z.array(guidedAnnotationSchema).max(12),
        }).strict().refine((file) => file.explanation.length + (file.example?.text.length ?? 0) <= 620, 'Keep the file introduction and example within 620 characters.')).min(1).max(3),
    }).strict().refine((stop) => (stop.paragraph === null) === (stop.evidence === null) &&
        (stop.paragraph !== null || stop.example === null), 'Introduction and its evidence must be both present or both null.')
        .refine((stop) => (stop.paragraph?.length ?? 0) + (stop.example?.text.length ?? 0) <= 620, 'Keep the block introduction and example within 620 characters.')).min(1).max(1),
}).strict();

export type StorySkeletonResult = z.infer<typeof storySkeletonResultSchema>;
export type StorySectionResult = z.infer<typeof storySectionResultSchema>;

/** Точный текст для контекста вопроса; одинаковое представление на сервере и в UI. */
export function explanationText(snapshot: RouteSnapshot, sectionId?: string): string {
    const stops = snapshot.tourOrder.flatMap((id) => {
        const stop = snapshot.stops.find((entry) => entry.id === id);
        return stop?.paragraph == null ? [] : [{ id, text: `${stop.title}\n\n${stop.paragraph}${stop.example == null ? '' : `\nExample: ${stop.example.text}`}` }];
    });
    const whole = [snapshot.summary, flowText(snapshot.flow), ...stops.map((stop) => stop.text)].filter(Boolean).join('\n\n');
    if (sectionId === undefined) return whole;
    const file = snapshot.stops.flatMap((stop) => stop.guidedFiles ?? []).find((entry) => `file:${entry.fileId}` === sectionId);
    const focus = file !== undefined ? `${file.path}\n${file.explanation ?? '[Explanation pending]'}${file.example == null ? '' : `\nExample: ${file.example.text}`}\n${file.annotations.map((note) => `${note.side}:${String(note.start)}-${String(note.end)}: ${note.text}`).join('\n')}` : sectionId === 'intro' ? snapshot.summary : stops.find((stop) => stop.id === sectionId)?.text;
    return focus === undefined ? '' : `Reading focus:\n${focus}\n\nWhole explanation:\n${whole}`;
}
