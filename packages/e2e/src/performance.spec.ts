import type { Locator, Page } from '@playwright/test';
import {
    HUGE_CHANGED_LINE_COUNT,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
} from '@sherpa/fixtures';

import { buildHugeRoute } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const AVERAGE_BUDGET_MS = 16.7;
const P95_BUDGET_MS = 33;
const SCROLL_STEP_PX = 300;

/**
 * Бюджет `docs/testing.md` §5 на `fixture-huge` держится за счёт того, что колонка диффа
 * далёкой остановки уходит с DOM: маршрут держит те же интервалы кадров, что и
 * виртуализированный полный дифф.
 * Проверяются интервалы между rAF, а не «работа кадра»: наша синхронная доля и до оптимизаций
 * была 0,08 мс — в бюджет не укладывалась именно браузерная раскладка с отрисовкой.
 */
// Тип расширен до boolean намеренно: иначе литерал сузился бы до `true` и линтер счёл бы
// саму проверку лишней — а выключать бюджет на разбирательстве всё ещё должно быть одной правкой.
const HUGE_BUDGET_ENFORCED = true as boolean;

/**
 * Потолок DOM-узлов маршрута после прохода по всем 25 остановкам. Замер — 30 433 узла
 * (до размонтирования колонок было 149 086), порог = замер × 1.3 с округлением: он ловит возврат
 * к «весь маршрут в DOM», а не колебания в пару карточек.
 */
const HUGE_ROUTE_DOM_BUDGET = 40_000;

test('fixture-large держит бюджет времени кадра при скролле полного диффа', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Все 64', exact: true })).toBeVisible();
    await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '64');
    await expect(page.locator('.diff-list')).toBeVisible();

    const parsedFiles = await warmParsedFiles(page.locator('.full-diff'));
    expect(parsedFiles).toBe(64);

    const metrics = await scrollFrames(page.locator('.full-diff'));

    const description = `avg=${metrics.average.toFixed(2)} ms/frame, p95=${metrics.p95.toFixed(2)} ms/frame, frames=${String(metrics.frames)}`;
    test.info().annotations.push({ type: 'performance', description });
    console.log(`PERF fixture-large: ${description}`);

    expect(metrics.frames).toBeGreaterThan(20);
    expect(metrics.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
    expect(metrics.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
});

test('fixture-huge: полный дифф — первый кадр, парсинг воркером и фреймтайм скролла', async ({
    page,
    launchSherpa,
}) => {
    // Сто файлов и 25 000 строк: прогрев сам по себе занимает минуты, общих 120 с не хватает.
    test.setTimeout(600_000);
    const server = await launchSherpa('fixture-huge');
    const scroller = page.locator('.full-diff');

    // Вью в адресе, а не кликом по табу: иначе во «время до первого кадра» попала бы задержка клика.
    await page.goto(`${server.url}&view=diff`);
    await expect(scroller).toHaveAttribute('data-shown-files', String(HUGE_FILE_COUNT));
    await expect(page.locator('.diff-list')).toBeVisible();

    // (а) от navigationStart до первой карточки, отрисовавшей строки.
    const firstFrameMs = await firstDiffFrame(page);
    const heapBefore = await usedHeapMb(page);

    // (в) холодный скролл: карточки разбираются воркером прямо под рукой, прогрева нет.
    const cold = await scrollFrames(scroller);

    // Прогрев считает смонтированные карточки — все 100, включая свёрнутые по причине.
    const parsedFiles = await warmParsedFiles(scroller);
    expect(parsedFiles).toBe(HUGE_FILE_COUNT);

    // (б) парсинг: замеры круга «запрос в воркер → ответ», поставленные `diff/client.ts`.
    const parse = await parseMeasures(page);
    // (г) тёплый скролл: тот же метод, что и на `fixture-large`.
    const warm = await scrollFrames(scroller);

    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const heapAfter = await usedHeapMb(page);

    // Файл выше порога свёртки открывается свёрнутым (docs/design/SPEC-elements.md §2.13) — он в фикстуре ровно один.
    await scroller.evaluate((element) => {
        element.scrollTop = 0;
    });
    await expect(page.locator('.file-card__collapsed')).toHaveCount(1);
    await expect(page.locator('.file-card__collapsed')).toContainText('открыть файл');

    const lines = [
        `measured load=${String(HUGE_PARSED_FILE_COUNT)}/${String(HUGE_FILE_COUNT)} files, ` +
            `${String(HUGE_PARSED_LINE_COUNT)}/${String(HUGE_CHANGED_LINE_COUNT)} changed lines ` +
            `(свёрнутые viewed/generated разбор не заказывают)`,
        `first-diff-frame=${firstFrameMs.toFixed(0)} ms`,
        `parse total=${parse.total.toFixed(0)} ms, avg=${parse.average.toFixed(2)}, p95=${parse.p95.toFixed(2)}, max=${parse.max.toFixed(2)}, n=${String(parse.count)}`,
        frameLine('cold scroll', cold),
        frameLine('warm scroll', warm),
        `dom nodes=${String(domNodes)}`,
        `heap=${heapBefore ?? 'n/a'} → ${heapAfter ?? 'n/a'} MB`,
        budgetVerdict(warm),
    ];
    report('fixture-huge diff', lines);

    expect(cold.frames).toBeGreaterThan(20);
    expect(warm.frames).toBeGreaterThan(20);
    expect(parse.count).toBe(HUGE_PARSED_FILE_COUNT);
    if (HUGE_BUDGET_ENFORCED) {
        expectWithinBudget(cold);
        expectWithinBudget(warm);
    }
});

