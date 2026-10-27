import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ExplanationBlock, FileDiff, Locale, PrDiff, PrMeta, RouteStop, StoryEvidenceBlock, UiGenerationCap } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import { storyGuide } from './story.js';
import type { EnqueueInput } from './queue.js';
import type { RegenerationContextFiles } from './route-prompts.js';
import { promptLocale, sectionGuide, sectionInstructions, skeletonGuide, skeletonInstructions } from './route-prompts.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import {
    PREVIOUS_ROUTE_FILE,
    previousRouteContext,
    THREADS_SINCE_FILE,
    threadsSinceContext,
} from './route-regeneration.js';
import { walkPatch } from './route/diff-index.js';
import type { SharedPayloadStore } from './shared-payload.js';
import { diffKeyOf } from './shared-payload.js';

/**
 * Payload генеративных задач маршрута (docs/protocol.md §4): тяжёлый контекст — файлами, инструкция в
 * stdout — короткая, схема результата — часть задачи.
 *
 * Каждая задача самодостаточна: сессия агента могла умереть и переподключиться, поэтому в payload
 * едет всё нужное — методичка, дифф PR и (у секций) план маршрута. Неизменная часть (методичка и
 * дифф) лежит по стабильному пути в общем каталоге (`shared-payload.ts`), каталог генерации держит
 * только своё. Тексты английские: их читает модель; язык результата называет локаль генерации —
 * имя файла методички несёт хеш содержимого, поэтому две локали не спорят за один файл.
 *
 * Приоритет — фоновый: генерация маршрута идёт минутами и не должна обгонять то, чего ревьюер
 * ждёт у экрана (docs/protocol.md §5).
 *
 * Запись — синхронная. Постановка задач живёт в сверке оркестратора, а сверка синхронна: она
 * зовётся из подписчика очереди и из приёмщика результата. Файлы payload — сотни килобайт на
 * генерацию, и пишутся они считанные разы за маршрут, поэтому синхронная запись дешевле, чем
 * асинхронный автомат вокруг неё.
 */

/**
 * Бюджет контекстного файла с диффом, в байтах (docs/architecture.md §7.5). ~320 КБ — это примерно
 * 80 тысяч токенов: крупный PR влезает целиком, а патологический (сгенерированные ассеты,
 * снапшот-тесты на мегабайты) режется, вместо того чтобы выесть окно модели и убить латентность.
 * Список изменённых файлов в бюджет не входит — он не режется никогда.
 */
export const CONTEXT_BUDGET_BYTES = 320 * 1024;

/**
 * Бюджеты контекста перегенерации. Считаются отдельно от диффа PR: интердифф не должен
 * вытеснять патчи, по которым секция ставит якоря, а прошлый маршрут — самое дешёвое к потере,
 * он лишь помогает сохранить номера стопов. 128 КБ хватает любому обычному пушу целиком, 64 КБ —
 * маршруту на десяток стопов и десятку тредов с ответами.
 */
export const REGENERATION_BUDGETS: RegenerationBudgets = {
    interdiff: 128 * 1024,
    previousRoute: 64 * 1024,
    threadsSince: 64 * 1024,
};

export interface RegenerationBudgets {
    readonly interdiff: number;
    readonly previousRoute: number;
    readonly threadsSince: number;
}

/** Права каталогов payload — те же 0700, что у остального стейта PR (docs/architecture.md §6). */
const DIR_MODE = 0o700;
/** Секретов в payload нет, но и читать его посторонним незачем. */
const FILE_MODE = 0o600;

/** Что билдеру нужно знать о PR: дифф обязателен, шапка — украшение (её отказ маршрут не рушит). */
export interface RoutePayloadContext {
    readonly diff: PrDiff;
    readonly meta: PrMeta | null;
    /** Прошлый заход: маршрут перестраивается после пуша; null — строится впервые. */
    readonly regeneration?: RouteRegenerationContext | null;
}

