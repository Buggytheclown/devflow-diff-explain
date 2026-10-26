import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, PrDiff, PrMeta, Thread } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import type { RegenerationBudgets, RouteTaskContext } from './route-payload.js';
import {
    CONTEXT_BUDGET_BYTES,
    prDiffContext,
    prDiffPayload,
    RoutePayloadWriter,
    sectionPlanContext,
} from './route-payload.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import { indexDiff } from './route/diff-index.js';
import {
    mediumDiff,
    mediumDiffV2,
    mediumInterdiffV1V2,
    mediumRawResults,
    mediumReadySnapshot,
    mediumThreadsV2,
} from './route/fixture-support.js';
import { SharedPayloadStore } from './shared-payload.js';

/**
 * Payload генеративных задач маршрута на фикстурном диффе `medium`: 21 файл, 868
 * изменённые строки, среди них генерённый лок и три тест-файла — ровно те роли, которые
 * различает урезание по бюджету.
 */

const META: PrMeta = {
    id: '4242',
    url: 'https://github.com/quillmart/quillmart/pull/4242',
    title: 'Окно редактирования заказа',
    author: { login: 'alice', displayName: 'Элис Ингрэм', bot: false, avatarUrl: null },
    fromBranch: 'users/alice/edit-window',
    toBranch: 'trunk',
    state: 'open',
    statusLabel: 'Ожидает ревью',
    checks: null,
    updatedAt: '2026-08-20T10:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: false, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'bob', displayName: null, bot: false, avatarUrl: null },
};

/** Контекст билдера: фикстурный дифф плюс шапка PR; язык генерации по умолчанию русский. */
function context(diff: PrDiff = mediumDiff(), locale: Locale = 'ru'): RouteTaskContext {
    return { diff, meta: META, locale };
}

/** Замыслы стопов из сырого скелета фикстуры — то же, что отдаёт `RouteStore.stopIntents`. */
function intents(): Map<number, string> {
    return new Map(mediumRawResults().skeleton.stops.map((stop, index) => [index + 1, stop.intent]));
}

/** Полный размер контекста без урезания — точка отсчёта для тестов бюджета. */
function fullSize(): number {
    return Buffer.byteLength(prDiffContext(context(), CONTEXT_BUDGET_BYTES), 'utf8');
}

/** Строка патча с гаттером: `old new | line`. */
const GUTTER = /^ *(\d+|\.) +(\d+|\.) \| (.*)$/gm;
/** Строки патча вне ханка: номеров у них нет и быть не должно. */
const OUTSIDE_HUNK = /^(diff --git |index |--- |\+\+\+ |@@ |new file |deleted file |similarity |rename |\\ |$)/;

/** Тела напечатанных патчей по путям файлов; урезанные блоки сюда не попадают. */
function printedPatches(text: string): Map<string, string> {
    const blocks = new Map<string, string>();
    let current: string | null = null;
    let body: string[] = [];
    const remember = (): void => {
        const printed = body.join('\n').trim();
        if (current !== null && printed.startsWith('```')) {
            blocks.set(current, printed);
        }
    };

    for (const line of text.split('\n')) {
        const header = /^### File \d+\. `([^`]+)` /.exec(line);
        if (header === null) {
            body.push(line);
            continue;
        }
        remember();
        current = header[1] ?? '';
        body = [];
    }
    remember();
    return blocks;
}