test('fixture-huge: маршрут на 25 стопах — построение и фреймтайм скролла', async ({ page, launchSherpa }) => {
    test.setTimeout(600_000);
    const server = await launchSherpa('fixture-huge');
    const scroller = page.locator('main.route');

    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();

    const startedAt = Date.now();
    await buildHugeRoute(server.worker);
    // 25 стопов плана плюс синтетическое «Прочее».
    await expect(page.locator('[data-stop]')).toHaveCount(26, { timeout: 60_000 });
    const buildMs = Date.now() - startedAt;

    // (д) холодный скролл маршрута: карточки монтируются по мере появления на экране.
    const cold = await scrollFrames(scroller);
    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const warm = await scrollFrames(scroller);
    const heap = await usedHeapMb(page);

    report('fixture-huge route', [
        `build=${(buildMs / 1000).toFixed(1)} s (25 секций через бандл CLI)`,
        frameLine('cold scroll', cold),
        frameLine('warm scroll', warm),
        `dom nodes after full pass=${String(domNodes)}`,
        `heap=${heap ?? 'n/a'} MB`,
        budgetVerdict(warm),
    ]);

    expect(cold.frames).toBeGreaterThan(5);
    expect(warm.frames).toBeGreaterThan(5);
    if (HUGE_BUDGET_ENFORCED) {
        expectWithinBudget(cold);
        expectWithinBudget(warm);
        expect(domNodes).toBeLessThanOrEqual(HUGE_ROUTE_DOM_BUDGET);
    }
});

/** Бюджет `docs/testing.md` §5 на один проход прокрутки: и интервалы между кадрами, и наша работа в кадре. */
function expectWithinBudget(metrics: FrameMetrics): void {
    expect(metrics.intervalAverage).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
    expect(metrics.intervalP95).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(metrics.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
    expect(metrics.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
}

interface FrameMetrics {
    readonly average: number;
    readonly p95: number;
    readonly max: number;
    readonly frames: number;
    /** Интервал между соседними rAF: сюда попадает и то, что браузер доделал после нашего кадра. */
    readonly intervalAverage: number;
    readonly intervalP95: number;
    readonly intervalMax: number;
    readonly elapsedMs: number;
    /** Проход упёрся в потолок кадров, а не в конец документа: числа неполные. */
    readonly capped: boolean;
}

/**
 * Стоимость работы кадра при прокрутке: `performance.now()` вокруг присвоения `scrollTop` и
 * принудительного layout. Это именно работа кадра, а не интервал между vsync — интервал на
 * headless-машине меряет расписание браузера, а не наш код.
 *
 * Рядом собирается второй ряд — интервалы между соседними rAF. На холодном списке первый ряд
 * почти нулевой: разбор и монтаж карточек происходят после нашего кадра и в измеряемое окно
 * не попадают, а в интервал попадают.
 */
function scrollFrames(scroller: Locator): Promise<FrameMetrics> {
    return scroller.evaluate(async (element, step): Promise<FrameMetrics> => {
        const frameCap = 5000;
        const samples: number[] = [];
        const intervals: number[] = [];
        element.scrollTop = 0;
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                resolve();
            });
        });

        const startedPass = performance.now();
        let capped = false;
        await new Promise<void>((resolve) => {
            let previousFrameAt: number | null = null;
            const frame = (): void => {
                const startedAt = performance.now();
                if (previousFrameAt !== null) {
                    intervals.push(startedAt - previousFrameAt);
                }
                previousFrameAt = startedAt;

                // Граница живая: высота документа растёт по мере отрисовки карточек, и снимок
                // границы обрывал бы проход на середине — конфигурации мерили бы разный объём
                // работы. От бесконечного роста страхует потолок кадров.
                const maxScroll = element.scrollHeight - element.clientHeight;
                element.scrollTop = Math.min(element.scrollTop + step, maxScroll);
                element.getBoundingClientRect();
                samples.push(performance.now() - startedAt);

                if (element.scrollTop >= maxScroll) {
                    resolve();
                    return;
                }
                if (samples.length >= frameCap) {
                    capped = true;
                    resolve();
                    return;
                }
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });

        const stats = (values: readonly number[]): { average: number; p95: number; max: number } => {
            const sorted = [...values].sort((left, right) => left - right);
            const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
            return {
                average: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
                p95: sorted[p95Index] ?? Number.POSITIVE_INFINITY,
                max: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
            };
        };
        const work = stats(samples);
        const interval = stats(intervals);
        return {
            average: work.average,
            p95: work.p95,
            max: work.max,
            frames: samples.length,
            intervalAverage: interval.average,
            intervalP95: interval.p95,
            intervalMax: interval.max,
            elapsedMs: performance.now() - startedPass,
            capped,
        };
    }, SCROLL_STEP_PX);
}