/** Контекст задачи маршрута: тот же PR плюс язык, на котором задача просит писать результат. */
export interface RouteTaskContext extends RoutePayloadContext {
    readonly locale: Locale;
    readonly presentation?: 'legacy' | 'story' | undefined;
    readonly introduction?: string;
    readonly introductionEvidence?: StoryEvidenceBlock | undefined;
}

export interface RoutePayloadWriterOptions {
    /** Изолированный каталог маршрута; подкаталог на генерацию создаётся здесь. */
    readonly payloadDir: string;
    /** Общий контекст PR: методичка и дифф едут по стабильному пути, а не копией на задачу. */
    readonly shared: SharedPayloadStore;
    readonly budgetBytes?: number;
    /** Потолки файлов перегенерации; по умолчанию — `REGENERATION_BUDGETS`. */
    readonly regenerationBudgets?: Partial<RegenerationBudgets>;
}

/**
 * Материализация payload задач маршрута на диске. Одна генерация — один подкаталог; новая
 * генерация заводит свой и вычищает прежние, поэтому каталог не растёт без границ.
 */
export class RoutePayloadWriter {
    private readonly payloadDir: string;
    private readonly shared: SharedPayloadStore;
    private readonly budgetBytes: number;
    private readonly regenerationBudgets: RegenerationBudgets;
    private generationDir: string | null = null;

    constructor(options: RoutePayloadWriterOptions) {
        this.payloadDir = options.payloadDir;
        this.shared = options.shared;
        this.budgetBytes = options.budgetBytes ?? CONTEXT_BUDGET_BYTES;
        this.regenerationBudgets = { ...REGENERATION_BUDGETS, ...options.regenerationBudgets };
    }

    /**
     * Новая генерация: свежий подкаталог, прежние удалены. Контекст перегенерации
     * материализуется здесь один раз — он общий для скелета и всех секций генерации.
     */
    beginGeneration(regeneration: RouteRegenerationContext | null = null): void {
        this.startGeneration();
        if (regeneration === null) {
            return;
        }
        const budgets = this.regenerationBudgets;
        this.writeFile(PREVIOUS_ROUTE_FILE, previousRouteContext(regeneration, budgets.previousRoute));
        this.writeFile(THREADS_SINCE_FILE, threadsSinceContext(regeneration, budgets.threadsSince));
    }

    /** Задача `route.skeleton`: summary, план стопов и порядок полного тура одним результатом. */
    skeletonTask(context: RouteTaskContext): EnqueueInput {
        // Дифф PR материализуется первым: он открывает сборку общих ключей, срез к ней добавляется.
        const prDiff = this.prDiff(context);
        const regeneration = this.regenerationFiles(context);
        const locale = context.locale;
        return {
            type: 'route.skeleton',
            priority: 'background',
            instructions: context.presentation === 'story' ? 'Read the guide and PR context. Plan a concise coherent explanation. Return JSON matching the attached schema.' : skeletonInstructions(locale, regeneration.present),
            // Своего у скелета нет: и методичка, и дифф — общие пути.
            contextFiles: [
                this.shared.guide('skeleton-guide', context.presentation === 'story' ? storyGuide('skeleton', locale) : skeletonGuide(locale)),
                prDiff.file,
                ...regeneration.files,
            ],
            resultSchemaFile: this.writeSchema(context.presentation === 'story' ? 'readableSkeleton' : 'skeleton'),
        };
    }

    /**
     * Кап генерации по диффу и бюджету — та же чистая функция, что печатает контекст скелета.
     * Приёмка скелета считает его заново: контекст постановки процесс мог не пережить, а от
     * снапшота к строке в шапке маршрута кап обязан доехать и после рестарта.
     */
    generationCap(context: RoutePayloadContext): UiGenerationCap {
        return prDiffPayload(context, this.budgetBytes).cap;
    }