function omittedPaths(text: string): string[] {
    return [...text.matchAll(/^### File \d+\. `([^`]+)` .*\n\npatch omitted/gm)].map((match) => match[1] ?? '');
}

describe('общий контекст диффа', () => {
    it('шапка PR, полный список файлов и все патчи целиком', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES);

        expect(text).toContain('- Title: Окно редактирования заказа');
        expect(text).toContain('- Author: alice (Элис Ингрэм)');
        expect(text).toContain('- Branches: users/alice/edit-window -> trunk');
        expect(text).toContain(`- Diff: base ${diff.baseCommit} -> head ${diff.headCommit}`);
        expect(text).toContain('- Volume: 21 files, +812 / -56 lines');

        for (const file of diff.files) {
            expect(text).toContain(`\`${file.path}\``);
            for (const line of (file.patch ?? '').split('\n')) {
                // Патч печатается построчно с гаттером номеров, поэтому целиком он не ищется.
                expect(text).toContain(`| ${line}`);
            }
        }
        expect(omittedPaths(text)).toEqual([]);
    });

    it('патч печатается с номерами строк обеих сторон — теми же, что принимает валидатор', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES);
        const index = indexDiff(diff);

        expect(text).toContain('`old new | line`');

        // Напечатанные в гаттере номера изменённых строк обязаны совпасть с тем, что валидатор
        // считает изменённой строкой файла: разъезд здесь убивает якоря модели на приёмке.
        let checked = 0;
        for (const [filePath, body] of printedPatches(text)) {
            const printed = { old: new Set<number>(), new: new Set<number>() };
            for (const [, oldCell = '', newCell = '', raw = ''] of body.matchAll(GUTTER)) {
                if (oldCell === '.' && newCell === '.') {
                    expect(raw, `${filePath}: строка без номеров обязана быть вне ханка`).toMatch(OUTSIDE_HUNK);
                    continue;
                }
                const prefix = raw.slice(0, 1);
                if (prefix === '+') {
                    expect(oldCell, `${filePath}: у добавленной строки нет старого номера`).toBe('.');
                    printed.new.add(Number(newCell));
                } else if (prefix === '-') {
                    expect(newCell, `${filePath}: у удалённой строки нет нового номера`).toBe('.');
                    printed.old.add(Number(oldCell));
                }
            }

            const expected = index.get(filePath);
            expect(expected, `${filePath} нет в индексе диффа`).toBeDefined();
            expect([...printed.old].sort()).toEqual([...(expected?.old ?? [])].sort());
            expect([...printed.new].sort()).toEqual([...(expected?.new ?? [])].sort());
            checked += 1;
        }
        expect(checked).toBe(diff.files.filter((file) => file.patch !== null).length);
    });

    it('без шапки PR контекст остаётся собранным: хост её мог не отдать', () => {
        const text = prDiffContext({ diff: mediumDiff(), meta: null }, CONTEXT_BUDGET_BYTES);

        expect(text).toContain('no pull request metadata');
        expect(text).toContain('- Volume: 21 files');
        expect(omittedPaths(text)).toEqual([]);
    });

    it('урезание по бюджету: файл влезает, список файлов остаётся полным', () => {
        const budget = 12_000;
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), budget);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omittedPaths(text).length).toBeGreaterThan(0);
        // Правило покрытия требует знать все файлы: список не режется никогда.
        for (const file of diff.files) {
            expect(text).toContain(`| \`${file.path}\` |`);
        }
    });

    it('пометка урезания называет файл, объём и обязанность его разложить', () => {
        const text = prDiffContext(context(), 12_000);
        const lock = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');

        expect(omittedPaths(text)).toContain('pnpm-lock.yaml');
        expect(text).toContain(
            `patch omitted — ${String((lock?.additions ?? 0) + (lock?.deletions ?? 0))} lines, ` +
                'use the stats above; the file still must be placed',
        );
    });

    it('первым режется генерённое: команда не требует его ревью', () => {
        // Бюджет на байт меньше полного контекста — режется ровно один, самый крупный генерённый файл.
        const text = prDiffContext(context(), fullSize() - 1);

        expect(omittedPaths(text)).toEqual(['pnpm-lock.yaml']);
    });

    it('дальше режется самый большой патч: меньше потерянных файлов на тот же бюджет', () => {
        const diff = mediumDiff();
        const generated = diff.files.filter((file) => file.generated).map((file) => file.path);
        // Ужимаем бюджет по байту, пока генерённое не срезано целиком: следующим уходит крупнейший.
        let text = prDiffContext(context(diff), fullSize() - 1);
        while (omittedPaths(text).length <= generated.length) {
            text = prDiffContext(context(diff), Buffer.byteLength(text, 'utf8') - 1);
        }

        const omitted = omittedPaths(text);
        expect(omitted).toEqual(expect.arrayContaining(generated));
        // Тесты защищены, поэтому крупнейший из оставшихся — документация окна редактирования.
        expect(omitted).toContain('services/orders/docs/edit-window.md');
        expect(omitted).toHaveLength(generated.length + 1);
    });

    it('бюджет ниже неурезаемой части: патчей не остаётся, список файлов на месте', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), 10);

        // У двоичных файлов патча нет вовсе — им и урезать нечего.
        expect(omittedPaths(text)).toHaveLength(diff.files.filter((file) => file.patch !== null).length);
        expect(text).toContain('| `pnpm-lock.yaml` |');
    });
});