function frameLine(label: string, metrics: FrameMetrics): string {
    return (
        `${label} avg=${metrics.average.toFixed(2)}, p95=${metrics.p95.toFixed(2)}, max=${metrics.max.toFixed(2)}, ` +
        `frames=${String(metrics.frames)}; rAF-интервал avg=${metrics.intervalAverage.toFixed(2)}, ` +
        `p95=${metrics.intervalP95.toFixed(2)}, max=${metrics.intervalMax.toFixed(2)}; проход=${(metrics.elapsedMs / 1000).toFixed(1)} s` +
        (metrics.capped ? ' (упёрся в потолок кадров)' : '')
    );
}

interface ParseMetrics {
    readonly total: number;
    readonly average: number;
    readonly p95: number;
    readonly max: number;
    readonly count: number;
}

/** Замеры `devflow-diff-explain:diff-parse`: по одному на файл, дошедший до воркера (попадания в кэш не мерятся). */
function parseMeasures(page: Page): Promise<ParseMetrics> {
    return page.evaluate((): ParseMetrics => {
        const durations = performance
            .getEntriesByName('devflow-diff-explain:diff-parse', 'measure')
            .map((entry) => entry.duration)
            .sort((left, right) => left - right);
        const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
        const total = durations.reduce((sum, duration) => sum + duration, 0);
        return {
            total,
            average: durations.length === 0 ? 0 : total / durations.length,
            p95: durations[p95Index] ?? 0,
            max: durations.at(-1) ?? 0,
            count: durations.length,
        };
    });
}

/** Момент, когда первая карточка отрисовала строки; отсчёт — от `navigationStart`. */
async function firstDiffFrame(page: Page): Promise<number> {
    await expect
        .poll(() => page.evaluate(() => performance.getEntriesByName('devflow-diff-explain:first-diff-frame').length), {
            timeout: 60_000,
        })
        .toBeGreaterThan(0);
    return page.evaluate(() => performance.getEntriesByName('devflow-diff-explain:first-diff-frame')[0]?.startTime ?? 0);
}

/** `performance.memory` есть не во всех сборках Chromium; без него метрика — `n/a`. */
function usedHeapMb(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
        return memory === undefined ? null : (memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    });
}

function budgetVerdict(metrics: FrameMetrics): string {
    const within = metrics.intervalAverage <= AVERAGE_BUDGET_MS && metrics.intervalP95 <= P95_BUDGET_MS;
    return `${within ? 'within budget' : 'over budget'} (rAF-интервал avg ≤ ${String(AVERAGE_BUDGET_MS)} ms, p95 ≤ ${String(P95_BUDGET_MS)} ms)`;
}

function report(label: string, lines: readonly string[]): void {
    for (const line of lines) {
        test.info().annotations.push({ type: 'performance', description: `${label}: ${line}` });
        console.log(`PERF ${label}: ${line}`);
    }
}

async function warmParsedFiles(scroller: Locator): Promise<number> {
    return scroller.evaluate(async (element) => {
        const seen = new Set<string>();
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const waitForVisibleModels = async (): Promise<void> => {
            for (let attempt = 0; attempt < 240; attempt += 1) {
                document.querySelectorAll<HTMLElement>('.file-card[data-file]').forEach((card) => {
                    const parseError = Array.from(card.querySelectorAll<HTMLElement>('.file-card__notice')).find(
                        (notice) => notice.textContent.trimStart().startsWith('дифф не разобрался'),
                    );
                    if (parseError !== undefined) {
                        const fileId = card.dataset.file ?? 'неизвестный fileId';
                        const path = card.querySelector<HTMLElement>('.file-card__path')?.title;
                        throw new Error(
                            `Карточка ${path ?? fileId} (${fileId}) завершилась ошибкой парсера: ${parseError.textContent.trim()}`,
                        );
                    }

                    const fileId = card.dataset.file;
                    if (fileId !== undefined) {
                        seen.add(fileId);
                    }
                });
                if (document.querySelector('.file-card__loading') === null) {
                    return;
                }
                await nextFrame();
            }
            throw new Error('Видимые карточки не разобрались за 240 кадров');
        };

        const stride = Math.max(200, Math.floor(element.clientHeight / 2));
        let top = 0;
        while (top < element.scrollHeight - element.clientHeight) {
            element.scrollTop = top;
            await nextFrame();
            await waitForVisibleModels();
            top += stride;
        }
        element.scrollTop = element.scrollHeight;
        await nextFrame();
        await waitForVisibleModels();
        element.scrollTop = 0;
        await nextFrame();
        return seen.size;
    });
}