    /**
     * Задача `route.section`: заполнение одного или нескольких стопов плана. Целевые номера едут
     * в тексте задачи — отдельного поля у `taskSchema` нет, батчирование остаётся ручкой сервера.
     * «Прочее» секций не имеет: его синтезировал скелет, содержимое считает UI.
     */
    sectionTask(
        context: RouteTaskContext,
        planIndexes: readonly number[],
        stops: readonly RouteStop[],
        intents: ReadonlyMap<number, string>,
    ): EnqueueInput {
        const locale = context.locale;
        const name = `section-${planIndexes.map(pad2).join('-')}-plan.md`;
        const plan = this.writeFile(name, context.presentation === 'story'
            ? explanationPlanContext(planIndexes, stops, intents, context)
            : sectionPlanContext(planIndexes, stops, intents, locale));
        const prDiff = this.prDiff(context);
        const regeneration = this.regenerationFiles(context);
        return {
            type: 'route.section',
            priority: 'background',
            instructions: context.presentation === 'story' ? `Write every assigned section (${planIndexes.join(', ')}) as one coherent concise explanation, continuing the introduction without repeating it. Follow the guide and attached result schema.` : sectionInstructions(locale, planIndexes, regeneration.present),
            contextFiles: [
                this.shared.guide('section-guide', context.presentation === 'story' ? storyGuide('section', locale) : sectionGuide(locale)),
                prDiff.file,
                ...regeneration.files,
                plan,
            ],
            resultSchemaFile: this.writeSchema(context.presentation === 'story' ? 'readableSection' : 'section'),
        };
    }

    /**
     * Контекст перегенерации задачи: срез пишется в общий каталог (запись идемпотентна), а
     * прошлый маршрут и обсуждение уже лежат в каталоге генерации — их положил `beginGeneration`.
     * После рестарта сервера контекст генерации потерян, и файлы берутся с диска как есть.
     */
    private regenerationFiles(context: RoutePayloadContext): {
        files: string[];
        present: RegenerationContextFiles;
    } {
        const interdiff = context.regeneration?.interdiff ?? null;
        const interdiffFile =
            interdiff === null
                ? null
                : this.shared.interdiff(
                      diffKeyOf(interdiff),
                      interdiffContext(interdiff, this.regenerationBudgets.interdiff),
                  );
        const previousRoute = this.existingFile(PREVIOUS_ROUTE_FILE);
        const threadsSince = this.existingFile(THREADS_SINCE_FILE);
        return {
            files: [interdiffFile, previousRoute, threadsSince].filter((file): file is string => file !== null),
            present: {
                interdiff: interdiffFile !== null,
                previousRoute: previousRoute !== null,
                threadsSince: threadsSince !== null,
            },
        };
    }

    /** Файл каталога генерации, если он там есть: после рестарта его писал прошлый процесс. */
    private existingFile(name: string): string | null {
        const file = path.join(this.currentDir(), name);
        return fs.existsSync(file) ? file : null;
    }

    /** Общий дифф PR по ключу пары коммитов: у скелета, секций и вопроса чата он один и тот же. */
    private prDiff(context: RoutePayloadContext): { file: string; cap: UiGenerationCap } {
        const built = prDiffPayload(context, this.budgetBytes);
        this.shared.prDiff(diffKeyOf(context.diff), built.content);
        const index = context.diff.files.map((entry, i) => ({ path: entry.path, file: this.shared.savedPatch(diffKeyOf(context.diff), i, patchBlock(entry, i, false)) }));
        this.shared.savedPatchIndex(diffKeyOf(context.diff), JSON.stringify({ diffId: context.diff.diffId, headCommit: context.diff.headCommit, files: index }, null, 2));
        return { file: this.shared.prDiff(diffKeyOf(context.diff), built.content), cap: built.cap };
    }