describe('план задачи секции', () => {
    const stops = mediumReadySnapshot().stops;

    it('план целиком, целевые стопы выделены, замыслы на месте', () => {
        const text = sectionPlanContext([3], stops, intents());

        expect(text).toContain('# Route plan (fixed by the server)');
        for (const stop of stops) {
            expect(text).toContain(stop.title);
        }
        expect(text).toContain('| 3 | medium |');
        expect(text).toContain('**your target**');
        expect(text).toContain(`### Stop 3 — medium — ${stops[2]?.title ?? ''}`);
        // Замысел целевого стопа — цитатой, замыслы соседей — строкой списка (для связок).
        expect(text).toContain(`> ${intents().get(3) ?? ''}`);
        expect(text).toContain(`- stop 1 (high) ${stops[0]?.title ?? ''} — ${intents().get(1) ?? ''}`);
        // «Прочее» синтезирует сервер: заполнять его модели нечем.
        expect(text).toContain('synthetic, filled by the server');
    });

    it('диффа в плане нет: он общий и лежит по своему пути', () => {
        const text = sectionPlanContext([3], stops, intents());

        expect(text).not.toContain('## Patches');
        expect(text).not.toContain('| file # | file | change | +/- | notes |');
        expect(text).not.toMatch(/^ *(\d+|\.) +(\d+|\.) \| /m);
        for (const file of mediumDiff().files) {
            expect(text).not.toContain(`\`${file.path}\``);
        }
    });

    it('батч из нескольких стопов: цели все, соседи — остальные', () => {
        const text = sectionPlanContext([1, 2], stops, intents());

        expect(text).toContain('### Stop 1 —');
        expect(text).toContain('### Stop 2 —');
        expect(text).not.toContain('### Stop 3 —');
        expect(text).toContain(`- stop 3 (medium) ${stops[2]?.title ?? ''}`);
    });

    it('номер стопа печатается числом схемы, а не двузначным номером файла', () => {
        const plan = sectionPlanContext([3], stops, intents());

        // `planIndex` — z.number(): «03» в JSON модели схема не примет.
        expect(plan).not.toMatch(/^\| 0\d \|/m);
        expect(plan).not.toMatch(/### Stop 0\d /);
        expect(plan).toContain('`"planIndex": 3`');
        // Двузначная нумерация осталась только у файлов, и колонки названы по-разному.
        expect(plan).toContain('| stop # | tier | title | |');
        expect(prDiffContext(context(), CONTEXT_BUDGET_BYTES)).toContain('| file # | file | change | +/- | notes |');
    });
});

describe('одна политика урезания общего диффа', () => {
    it('тест-файлы режутся последними: дайджесту нужны их строки для якорей', () => {
        // Бюджета хватает на неурезаемую часть и тесты, но не на весь дифф.
        const budget = 20_000;
        const text = prDiffContext(context(), budget);
        const omitted = omittedPaths(text);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omitted.length).toBeGreaterThan(0);
        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
    });

    it('защита теста сильнее пометки «генерённое»: снапшот-тест переживает обычный файл', () => {
        // Хост честно метит снапшот генерённым, но дайджесту нужны его строки для testPath/testLine.
        const diff = mediumDiff();
        const generatedTest = diff.files.map((file) =>
            file.path.includes('__tests__') ? { ...file, generated: true } : file,
        );
        const marked = { ...diff, files: generatedTest };
        const budget = Buffer.byteLength(prDiffContext(context(marked), 1e9), 'utf8') - 1;

        const omitted = omittedPaths(prDiffContext(context(marked), budget));

        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
        expect(omitted).toEqual(['pnpm-lock.yaml']);
    });
});

