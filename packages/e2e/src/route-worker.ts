import type { FakeWorker, NextRun, WorkerRun } from '@sherpa/cli/fake-worker';
import type { RouteRawResults } from '@sherpa/fixtures';
import { routeFixtures } from '@sherpa/fixtures';
import { expect } from '@playwright/test';

/**
 * Петля агента для e2e маршрута: сессия-эмулятор ходит бандлом CLI, а сдаёт заготовленные
 * выводы модели из фикстуры `medium` — те же, на которых собран голден-корпус валидатора.
 *
 * Петлю пишет тест, а не `FakeWorker`: `worker next` ждёт задачу без срока, поэтому
 * задача берётся только тогда, когда она заведомо есть.
 */

type RouteSectionResult = RouteRawResults['sections'][number];

export function mediumRawResults(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResults ?? null;
    if (raw === null) {
        throw new Error('у фикстуры medium нет сырых выводов модели');
    }
    return raw;
}

/**
 * Выводы модели для второй итерации `medium`: тот же план из шести стопов, но у трёх затронутых
 * пушем секций есть «why this stop changed», а якоря пересчитаны под новую итерацию.
 */
export function mediumRawResultsV2(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResultsV2 ?? null;
    if (raw === null) {
        throw new Error('у фикстуры medium нет сырых выводов модели второго захода');
    }
    return raw;
}

/** Выводы модели для перф-фикстуры `huge`: 25 стопов на 100 файлов. */
export function hugeRawResults(): RouteRawResults {
    const raw = routeFixtures('huge')?.rawResults ?? null;
    if (raw === null) {
        throw new Error('у фикстуры huge нет сырых выводов модели');
    }
    return raw;
}

/** Сырой текст результата: модель сдаёт файл, а не объект (`route/fixture-support.ts`). */
export function asRawText(result: unknown): string {
    return JSON.stringify(result, null, 2);
}

/** Выданная задача с уже разобранным номером: дальше по петле он нужен без проверок на null. */
export interface RouteTask extends NextRun {
    readonly taskId: number;
}

/** Типы задач, которые сервер ставит сессии в e2e: маршрут и вопрос чата. */
export type TaskType = 'route.skeleton' | 'route.section' | 'chat';

/** Сколько секций маршрута ставит сервер на фикстуре `medium` — по одной на стоп плана. */
export const MEDIUM_SECTION_COUNT = 6;

/** Взять следующую задачу и убедиться, что это задача ожидаемого типа. */
export async function takeTask(worker: FakeWorker, type: TaskType): Promise<RouteTask> {
    const run = await worker.next();
    expect(run.code, `worker next: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.type).toBe(type);
    const taskId = run.taskId;
    if (taskId === null) {
        throw new Error(`worker next не выдал номер задачи:\n${run.stdout}`);
    }
    return { ...run, taskId };
}

/** Результат секции для целевых стопов задачи: номера читаются из её инструкции. */
export function sectionFor(planIndexes: readonly number[]): RouteSectionResult {
    return pickStops(mediumRawResults(), planIndexes);
}

/**
 * То же для второй итерации. Отдельный хелпер, а не параметр `sectionFor`: якоря первого захода
 * на второй итерации валидацию не проходят — перепутать наборы должно быть нельзя.
 */
export function sectionForV2(planIndexes: readonly number[]): RouteSectionResult {
    return pickStops(mediumRawResultsV2(), planIndexes);
}

function pickStops(raw: RouteRawResults, planIndexes: readonly number[]): RouteSectionResult {
    const stops = raw.sections.flatMap((section) => section.stops);
    return {
        stops: planIndexes.map((planIndex) => {
            const stop = stops.find((entry) => entry.planIndex === planIndex);
            if (stop === undefined) {
                throw new Error(`у фикстуры нет секции стопа ${String(planIndex)}`);
            }
            return stop;
        }),
    };
}

/**
 * Сдача результата, которую сервер обязан принять. Отказ валидатора кодом возврата не виден —
 * CLI печатает его в stdout и завершается нулём (отказ штатная часть петли), поэтому проверяется
 * именно текст ответа.
 */
export async function submit(worker: FakeWorker, taskId: number, result: unknown): Promise<WorkerRun> {
    const run = await worker.complete(taskId, asRawText(result));
    expect(run.code, `task complete: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout, 'результат обязан быть принят').not.toContain('was rejected');
    return run;
}

/**
 * Ответ чата сдаётся как есть: у задачи `chat` результат — markdown-текст ответа, а не JSON
 * маршрута (docs/protocol.md §6 — ответ приходит целиком одним `complete`).
 */
export async function answerChat(worker: FakeWorker, taskId: number, answer: string): Promise<WorkerRun> {
    const run = await worker.complete(taskId, answer);
    expect(run.code, `task complete: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout, 'ответ обязан быть принят').not.toContain('was rejected');
    return run;
}

/** Взять и сдать `count` задач заполнения подряд: каждая сдаёт ровно те стопы, которые просит. */
export async function fillSections(worker: FakeWorker, count = MEDIUM_SECTION_COUNT): Promise<void> {
    for (let filled = 0; filled < count; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, sectionFor(task.planIndexes));
    }
}

/**
 * Маршрут целиком: план и все секции фикстуры `medium`. Тестам, которым маршрут нужен готовым,
 * а не по шагам, — F1 разбирает те же шаги вручную, потому что проверяет промежуточные фазы.
 */
export async function buildRoute(worker: FakeWorker): Promise<void> {
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
    await fillSections(worker);
}

/** Стопов в плане перф-фикстуры `huge`: столько же секций поставит сервер (батч секции — 1). */
export const HUGE_SECTION_COUNT = 25;

/**
 * Маршрут перф-фикстуры целиком. Сервер режет заполнение по одному стопу на задачу, поэтому
 * тест ждёт 25 задач подряд — время этого цикла и есть цифра «построение маршрута» в отчёте.
 */
export async function buildHugeRoute(worker: FakeWorker): Promise<void> {
    const raw = hugeRawResults();
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, raw.skeleton);

    const stops = raw.sections.flatMap((section) => section.stops);
    for (let filled = 0; filled < HUGE_SECTION_COUNT; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, {
            stops: task.planIndexes.map((planIndex) => {
                const stop = stops.find((entry) => entry.planIndex === planIndex);
                if (stop === undefined) {
                    throw new Error(`у фикстуры huge нет секции стопа ${String(planIndex)}`);
                }
                return stop;
            }),
        });
    }
}

/** Перестройка после пуша: тот же план, но секции второго захода (F3, force-push). */
export async function buildRouteV2(worker: FakeWorker): Promise<void> {
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResultsV2().skeleton);
    for (let filled = 0; filled < MEDIUM_SECTION_COUNT; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, sectionForV2(task.planIndexes));
    }
}