    /** Свежий подкаталог генерации; всё прежнее вычищается — его задачи только что отменены. */
    private startGeneration(): string {
        const dir = path.join(this.payloadDir, `gen-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
        this.makeDir(dir);

        for (const entry of fs.readdirSync(this.payloadDir)) {
            const stale = path.join(this.payloadDir, entry);
            if (stale !== dir) {
                fs.rmSync(stale, { recursive: true, force: true });
            }
        }

        this.generationDir = dir;
        return dir;
    }

    /**
     * Каталог текущей генерации. Ленивый путь нужен рестарту сервера: сверка застаёт генерацию,
     * начатую прошлым процессом, и доставляет её недостающие задачи. Каталог той генерации тогда
     * подхватывается, а не заводится заново: её задачи пережили рестарт вместе со своими
     * контекстными файлами, и вычистка оставила бы их с битыми путями.
     */
    private currentDir(): string {
        const known = this.generationDir;
        if (known !== null) {
            return known;
        }

        const adopted = this.latestGenerationDir();
        if (adopted === null) {
            return this.startGeneration();
        }
        this.makeDir(adopted);
        this.generationDir = adopted;
        return adopted;
    }

    /** Самый свежий подкаталог генерации; `null` — payload этого PR ещё не писался. */
    private latestGenerationDir(): string | null {
        if (!fs.existsSync(this.payloadDir)) {
            return null;
        }

        let latest: { dir: string; time: number } | null = null;
        for (const entry of fs.readdirSync(this.payloadDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const dir = path.join(this.payloadDir, entry.name);
            const time = fs.statSync(dir).mtimeMs;
            // Ровесники разводятся по имени: у имени в хвосте случайные байты, порядок стабилен.
            if (latest === null || time > latest.time || (time === latest.time && dir > latest.dir)) {
                latest = { dir, time };
            }
        }
        return latest?.dir ?? null;
    }

    private makeDir(dir: string): void {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        // mkdir применяет mode с учётом umask, а каталоги могли существовать и раньше.
        fs.chmodSync(this.payloadDir, DIR_MODE);
        fs.chmodSync(dir, DIR_MODE);
    }

    private writeFile(name: string, content: string): string {
        const file = path.join(this.currentDir(), name);
        fs.writeFileSync(file, content, { mode: FILE_MODE });
        return file;
    }

    /** Схема результата файлом (docs/protocol.md §4): канон — zod, JSON Schema — производная. */
    private writeSchema(kind: 'skeleton' | 'section' | 'readableSkeleton' | 'readableSection'): string {
        const key = kind === 'skeleton' ? 'routeSkeletonResult' : kind === 'section' ? 'routeSectionResult' : `${kind}Result`;
        const schema = generateJsonSchemas()[key];
        return this.writeFile(`route-${kind}-result.schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
    }
}

/**
 * Общий контекстный файл диффа: шапка PR, полный список файлов, патчи под бюджет. Один на всех —
 * его читают и скелет, и секции, и вопрос чата по всему PR, — поэтому политика урезания тоже одна,
 * по нуждам секций: тесты режутся последними, дайджест обязан якориться на их реальные строки.
 */
export function prDiffContext(context: RoutePayloadContext, budgetBytes: number): string {
    return prContext(context, budgetBytes).content;
}

/**
 * Тот же файл вместе с метриками урезания: их UI показывает в шапке маршрута и в
 * баннере. Считаются одним проходом с текстом — второй раз резать дифф незачем.
 */
export function prDiffPayload(context: RoutePayloadContext, budgetBytes: number): PatchedContext {
    return prContext(context, budgetBytes);
}

/**
 * Срез между итерациями для задач перегенерации: те же патчи с тем же гаттером номеров, только
 * старая сторона — голова итерации прошлого маршрута, а новая — голова итерации этой генерации.
 * Бюджет свой: интердифф не имеет права вытеснить дифф PR, по которому ставятся якоря.
 */
export function interdiffContext(interdiff: PrDiff, budgetBytes: number): string {
    return patchedContext(interdiff, interdiffHead(interdiff), budgetBytes, INTERDIFF_PATCHES_HEADING).content;
}

/** Шапка среза: что это за патчи, между какими коммитами и как их читать. */
function interdiffHead(interdiff: PrDiff): string {
    const additions = interdiff.files.reduce((total, file) => total + file.additions, 0);
    const deletions = interdiff.files.reduce((total, file) => total + file.deletions, 0);
    const rows = interdiff.files.map((file, index) =>
        row([
            fileNumber(index),
            `\`${file.path}\``,
            file.changeType,
            `+${String(file.additions)} / -${String(file.deletions)}`,
            fileNotes(file),
        ]),
    );
    return [
        `# Interdiff ${shortCommit(interdiff.baseCommit)} -> ${shortCommit(interdiff.headCommit)}`,
        '',
        'What the author pushed after the previous route was built. The old side of these patches is',
        'the commit of the previous route, the new side is the commit this task works on. This is not',
        'the diff of the pull request: it never replaces the file list you must cover.',
        '',
        `- Slice: ${interdiff.baseCommit} -> ${interdiff.headCommit}`,
        `- Volume: ${String(interdiff.files.length)} files, +${String(additions)} / -${String(deletions)} lines`,
        '',
        '## Files the push touched',
        '',
        '| file # | file | change | +/- | notes |',
        '|---|---|---|---|---|',
        ...rows,
    ].join('\n');
}

/** Коммит в том же коротком виде, в каком его показывает UI. */
function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

/**
 * Свой файл задачи секции: план маршрута целиком с выделенными целевыми стопами и их замыслами.
 * Диффа здесь нет — он общий. Якорей у стопа до заполнения нет, поэтому какие файлы относятся к
 * стопу, решает модель, и урезать дифф до «файлов стопа» нечем.
 */
export function sectionPlanContext(
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
    locale: Locale = 'ru',
): string {
    return `${planBlock(planIndexes, stops, intents, locale)}\n`;
}

/** План объяснения не включает триаж, покрытие тестами или поля прежнего ревью. */
function explanationPlanContext(
    planIndexes: readonly number[], stops: readonly ExplanationBlock[],
    intents: ReadonlyMap<number, string>, context: RouteTaskContext,
): string {
    const blocks = stops.filter((stop) => planIndexes.includes(stop.planIndex)).map((stop) => ({
        planIndex: stop.planIndex, title: stop.title, intent: intents.get(stop.planIndex),
        files: stop.guidedFiles, relatedFiles: stop.relatedFiles,
    }));
    return [
        '## Accepted blocks and ordered file assignments', JSON.stringify(blocks),
        '## Already shown introduction', context.introduction ?? '',
        '## Accepted introduction evidence', JSON.stringify(context.introductionEvidence ?? null), '',
    ].join('\n\n');
}

/**
 * Шапка блока патчей. Патчи печатаются с гаттером номеров, поэтому здесь же — как его читать:
 * якоря секций держатся на абсолютных номерах строк, и считать их по заголовкам ханков модель
 * не должна (сдвиг на пару строк убивает якорь на приёмке).
 */
const GUTTER_EXPLAINED = [
    'Every patch line is printed with its line numbers in front of it: `old new | line`.',
    '`old` is the number on the old side of the file, `new` on the new side, `.` means the line does',
    'not exist on that side. Added (`+`) lines are numbered on the new side only, deleted (`-`) lines',
    'on the old side only, unchanged context lines exist on both. Hunk headers (`@@`) carry no',
    'numbers of their own.',
].join('\n');

const PATCHES_HEADING = [
    '## Patches',
    '',
    GUTTER_EXPLAINED,
    '',
    'Line anchors of a stop are validated against exactly these printed numbers: read them off the',
    'gutter, never count lines yourself.',
].join('\n');

/**
 * Шапка патчей среза: гаттер тот же, но якоря по нему ставить нельзя. Старая сторона среза —
 * голова прошлой итерации, а `side: 'old'` резолвится по базе PR; на новой стороне тоже есть щель
 * (строка, возвращённая пушем к базовому значению, в срезе `+`, а в диффе PR — контекст).
 */
const INTERDIFF_PATCHES_HEADING = [
    '## Patches of the push',
    '',
    GUTTER_EXPLAINED,
    '',
    'Never take line anchors from here. These numbers belong to the slice: its old side is the commit',
    'of the previous route, not the base of the pull request, and its new side marks lines the push',
    'moved, not lines the pull request changed. Anchors are read off the gutter of the pull request',
    'diff and validated against it alone. This file tells you what moved, nothing more.',
].join('\n');

/**
 * Контекст PR под бюджет: шапка, полный список файлов и патчи. Бюджет считается по итоговому
 * файлу целиком, вместе с разделителями блоков, — иначе «не больше N байт» перестаёт быть
 * правдой ровно тогда, когда это важно (docs/architecture.md §7.5).
 */
function prContext(context: RoutePayloadContext, budgetBytes: number): PatchedContext {
    const { diff, meta } = context;
    return patchedContext(diff, [metaBlock(diff, meta), fileListBlock(diff)].join('\n\n'), budgetBytes);
}

/** Готовый файл контекста и то, чего в нём не хватило до полного диффа. */
interface PatchedContext {
    readonly content: string;
    readonly cap: UiGenerationCap;
}

/**
 * Шапка плюс патчи под бюджет: общий печатник диффа PR и среза между итерациями. Шапка блока
 * патчей у них разная — по диффу PR якоря ставятся, по срезу нет.
 */
function patchedContext(
    diff: PrDiff,
    head: string,
    budgetBytes: number,
    patchesHeading: string = PATCHES_HEADING,
): PatchedContext {
    const sections = diff.files.map((file, index) => ({
        file,
        index,
        full: patchBlock(file, index, false),
        omitted: patchBlock(file, index, true),
    }));

    const fixed = [head, patchesHeading];
    const blockCount = fixed.length + sections.length;
    // `join('\n\n')` плюс завершающий перевод строки — это тоже байты файла.
    let size =
        fixed.reduce((total, block) => total + byteLength(block), 0) +
        sections.reduce((total, section) => total + byteLength(section.full), 0) +
        2 * (blockCount - 1) +
        1;

    const kept = new Set(sections.map((section) => section.index));
    for (const section of dropOrder(sections)) {
        if (size <= budgetBytes) {
            break;
        }
        const saved = byteLength(section.full) - byteLength(section.omitted);
        // Пометка об урезании иногда длиннее самого патча — на таких файлах резать нечего.
        if (saved <= 0) {
            continue;
        }
        kept.delete(section.index);
        size -= saved;
    }

    const patches = sections.map((section) => (kept.has(section.index) ? section.full : section.omitted));
    const dropped = sections.filter((section) => !kept.has(section.index));
    return {
        content: `${[...fixed, ...patches].join('\n\n')}\n`,
        cap: {
            filesCovered: kept.size,
            filesTotal: sections.length,
            // Ранг 0 — это ровно «генерённое и не тест»: генерённый снапшот-тест режется наравне
            // с обычным кодом, и списывать его на машинную группу было бы враньём.
            machineFiles: dropped.filter((section) => protectionRank(section.file) === 0).length,
            truncated: dropped.some((section) => protectionRank(section.file) >= 1),
        },
    };
}

/**
 * Порядок кандидатов на урезание. Первыми уходят генерённые файлы (команда не требует их ревью),
 * последними — тесты. Внутри группы первым режется самый большой патч: он освобождает бюджет
 * наименьшим числом потерянных файлов. Путь — детерминированный добор.
 */
function dropOrder<T extends { file: FileDiff; full: string }>(sections: readonly T[]): T[] {
    return [...sections].sort((left, right) => {
        const rank = protectionRank(left.file) - protectionRank(right.file);
        if (rank !== 0) {
            return rank;
        }
        const size = byteLength(right.full) - byteLength(left.full);
        return size !== 0 ? size : left.file.path.localeCompare(right.file.path);
    });
}

/**
 * Ранг защиты: 0 режется первым, 2 — последним. Защита тестов сильнее пометки «генерённое»:
 * снапшот-тест хост честно метит генерённым, а дайджесту всё равно нужны его строки для
 * `testPath`/`testLine`.
 */
function protectionRank(file: FileDiff): number {
    if (/\.(md|rst|txt|adoc)$/i.test(file.path)) return file.generated ? 0 : 1;
    if (isTestPath(file.path)) {
        return 2;
    }
    return file.generated ? 0 : 1;
}

/** Тест-файл по пути: каталог тестов или суффикс имени. Содержимое файла не разбираем. */
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__)(\/|$)|[._-](test|spec|tests|specs)\.[^/]+$/i;

