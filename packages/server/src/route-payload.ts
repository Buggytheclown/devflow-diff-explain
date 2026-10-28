import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FlowState, ExplanationBlock, FileDiff, Locale, PrDiff, PrMeta, RouteStop, StoryEvidenceBlock, UiGenerationCap, SectionAssignment } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import { storyGuide } from './story.js';
import { architectureGuide } from './architecture-story.js';
import type { EnqueueInput } from './queue.js';
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


/** Права каталогов payload — те же 0700, что у остального стейта PR (docs/architecture.md §6). */
const DIR_MODE = 0o700;
/** Секретов в payload нет, но и читать его посторонним незачем. */
const FILE_MODE = 0o600;

/** Что билдеру нужно знать о PR: дифф обязателен, шапка — украшение (её отказ маршрут не рушит). */
export interface RoutePayloadContext {
    readonly diff: PrDiff;
    readonly meta: PrMeta | null;
}

/** Контекст задачи маршрута: тот же PR плюс язык, на котором задача просит писать результат. */
export interface RouteTaskContext extends RoutePayloadContext {
    readonly locale: Locale;
    readonly introduction?: string;
    readonly introductionEvidence?: StoryEvidenceBlock | undefined;
    readonly flow?: FlowState | undefined;
    readonly version?: number;
    readonly assignment?: SectionAssignment;
}

export interface RoutePayloadWriterOptions {
    /** Изолированный каталог маршрута; подкаталог на генерацию создаётся здесь. */
    readonly payloadDir: string;
    /** Общий контекст PR: методичка и дифф едут по стабильному пути, а не копией на задачу. */
    readonly shared: SharedPayloadStore;
    readonly budgetBytes?: number;
}

/**
 * Материализация payload задач маршрута на диске. Одна генерация — один подкаталог; новая
 * генерация заводит свой и вычищает прежние, поэтому каталог не растёт без границ.
 */
export class RoutePayloadWriter {
    private readonly payloadDir: string;
    private readonly shared: SharedPayloadStore;
    private readonly budgetBytes: number;
    private generationDir: string | null = null;

    constructor(options: RoutePayloadWriterOptions) {
        this.payloadDir = options.payloadDir;
        this.shared = options.shared;
        this.budgetBytes = options.budgetBytes ?? CONTEXT_BUDGET_BYTES;
    }

    /** Новая генерация получает отдельный каталог; payload отменённых задач удаляется. */
    beginGeneration(): void {
        this.startGeneration();
    }

    /** Задача `route.skeleton`: summary, план стопов и порядок полного тура одним результатом. */
    skeletonTask(context: RouteTaskContext): EnqueueInput {
        // Дифф PR материализуется первым: он открывает сборку общих ключей, срез к ней добавляется.
        const prDiff = this.prDiff(context);
        const locale = context.locale;
        return {
            type: 'route.skeleton',
            priority: 'background',
            instructions: context.version === 6 ? 'Explain the PR, draw its architecture and plan its blocks. Follow the guide and result schema.' : 'Read the guide and PR context. Plan a concise coherent explanation. Return JSON matching the attached schema.',
            // Своего у скелета нет: и методичка, и дифф — общие пути.
            contextFiles: [
                this.shared.guide('skeleton-guide', context.version === 6 ? architectureGuide('overview', locale) : storyGuide('skeleton', locale)),
                prDiff.file,
            ],
            resultSchemaFile: this.writeSchema(context.version === 6 ? 'architectureOverview' : 'overviewSkeleton'),
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
        const name = `section-${planIndexes.map(pad2).join('-')}${context.assignment === undefined ? '' : `-${randomBytes(4).toString('hex')}`}-plan.md`;
        const plan = this.writeFile(name, explanationPlanContext(planIndexes, stops, intents, context));
        const prDiff = this.prDiff(context);
        return {
            type: 'route.section',
            priority: 'background',
            instructions: context.version === 6 ? 'Explain all assigned files in accepted block order. Follow the guide and result schema.' : `Write every assigned section (${planIndexes.join(', ')}) as one coherent concise explanation, continuing the introduction without repeating it. Follow the guide and attached result schema.`,
            contextFiles: [
                this.shared.guide('section-guide', context.version === 6 ? architectureGuide('files', locale) : storyGuide('section', locale, context.version === 5 ? 5 : 4)),
                prDiff.file,
                plan,
            ],
            resultSchemaFile: this.writeSchema(context.version === 6 ? 'allFiles' : context.version === 5 ? 'progressiveSection' : 'readableSection'),
        };
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
    private writeSchema(kind: 'architectureOverview' | 'allFiles' | 'overviewSkeleton' | 'readableSkeleton' | 'readableSection' | 'progressiveSection'): string {
        const key = `${kind}Result`;
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

/** План объяснения не включает триаж, покрытие тестами или поля прежнего ревью. */
function explanationPlanContext(
    planIndexes: readonly number[], stops: readonly ExplanationBlock[],
    intents: ReadonlyMap<number, string>, context: RouteTaskContext,
): string {
    const blocks = stops.filter((stop) => planIndexes.includes(stop.planIndex)).map((stop) => ({
        planIndex: stop.planIndex, title: stop.title, intent: intents.get(stop.planIndex),
        files: stop.guidedFiles?.filter((file) => context.assignment === undefined || context.assignment.files.includes(file.path)), relatedFiles: stop.relatedFiles,
        paragraph: stop.paragraph, nodeIds: stop.nodeIds,
    }));
    return [
        '## Assignment', JSON.stringify(context.assignment ?? null),
        '## Accepted blocks and ordered file assignments', JSON.stringify(blocks),
        '## Already shown introduction', context.introduction ?? '',
        ...(context.flow === undefined ? [] : ['## Accepted architecture', JSON.stringify(context.flow)]),
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