describe('кап генерации', () => {
    it('весь дифф влез — покрыто всё, урезания не было', () => {
        const cap = prDiffPayload(context(), CONTEXT_BUDGET_BYTES).cap;

        expect(cap.filesTotal).toBe(mediumDiff().files.length);
        expect(cap.filesCovered).toBe(cap.filesTotal);
        expect(cap.machineFiles).toBe(0);
        expect(cap.truncated).toBe(false);
    });

    it('выброшен только машинный файл — он в счёте машинных, урезания не было', () => {
        // Первым кандидатом на урезание идёт генерённый лок: бюджета не хватает ровно на него.
        const budget = fullSize() - 1;
        const cap = prDiffPayload(context(), budget).cap;

        expect(omittedPaths(prDiffContext(context(), budget))).toEqual(['pnpm-lock.yaml']);
        expect(cap.filesCovered).toBe(cap.filesTotal - 1);
        expect(cap.machineFiles).toBe(1);
        expect(cap.truncated).toBe(false);
    });

    it('под обрезку попал не машинный файл — план строился по неполному диффу', () => {
        const budget = 20_000;
        const cap = prDiffPayload(context(), budget).cap;
        const omitted = omittedPaths(prDiffContext(context(), budget));

        expect(cap.filesCovered).toBe(cap.filesTotal - omitted.length);
        expect(cap.machineFiles).toBeLessThan(omitted.length);
        expect(cap.truncated).toBe(true);
    });
});