function isTestPath(filePath: string): boolean {
    return TEST_PATH.test(filePath);
}

function metaBlock(diff: PrDiff, meta: PrMeta | null): string {
    const additions = diff.files.reduce((total, file) => total + file.additions, 0);
    const deletions = diff.files.reduce((total, file) => total + file.deletions, 0);
    const lines = ['# Pull request'];
    if (meta !== null) {
        const { login, displayName } = meta.author;
        const author = displayName === null ? login : `${login} (${displayName})`;
        lines.push(
            '',
            `- Title: ${meta.title}`,
            `- Author: ${author}`,
            `- Branches: ${meta.fromBranch} -> ${meta.toBranch}`,
            `- State: ${meta.state} (${meta.statusLabel})`,
        );
    } else {
        lines.push('', '- The host adapter gave no pull request metadata: judge by the diff alone.');
    }
    lines.push(
        `- Diff: base ${diff.baseCommit} -> head ${diff.headCommit}`,
        `- Volume: ${String(diff.files.length)} files, +${String(additions)} / -${String(deletions)} lines`,
    );
    return lines.join('\n');
}

/** Полный список изменённых файлов. Не режется никогда: правило покрытия требует знать все файлы. */
function fileListBlock(diff: PrDiff): string {
    const rows = diff.files.map((file, index) =>
        row([
            fileNumber(index),
            `\`${file.path}\``,
            file.changeType,
            `+${String(file.additions)} / -${String(file.deletions)}`,
            fileNotes(file),
        ]),
    );
    return [
        `## Changed files (${String(diff.files.length)}, complete list)`,
        '',
        'This list is never truncated, even when patches below are. Every file here must be accounted',
        'for by the route: placed in a stop, or knowingly left to the synthetic last stop.',
        '',
        '| file # | file | change | +/- | notes |',
        '|---|---|---|---|---|',
        ...rows,
    ].join('\n');
}

