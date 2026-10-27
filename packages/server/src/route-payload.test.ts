import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, PrDiff, PrMeta } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RouteTaskContext } from './route-payload.js';
import {
    CONTEXT_BUDGET_BYTES,
    prDiffContext,
    prDiffPayload,
    RoutePayloadWriter,
} from './route-payload.js';
import { indexDiff } from './route/diff-index.js';
import {
    mediumDiff,
    mediumRawResults,
    mediumReadySnapshot,
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
        expect(fs.readFileSync(guide ?? '', 'utf8')).toContain('PR');
        expect(fs.readFileSync(pr ?? '', 'utf8')).toContain('## Changed files (21, complete list)');
        expect(input.instructions).toContain('Plan a concise coherent explanation');
        // Своего у скелета нет: каталог генерации держит только схему результата.
        expect(fs.readdirSync(path.dirname(input.resultSchemaFile ?? ''))).toEqual([
            'route-readableSkeleton-result.schema.json',
        ]);
    });

    it('схема результата — тот же JSON, что отдаёт generateJsonSchemas', () => {
        const builder = writer();
        const skeleton = builder.skeletonTask(context());
        const sections = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        const schemas = generateJsonSchemas();
        const readSchema = (file: string | undefined): unknown => JSON.parse(fs.readFileSync(file ?? '', 'utf8'));
        expect(readSchema(skeleton.resultSchemaFile)).toEqual(schemas.readableSkeletonResult);
        expect(readSchema(sections.resultSchemaFile)).toEqual(schemas.readableSectionResult);
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
        expect(text).toContain('## Accepted blocks and ordered file assignments');
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