describe('запись payload на диск', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-payload-'));
        payloadDir = path.join(root, 'payload', 'route');
        sharedDir = path.join(root, 'payload', 'shared');
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    function writer(budgetBytes?: number): RoutePayloadWriter {
        const shared = new SharedPayloadStore(sharedDir, () => []);
        return new RoutePayloadWriter({
            payloadDir,
            shared,
            ...(budgetBytes === undefined ? {} : { budgetBytes }),
        });
    }

    it('задача скелета: методичка и дифф — общие пути, схема — своя', () => {
        const input = writer().skeletonTask(context());

        expect(input.type).toBe('route.skeleton');
        expect(input.priority).toBe('background');
        expect(input.contextFiles).toHaveLength(2);
        for (const file of input.contextFiles) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
        }

        const [guide, pr] = input.contextFiles;
        expect(guide).toMatch(/shared[/\\]guides[/\\]skeleton-guide-[0-9a-f]{8}\.md$/);
        expect(pr?.startsWith(sharedDir)).toBe(true);
        expect(path.basename(pr ?? '')).toBe('pr-diff.md');
        expect(fs.readFileSync(guide ?? '', 'utf8')).toContain('# Task: plan the review route');
        expect(fs.readFileSync(pr ?? '', 'utf8')).toContain('## Changed files (21, complete list)');
        expect(input.instructions).toContain('Plan the review route');
        // Своего у скелета нет: каталог генерации держит только схему результата.
        expect(fs.readdirSync(path.dirname(input.resultSchemaFile ?? ''))).toEqual([
            'route-skeleton-result.schema.json',
        ]);
    });

    it('схема результата — тот же JSON, что отдаёт generateJsonSchemas', () => {
        const builder = writer();
        const skeleton = builder.skeletonTask(context());
        const sections = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        const schemas = generateJsonSchemas();
        const readSchema = (file: string | undefined): unknown => JSON.parse(fs.readFileSync(file ?? '', 'utf8'));
        expect(readSchema(skeleton.resultSchemaFile)).toEqual(schemas.routeSkeletonResult);
        expect(readSchema(sections.resultSchemaFile)).toEqual(schemas.routeSectionResult);
    });

    it('задача секции: целевые номера в инструкции, план — свой файл без патчей', () => {
        const input = writer().sectionTask(context(), [3, 4], mediumReadySnapshot().stops, intents());

        expect(input.type).toBe('route.section');
        expect(input.instructions).toContain('3, 4');
        expect(input.contextFiles).toHaveLength(3);
        const plan = input.contextFiles[2] ?? '';
        expect(plan.startsWith(payloadDir)).toBe(true);
        expect(path.basename(plan)).toBe('section-03-04-plan.md');
        const text = fs.readFileSync(plan, 'utf8');
        expect(text).toContain('# Route plan');
        expect(text).not.toContain('## Patches');
    });

    it('скелет и секции читают один и тот же общий дифф', () => {
        const builder = writer();
        const skeleton = builder.skeletonTask(context());
        const first = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        const second = builder.sectionTask(context(), [2], mediumReadySnapshot().stops, intents());

        expect(first.contextFiles[1]).toBe(skeleton.contextFiles[1]);
        expect(second.contextFiles[1]).toBe(skeleton.contextFiles[1]);
        expect(first.contextFiles[0]).toBe(second.contextFiles[0]);
        expect(fs.readdirSync(path.dirname(skeleton.contextFiles[1] ?? ''))).toEqual(['patches', 'pr-diff.md', 'saved-patch-index.json']);
    });

    it('контекст на диске урезан по бюджету билдера', () => {
        const input = writer(12_000).skeletonTask(context());
        const text = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12_000);
        expect(text).toContain('patch omitted');
    });

    it('новая генерация вычищает прежний подкаталог, общий дифф остаётся', () => {
        const builder = writer();
        const first = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        builder.beginGeneration();
        const second = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        expect(fs.existsSync(first.contextFiles[2] ?? '')).toBe(false);
        expect(fs.existsSync(second.contextFiles[2] ?? '')).toBe(true);
        expect(fs.existsSync(first.contextFiles[1] ?? '')).toBe(true);
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('новый билдер подхватывает каталог начатой генерации, а не вычищает его', () => {
        // Рестарт сервера: генерация та же, её задачи живы вместе со своими контекстными файлами.
        const before = writer().sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        const after = writer().sectionTask(context(), [2], mediumReadySnapshot().stops, intents());

        expect(fs.existsSync(before.contextFiles[2] ?? '')).toBe(true);
        expect(path.dirname(after.contextFiles[2] ?? '')).toBe(path.dirname(before.contextFiles[2] ?? ''));
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('каталоги payload приватные: та же конвенция, что у остального стейта PR', () => {
        const input = writer().sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        expect(fs.statSync(payloadDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(input.contextFiles[2] ?? '')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(sharedDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(input.contextFiles[1] ?? '')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(input.contextFiles[1] ?? '').mode & 0o777).toBe(0o600);
    });
});

/**
 * Контекст перегенерации: прошлый маршрут, срез между итерациями и обсуждение с тех пор.
 * Проверяется на паре итераций фикстуры `medium`: пуш трогает `edit-policy.ts` и `handlers.ts`,
 * уносит `card-token.ts` и пересобирает лок.
 */
describe('контекст перегенерации после пуша', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-regen-'));
        payloadDir = path.join(root, 'payload', 'route');
        sharedDir = path.join(root, 'payload', 'shared');
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    function writer(
        budgets?: Partial<RegenerationBudgets>,
        openContextFiles: () => string[] = () => [],
    ): RoutePayloadWriter {
        return new RoutePayloadWriter({
            payloadDir,
            shared: new SharedPayloadStore(sharedDir, openContextFiles),
            ...(budgets === undefined ? {} : { regenerationBudgets: budgets }),
        });
    }

    function map(): IterationMap {
        return buildIterationMap({
            interdiff: mediumInterdiffV1V2(),
            fromBaseCommit: mediumDiff().baseCommit,
            toBaseCommit: mediumDiffV2().baseCommit,
        });
    }

    function regeneration(overrides: Partial<RouteRegenerationContext> = {}): RouteRegenerationContext {
        return {
            previous: mediumReadySnapshot(),
            interdiff: mediumInterdiffV1V2(),
            map: map(),
            threads: mediumThreadsV2(),
            ...overrides,
        };
    }

    /** Контекст задачи второй итерации: дифф уже новый, перегенерация — от прошлого снапшота. */
    function contextV2(overrides: Partial<RouteRegenerationContext> = {}): RouteTaskContext {
        return { diff: mediumDiffV2(), meta: META, locale: 'ru', regeneration: regeneration(overrides) };
    }

    function read(file: string | undefined): string {
        return fs.readFileSync(file ?? '', 'utf8');
    }

    it('скелет и секция несут срез, прошлый маршрут и обсуждение — в этом порядке', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const skeleton = builder.skeletonTask(contextV2());
        const section = builder.sectionTask(contextV2(), [2], mediumReadySnapshot().stops, intents());

        expect(skeleton.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(skeleton.contextFiles[0] ?? ''),
            'pr-diff.md',
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
        expect(section.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(section.contextFiles[0] ?? ''),
            'pr-diff.md',
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
            'section-02-plan.md',
        ]);
        // Инструкция перечисляет контекст по факту: без прошлого маршрута этих строк в ней нет.
        expect(skeleton.instructions).toContain('previous-route.md');
        expect(section.instructions).toContain('threads-since.md');
    });

    it('без прошлого снапшота задачи собираются как при первой генерации', () => {
        const builder = writer();
        builder.beginGeneration();
        const skeleton = builder.skeletonTask({ diff: mediumDiffV2(), meta: META, locale: 'ru' });

        expect(skeleton.contextFiles).toHaveLength(2);
        expect(skeleton.instructions).not.toContain('previous-route.md');
        expect(fs.existsSync(path.join(sharedDir, 'diff', interdiffKey(), 'interdiff.md'))).toBe(false);
    });

    it('срез лежит под ключом голов итераций и печатается тем же гаттером, что дифф', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const interdiff = builder.skeletonTask(contextV2()).contextFiles[2] ?? '';

        expect(interdiff).toBe(path.join(sharedDir, 'diff', interdiffKey(), 'interdiff.md'));
        const text = read(interdiff);
        expect(text).toContain(
            `# Interdiff ${mediumDiff().headCommit.slice(0, 7)} -> ${mediumDiffV2().headCommit.slice(0, 7)}`,
        );
        expect(text).toContain('`old new | line`');
        expect(text).toContain('services/orders/src/api/handlers.ts');
        // Файлы, которых пуш не касался, в срез не входят: это не дифф PR.
        expect(text).not.toContain('services/orders/src/domain/edit-window.ts');
    });

    it('шапка патчей среза запрещает брать оттуда якоря, шапка диффа PR — наоборот', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const files = builder.skeletonTask(contextV2()).contextFiles;
        const prDiff = read(files[1]);
        const interdiff = read(files[2]);

        expect(prDiff).toContain('## Patches\n');
        expect(prDiff).toContain('Line anchors of a stop are validated against exactly these printed numbers');
        // Старая сторона среза — голова прошлой итерации, а не база PR: обещать по ней валидацию нельзя.
        expect(interdiff).toContain('## Patches of the push');
        expect(interdiff).toContain('Never take line anchors from here.');
        expect(interdiff).not.toContain('are validated against exactly these printed numbers');
    });

    it('прошлый маршрут: шапка, выжимка, таблица стопов с якорями и пометкой «затронут»', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const text = read(builder.skeletonTask(contextV2()).contextFiles[3]);
        const previous = mediumReadySnapshot();

        expect(text).toContain(`- Built for commit: ${previous.commit}`);
        expect(text).toContain(previous.summary.split('\n')[0] ?? '');
        expect(text).toContain('| stop # | tier | title | anchors | touched by the push |');
        expect(text).toContain('`services/orders/src/api/handlers.ts`:new:');
        // Стоп 03 живёт на `handlers.ts` — его пуш задел; стоп 01 на `edit-window.ts` — нет.
        expect(tableRow(text, 3)).toContain('| yes |');
        expect(tableRow(text, 1)).toContain('| no |');
        expect(text).toContain(`### Stop 1 — ${previous.stops[0]?.tier ?? ''}`);
    });

    it('прошлый маршрут под бюджетом: абзацы уходят с конца, таблица и выжимка остаются', () => {
        const builder = writer({ previousRoute: 9000 });
        builder.beginGeneration(regeneration());
        const text = read(builder.skeletonTask(contextV2()).contextFiles[3]);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(9000);
        expect(text).toContain('## Summary of the previous route');
        // Таблица уходит последней: она и есть план, который надо сохранить.
        expect(tableRow(text, 6)).not.toBe('');
        expect(text).toContain('### Stop 1 —');
        expect(text).not.toContain('### Stop 6 —');
        expect(text).toContain('the remaining stop texts of the previous route were omitted');
    });

    it('обсуждение: новый ответ на старом треде едет, чужое и старое — нет', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: filterCases() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        // Ответ автора после пуша на треде затронутого файла.
        expect(text).toContain('[thread:4820242]');
        expect(text).toContain('(new)');
        // Тред уровня PR берётся независимо от файлов.
        expect(text).toContain('[thread:-38211]');
        // Черновик — не комментарий обсуждения: тред с одним лишь черновиком не едет,
        // хотя его файл пуш и унёс. Тред на нетронутом файле не едет тоже.
        expect(text).not.toContain('[thread:4820260]');
        expect(text).not.toContain('[thread:4820113]');
        // Старый тред без новых комментариев тоже не едет.
        expect(text).not.toContain('[thread:4820109]');
    });

    it('обсуждение под бюджетом: свежие треды остаются, старые уходят с пометкой', () => {
        const builder = writer({ threadsSince: 1200 });
        builder.beginGeneration(regeneration({ threads: filterCases() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1200);
        expect(text).toContain('[thread:4820242]');
        expect(text).toContain('older thread(s) omitted by the payload budget');
    });

    it('нет подходящих тредов — файл с честной строкой, а не ветвление инструкции', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: [] }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('No new comments since the previous route.');
    });

    it('хост не отдал треды — генерация идёт, файл говорит об этом прямо', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: null }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('[UNAVAILABLE: the host did not give the discussion of this pull request.]');
    });

    it('без среза интердиффа задача несёт прошлый маршрут и обсуждение, но не срез', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ interdiff: null, map: null }));
        const files = builder.skeletonTask(contextV2({ interdiff: null, map: null })).contextFiles;

        expect(files.map((file) => path.basename(file))).toEqual([
            path.basename(files[0] ?? ''),
            'pr-diff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
    });

    it('без среза прошлый маршрут не рассказывает про пуш и не печатает колонку «затронут»', () => {
        const builder = writer();
        const same = regeneration({ interdiff: null, map: identityMap() });
        builder.beginGeneration(same);
        const files = builder.skeletonTask(contextV2({ interdiff: null, map: identityMap() })).contextFiles;
        const previous = read(files[2]);
        const threads = read(files[3]);

        expect(previous).toContain('The code has not moved since it was built');
        expect(previous).toContain('| stop # | tier | title | anchors |');
        // Колонки «затронут пушем» нет: сплошное «no» читалось бы как «не трогай ничего».
        expect(previous).not.toContain('touched by the push');
        expect(previous).not.toContain('| no |');
        expect(threads).toContain('The code has not moved');
        expect(threads).not.toContain('the push');
        expect(same.interdiff).toBeNull();
    });

    it('черновики ревьюера в обсуждение не печатаются: автор их не видел', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: withDraftReply() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('[thread:4820242]');
        expect(text).not.toContain('черновик ревьюера, автор его не видел');
    });

    it('рестарт сервера: новый билдер подхватывает файлы начатой генерации', () => {
        const before = writer();
        before.beginGeneration(regeneration());
        before.skeletonTask(contextV2());

        // Контекст генерации умер вместе с процессом: срез восстановлен из кэша, тредов нет.
        const after = writer().sectionTask(
            { diff: mediumDiffV2(), meta: META, locale: 'ru', regeneration: regeneration({ threads: null }) },
            [2],
            mediumReadySnapshot().stops,
            intents(),
        );

        expect(after.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(after.contextFiles[0] ?? ''),
            'pr-diff.md',
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
            'section-02-plan.md',
        ]);
        // Файл обсуждения остался тем, что написала живая генерация: заново он не собирается.
        expect(read(after.contextFiles[4])).toContain('[thread:4820242]');
    });

    it('чистка общего каталога щадит и дифф итерации, и срез этой же сборки', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const skeleton = builder.skeletonTask(contextV2());

        expect(fs.existsSync(skeleton.contextFiles[1] ?? '')).toBe(true);
        expect(fs.existsSync(skeleton.contextFiles[2] ?? '')).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff')).sort()).toEqual(
            [diffKey(mediumDiffV2()), interdiffKey()].sort(),
        );
    });

    function diffKey(diff: PrDiff): string {
        return `${diff.baseCommit}-${diff.headCommit}`;
    }

    /** Ключ среза — пара голов итераций: база у них общая. */
    function interdiffKey(): string {
        return `${mediumDiff().headCommit}-${mediumDiffV2().headCommit}`;
    }

    /** Строка таблицы прошлого маршрута по плановому номеру стопа. */
    function tableRow(text: string, planIndex: number): string {
        return text.split('\n').find((line) => line.startsWith(`| ${String(planIndex)} | `)) ?? '';
    }

    /** Тред, прошедший фильтр, с неотправленным черновиком ревьюера в ответах. */
    function withDraftReply(): Thread[] {
        return mediumThreadsV2().map((thread) =>
            thread.id === '4820242'
                ? {
                      ...thread,
                      root: {
                          ...thread.root,
                          replies: [
                              ...thread.root.replies,
                              {
                                  ...thread.root,
                                  id: 'draft-2',
                                  draft: true,
                                  createdAt: '2026-08-21T10:58:00.000Z',
                                  body: 'черновик ревьюера, автор его не видел',
                                  replies: [],
                              },
                          ],
                      },
                  }
                : thread,
        );
    }

    /**
     * Треды под фильтр «что нового»: ответ автора после пуша на затронутом файле (фикстурный
     * 4820242), свежий комментарий на файле, которого пуш не касался, свежий черновик на файле,
     * который пуш унёс, и свежий тред уровня PR.
     */
    function filterCases(): Thread[] {
        const after = '2026-08-21T10:58:00.000Z';
        return mediumThreadsV2().map((thread) => {
            if (thread.anchor === null || thread.anchor.path === 'services/orders/src/domain/edit-window.ts') {
                return { ...thread, root: { ...thread.root, createdAt: after } };
            }
            if (thread.id === '4820260') {
                return {
                    ...thread,
                    root: {
                        ...thread.root,
                        replies: [
                            { ...thread.root, id: 'draft-1', draft: true, createdAt: after, replies: [] },
                        ],
                    },
                };
            }
            return thread;
        });
    }
});

it('large documentation under specs does not displace implementation as if it were a test', () => {
    const base = mediumDiff(); const template = base.files.find((file) => file.patch !== null);
    if (template === undefined) throw new Error('Missing patch fixture');
    const diff: PrDiff = { ...base, files: [
        { ...template, fileId: 'doc', path: 'notes/specs/design.md', patch: `@@ -0,0 +1 @@\n+DOCUMENT_MARKER${'x'.repeat(40_000)}\n`, additions: 1, deletions: 0, generated: false },
        { ...template, fileId: 'impl', path: 'src/service.ts', patch: '@@ -0,0 +1 @@\n+IMPLEMENTATION_MARKER\n', additions: 1, deletions: 0, generated: false },
        { ...template, fileId: 'test', path: 'src/service.test.ts', patch: '@@ -0,0 +1 @@\n+TEST_MARKER\n', additions: 1, deletions: 0, generated: false },
    ] };
    const result = prDiffPayload({ diff, meta: null }, 4_000);
    expect(result.content).toContain('IMPLEMENTATION_MARKER');
    expect(result.content).toContain('TEST_MARKER');
    expect(result.content).not.toContain('DOCUMENT_MARKER');
    expect(result.cap.filesCovered).toBe(2);
});