function fileNotes(file: FileDiff): string {
    const notes: string[] = [];
    if (file.generated) {
        notes.push('generated, no review required');
    }
    if (file.binary) {
        notes.push('binary');
    }
    if (file.oldPath !== null && file.oldPath !== file.path) {
        notes.push(`was \`${file.oldPath}\``);
    }
    return notes.join('; ');
}

function patchBlock(file: FileDiff, index: number, omit: boolean): string {
    const stats = `+${String(file.additions)} / -${String(file.deletions)}`;
    const header = `### File ${fileNumber(index)}. \`${file.path}\` — ${file.changeType}, ${stats}`;
    if (file.patch === null) {
        const reason = file.binary ? 'binary file' : 'the host gave no textual patch';
        return `${header}\n\nno patch — ${reason}; use the stats above; the file still must be placed`;
    }
    if (omit) {
        const lines = file.additions + file.deletions;
        return `${header}\n\npatch omitted — ${String(lines)} lines, use the stats above; the file still must be placed`;
    }

    const body = numberedPatch(file.patch);
    const fence = '`'.repeat(fenceLength(body));
    return `${header}\n\n${fence}text\n${body}\n${fence}`;
}

/** Ширина колонки гаттера: шестизначных номеров строк в ревью не бывает. */
const GUTTER_WIDTH = 5;
/** Строки на этой стороне нет — у добавленной нет старого номера, у удалённой нового. */
const NO_LINE = '.';

/**
 * Патч с номерами строк обеих сторон в гаттере: `old new | line`. Считает `walkPatch` — тот же
 * скан ханков, которым валидатор потом резолвит якоря, поэтому напечатанный номер и принимаемый
 * номер — один и тот же номер по построению.
 */
function numberedPatch(patch: string): string {
    const lines = [...walkPatch(patch)];
    // Патч, кончающийся переводом строки, даёт пустой хвост — он не строка файла, а артефакт split.
    const last = lines.at(-1);
    if (last?.raw === '' && last.old === null && last.new === null) {
        lines.pop();
    }
    return lines.map((line) => `${gutterCell(line.old)} ${gutterCell(line.new)} | ${line.raw}`).join('\n');
}

function gutterCell(value: number | null): string {
    return (value === null ? NO_LINE : String(value)).padStart(GUTTER_WIDTH, ' ');
}

/** Забор кодового блока длиннее самой длинной серии бэктиков внутри патча. */
function fenceLength(patch: string): number {
    const runs = patch.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return Math.max(3, longest + 1);
}

/** План маршрута для задачи секции: целевые стопы выделены, у каждого стопа — его замысел. */
function planBlock(
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
    locale: Locale,
): string {
    const targets = new Set(planIndexes);
    const ordered = [...stops].sort((left, right) => left.planIndex - right.planIndex);

    const rows = ordered.map((stop) =>
        row([String(stop.planIndex), stop.tier, stop.title, planRole(stop, targets)]),
    );

    const targetBlocks = ordered
        .filter((stop) => targets.has(stop.planIndex))
        .map((stop) =>
            [
                `### Stop ${String(stop.planIndex)} — ${stop.tier} — ${stop.title}`,
                '',
                `Intent, written for you by the planner (${promptLocale(locale).inLanguage}, the reviewer never sees it):`,
                '',
                ...(intents.get(stop.planIndex) ?? '(the planner left no intent — go by the title)')
                    .split('\n')
                    .map((line) => `> ${line}`),
            ].join('\n'),
        );

    const others = ordered
        .filter((stop) => !targets.has(stop.planIndex) && stop.tier !== 'other')
        .map((stop) => {
            const intent = intents.get(stop.planIndex) ?? '—';
            return `- stop ${String(stop.planIndex)} (${stop.tier}) ${stop.title} — ${intent}`;
        });

    return [
        '# Route plan (fixed by the server)',
        '',
        'The plan is already accepted and its numbers are stable: `planIndex` is the number printed',
        'here, written as a plain JSON number (stop 3 is `"planIndex": 3`, never `"03"`). Do not confuse',
        'these stop numbers with the `file #` column of the changed files list, which lives in the shared',
        'pull request file of this task.',
        'Fill in the stops marked as your target and no others.',
        '',
        '| stop # | tier | title | |',
        '|---|---|---|---|',
        ...rows,
        '',
        '## Your target stops',
        '',
        // Пустая строка между блоками: иначе следующий заголовок липнет к цитате замысла.
        targetBlocks.join('\n\n'),
        '',
        '## The other stops — context only, do not fill them in',
        '',
        ...(others.length === 0 ? ['- none'] : others),
        '',
        'Their lines belong to them: do not anchor the same range twice, and use `bridge` to hand the',
        'reviewer over to the next stop in the order above.',
    ].join('\n');
}

/** Роль стопа в задаче секции: заполняемый, соседний или синтетическое «Прочее» сервера. */
function planRole(stop: RouteStop, targets: ReadonlySet<number>): string {
    if (targets.has(stop.planIndex)) {
        return '**your target**';
    }
    return stop.tier === 'other' ? 'synthetic, filled by the server' : 'other stop';
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

/**
 * Номер файла в списке — двузначный («03 / 07»), чтобы список и заголовки патчей читались ровно.
 * Номера стопов так не печатаются: `planIndex` модель возвращает числом, и «03» в её JSON — отказ
 * приёмки.
 */
function fileNumber(index: number): string {
    return pad2(index + 1);
}

function pad2(value: number): string {
    return value < 10 ? `0${String(value)}` : String(value);
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}
