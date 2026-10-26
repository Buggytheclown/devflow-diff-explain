import type { Page } from '@playwright/test';

import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Холодная прокрутка большого PR: карточки разбираются воркером прямо под рукой ревьюера, и
 * приход модели меняет высоту уже отрисованной карточки. Метрика прыжка — смещение якоря
 * (верхняя видимая карточка) относительно вьюпорта за несколько кадров БЕЗ ввода: пока
 * ревьюер не трогает колесо, картинка обязана стоять на месте. Вторая метрика — наползание
 * соседних карточек: слот виртуализатора, разошедшийся с реальной высотой, портит вёрстку и
 * тогда, когда якорь при этом устоял.
 *
 * Прогрев (как в `performance.spec.ts`) здесь запрещён: он и есть то состояние, в котором
 * баг не воспроизводится. Каждое направление идёт по свежей загрузке — иначе проход вниз
 * прогрел бы список для прохода вверх.
 */

/** Смещение якоря, которое ещё не считается прыжком: субпиксельная арифметика rect. */
const JUMP_TOLERANCE_PX = 1;
/** Кадров наблюдения после шага прокрутки: за это время воркер успевает отдать модели. */
const SETTLE_FRAMES = 8;
/** Шаг прокрутки — примерно одна карточка фикстуры: так каждый шаг вводит свежую холодную. */
const STEP_PX = 900;
/** docs/design/README.md «Interactions»: цель прыжка маршрута встаёт на −150px от кромки контейнера. */
const ROUTE_JUMP_OFFSET_PX = 150;

interface WalkReport {
    readonly steps: number;
    readonly lost: number;
    readonly jumps: number;
    readonly worst: number;
    readonly total: number;
    readonly sample: readonly { readonly index: number; readonly drift: number }[];
    readonly overlaps: number;
    readonly worstOverlap: number;
}

test('fixture-large не прыгает при холодной прокрутке полного диффа', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');

    await openFullDiff(page, server.url);
    const down = await walk(page, 'down');

    // Свежая загрузка: проход вверх обязан встретить неразобранные карточки, приходящие сверху.
    await openFullDiff(page, server.url);
    const up = await walk(page, 'up');

    for (const [direction, report] of [
        ['вниз', down],
        ['вверх', up],
    ] as const) {
        const description = `${direction}: steps=${String(report.steps)}, jumps=${String(report.jumps)}, worst=${report.worst.toFixed(1)}px, total=${report.total.toFixed(1)}px, lost=${String(report.lost)}, overlaps=${String(report.overlaps)}/${report.worstOverlap.toFixed(1)}px`;
        test.info().annotations.push({ type: 'scroll-stability', description });
        console.log(`SCROLL fixture-large ${description}`);
        if (report.sample.length > 0) {
            console.log(`SCROLL sample ${direction}: ${JSON.stringify(report.sample)}`);
        }
    }

    expect(down.steps).toBeGreaterThan(20);
    expect(up.steps).toBeGreaterThan(20);
    expect(down.lost).toBe(0);
    expect(up.lost).toBe(0);
    expect(down.jumps).toBe(0);
    expect(up.jumps).toBe(0);
    // Слот виртуализатора совпал с реальной высотой карточки: разъехавшись, они дают наползание
    // соседей — тот же промах оценки, что и прыжок, только видимый как испорченная вёрстка.
    expect(down.overlaps).toBe(0);
    expect(up.overlaps).toBe(0);
});

/**
 * Перемер уже показанных карточек: смена режима переставляет высоты всех, кто на экране и в
 * запасе строк за краем окна. Карточки выше сгиба обязаны компенсироваться независимо от того, куда ревьюер
 * прокручивал последним, — иначе видимый текст уезжает ровно в момент нажатия тумблера.
 */
for (const gesture of ['вверх', 'вниз'] as const) {
    test(`смена режима после прокрутки ${gesture} не двигает видимый текст`, async ({ page, launchSherpa }) => {
        const server = await launchSherpa('fixture-large');
        await openFullDiff(page, server.url);

        const report = await page.locator('.full-diff').evaluate(
            async (scroller, options) => {
                const nextFrame = (): Promise<void> =>
                    new Promise<void>((resolve) => {
                        requestAnimationFrame(() => {
                            resolve();
                        });
                    });
                const listTop = (): number => {
                    const toolbarBottom = document
                        .querySelector<HTMLElement>('.full-diff__toolbar')
                        ?.getBoundingClientRect().bottom;
                    return Math.max(scroller.getBoundingClientRect().top, toolbarBottom ?? 0);
                };
                const anchor = (): { index: number; offset: number } | null => {
                    const top = listTop();
                    for (const item of document.querySelectorAll<HTMLElement>('.diff-list__item')) {
                        const rect = item.getBoundingClientRect();
                        if (rect.bottom > top + 1) {
                            return { index: Number(item.dataset.index), offset: rect.top - top };
                        }
                    }
                    return null;
                };
                const offsetOf = (index: number): number | null => {
                    const item = document.querySelector<HTMLElement>(
                        `.diff-list__item[data-index="${String(index)}"]`,
                    );
                    return item === null ? null : item.getBoundingClientRect().top - listTop();
                };

                // Середина списка с разобранными карточками: перемер должен случиться на
                // измеренных высотах, а не на первой встрече с файлом.
                scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
                for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
                    await nextFrame();
                }
                for (let frame = 0; frame < 20; frame += 1) {
                    await nextFrame();
                }

                // Последний жест задаёт `scrollDirection`, от которого зависело умолчание
                // библиотеки; тумблер нажимается сразу за ним, пока направление не сброшено.
                scroller.scrollTop += options.gesture === 'вниз' ? 150 : -150;
                await nextFrame();
                const start = anchor();
                const before = document.querySelector('.diff-mode-toggle')?.textContent.trim() ?? '';
                document.querySelector<HTMLElement>('.diff-mode-toggle')?.click();

                let drift = 0;
                let lost = 0;
                for (let frame = 0; frame < options.settleFrames; frame += 1) {
                    await nextFrame();
                    const now = start === null ? null : offsetOf(start.index);
                    if (now === null || start === null) {
                        lost += 1;
                        break;
                    }
                    drift = Math.max(drift, Math.abs(now - start.offset));
                }

                return {
                    drift: Number(drift.toFixed(1)),
                    lost,
                    before,
                    after: document.querySelector('.diff-mode-toggle')?.textContent.trim() ?? '',
                };
            },
            { gesture, settleFrames: 20 },
        );

        const description = `жест ${gesture}: drift=${report.drift.toFixed(1)}px, lost=${String(report.lost)}, «${report.before}» → «${report.after}»`;
        test.info().annotations.push({ type: 'scroll-stability', description });
        console.log(`MODE fixture-large ${description}`);

        // Режим действительно переключился — иначе мерили бы неподвижный список.
        expect(report.after).toBe('бок о бок');
        expect(report.lost).toBe(0);
        expect(report.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    });
}

test('композер строки в середине большого диффа открывается и закрывается без прыжка', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const anchor = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 12; frame += 1) {
            await nextFrame();
        }
        const toolbarBottom = document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        const row = [...document.querySelectorAll<HTMLElement>('.diff-row[tabindex="0"]')].find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.top >= toolbarBottom + 1 && rect.bottom <= window.innerHeight - 1;
        });
        const item = row?.closest<HTMLElement>('.diff-list__item') ?? null;
        if (row === undefined || item === null) {
            throw new Error('Не нашлась видимая фокусируемая строка в середине fixture-large');
        }
        row.focus();
        return {
            index: Number(item.dataset.index),
            offset: item.getBoundingClientRect().top - toolbarBottom,
        };
    });

    await page.keyboard.press('c');
    await expect(page.locator('.diff-line-composer')).toBeVisible();
    const openedDrift = await observeItemDrift(page, anchor);

    await page.locator('.diff-line-composer').getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(page.locator('.diff-line-composer')).toHaveCount(0);
    const closedDrift = await observeItemDrift(page, anchor);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `line composer: open=${openedDrift.toFixed(1)}px, close=${closedDrift.toFixed(1)}px`,
    });
    expect(openedDrift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(closedDrift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('тред у строки раскрывается и сворачивается без прыжка', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    // Раскрытие меняет высоту ряда посреди длинного диффа — сам ряд обязан остаться на месте.
    const anchor = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const settle = async (): Promise<void> => {
            for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
                await nextFrame();
            }
            for (let frame = 0; frame < 12; frame += 1) {
                await nextFrame();
            }
        };
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        /** Запас от липкой шапки карточки: под ней маркер виден, но кликать по нему нечестно. */
        const HEADER_RESERVE = 80;
        const visibleMarker = (): HTMLElement | null =>
            [...document.querySelectorAll<HTMLElement>('.thread-marker')].find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.top >= toolbarBottom() + HEADER_RESERVE && rect.bottom <= window.innerHeight - 1;
            }) ?? null;

        // Треды в fixture-large лежат на своих файлах: идём экранами вниз, пока маркер не покажется.
        let marker = visibleMarker();
        for (let screen = 0; screen < 40 && marker === null; screen += 1) {
            const bottom = scroller.scrollHeight - scroller.clientHeight;
            if (scroller.scrollTop >= bottom) {
                break;
            }
            scroller.scrollTop = Math.min(scroller.scrollTop + Math.round(scroller.clientHeight * 0.8), bottom);
            await settle();
            marker = visibleMarker();
        }
        const row = marker?.closest<HTMLElement>('.diff-row') ?? null;
        const item = marker?.closest<HTMLElement>('.diff-list__item') ?? null;
        if (row === null || item === null) {
            throw new Error('Не нашлась видимая строка с маркером треда в полном диффе fixture-large');
        }
        return {
            index: Number(item.dataset.index),
            key: row.dataset.key ?? '',
            offset: row.getBoundingClientRect().top - toolbarBottom(),
        };
    });

    const marker = page.locator(`${rowSelector(anchor)} .thread-marker`);
    const openBefore = (await marker.getAttribute('aria-expanded')) === 'true';

    await marker.click();
    await expect(marker).toHaveAttribute('aria-expanded', String(!openBefore));
    const toggled = await observeRowDrift(page, anchor);

    await marker.click();
    await expect(marker).toHaveAttribute('aria-expanded', String(openBefore));
    const restored = await observeRowDrift(page, anchor);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `thread marker: toggle=${toggled.drift.toFixed(1)}px/${toggled.overlap.toFixed(1)}px, back=${restored.drift.toFixed(1)}px/${restored.overlap.toFixed(1)}px`,
    });
    // Ряд стоит на месте, а слот виртуализатора успевает за новой высотой карточки.
    expect(toggled.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(restored.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(toggled.overlap).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(restored.overlap).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

interface RowAnchor {
    readonly index: number;
    readonly key: string;
    readonly offset: number;
}

/** Ряд опознаётся парой «слот виртуализатора + ключ строки»: ключи строк уникальны только внутри карточки. */
function rowSelector(anchor: RowAnchor): string {
    return `.diff-list__item[data-index="${String(anchor.index)}"] .diff-row[data-key="${anchor.key}"]`;
}

/** Смещение якорного ряда и наползание соседних карточек за 20 кадров после переключения треда. */
async function observeRowDrift(page: Page, anchor: RowAnchor): Promise<{ drift: number; overlap: number }> {
    return page.locator('.full-diff').evaluate(
        async (_scroller, target: RowAnchor): Promise<{ drift: number; overlap: number }> => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                        resolve();
                    });
                });
            const selector = `.diff-list__item[data-index="${String(target.index)}"] .diff-row[data-key="${target.key}"]`;
            const overlap = (): number => {
                const rendered = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
                    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
                );
                let worst = 0;
                for (let i = 1; i < rendered.length; i += 1) {
                    const previous = rendered[i - 1];
                    const current = rendered[i];
                    if (
                        previous === undefined ||
                        current === undefined ||
                        Number(current.dataset.index) !== Number(previous.dataset.index) + 1
                    ) {
                        continue;
                    }
                    worst = Math.max(
                        worst,
                        previous.getBoundingClientRect().bottom - current.getBoundingClientRect().top,
                    );
                }
                return worst;
            };
            let drift = 0;
            let worstOverlap = 0;
            for (let frame = 0; frame < 20; frame += 1) {
                await nextFrame();
                const toolbarBottom =
                    document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
                const row = document.querySelector<HTMLElement>(selector);
                if (row === null) {
                    throw new Error('Якорная строка ушла из DOM при перемере треда');
                }
                drift = Math.max(drift, Math.abs(row.getBoundingClientRect().top - toolbarBottom - target.offset));
                worstOverlap = Math.max(worstOverlap, overlap());
            }
            return { drift: Number(drift.toFixed(1)), overlap: Number(worstOverlap.toFixed(1)) };
        },
        anchor,
    );
}

async function observeItemDrift(
    page: Page,
    anchor: { readonly index: number; readonly offset: number },
): Promise<number> {
    return page.locator('.full-diff').evaluate(
        async (_scroller, target) => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                    resolve();
                });
                });
            let worst = 0;
            for (let frame = 0; frame < 20; frame += 1) {
                await nextFrame();
                const toolbarBottom =
                    document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
                const item = document.querySelector<HTMLElement>(
                    `.diff-list__item[data-index="${String(target.index)}"]`,
                );
                if (item === null) {
                    throw new Error('Якорная карточка ушла из DOM при перемере композера');
                }
                worst = Math.max(worst, Math.abs(item.getBoundingClientRect().top - toolbarBottom - target.offset));
            }
            return Number(worst.toFixed(1));
        },
        anchor,
    );
}

async function openFullDiff(page: Page, url: string): Promise<void> {
    // Через `about:blank`: переход на тот же адрес отличался бы только фрагментом, и вкладка
    // осталась бы жить дальше — со всеми уже разобранными и измеренными карточками.
    await page.goto('about:blank');
    await page.goto(url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    await expect(page.locator('.diff-list')).toBeVisible();
    await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '64');
    await expect(page.locator('.diff-list')).toHaveAttribute('data-collapsed-files', '15');
    await expect(page.locator('.diff-list')).toHaveAttribute('data-generated-collapsed-files', '8');
    // Доезжающие IBM Plex меняют высоты всех карточек разом — иначе меряли бы чужой эффект.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

function walk(page: Page, direction: 'down' | 'up'): Promise<WalkReport> {
    return page.locator('.full-diff').evaluate(
        async (scroller, options): Promise<WalkReport> => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                        resolve();
                    });
                });
            const listTop = (): number => {
                const toolbarBottom = document
                    .querySelector<HTMLElement>('.full-diff__toolbar')
                    ?.getBoundingClientRect().bottom;
                return Math.max(scroller.getBoundingClientRect().top, toolbarBottom ?? 0);
            };

            /** Верхняя видимая карточка и её смещение от нижней кромки липкого тулбара. */
            const anchor = (): { index: number; offset: number } | null => {
                const top = listTop();
                for (const item of document.querySelectorAll<HTMLElement>('.diff-list__item')) {
                    const rect = item.getBoundingClientRect();
                    if (rect.bottom > top + 1) {
                        return { index: Number(item.dataset.index), offset: rect.top - top };
                    }
                }
                return null;
            };
            const offsetOf = (index: number): number | null => {
                const item = document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(index)}"]`);
                return item === null ? null : item.getBoundingClientRect().top - listTop();
            };

            /**
             * Самое сильное наползание соседних карточек. Карточка занимает свой слот целиком
             * (зазор до следующей — её же padding), поэтому у улёгшегося списка низ одной ровно
             * совпадает с верхом следующей; всё, что ниже, — высота, на которую слот не рассчитан.
             */
            const overlap = (): number => {
                const rendered = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
                    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
                );
                let worst = 0;
                for (let i = 1; i < rendered.length; i += 1) {
                    const previous = rendered[i - 1];
                    const current = rendered[i];
                    if (previous === undefined || current === undefined) {
                        continue;
                    }
                    if (Number(current.dataset.index) !== Number(previous.dataset.index) + 1) {
                        continue;
                    }
                    worst = Math.max(
                        worst,
                        previous.getBoundingClientRect().bottom - current.getBoundingClientRect().top,
                    );
                }
                return worst;
            };

            const jumps: { index: number; drift: number }[] = [];
            let steps = 0;
            let lost = 0;
            let overlaps = 0;
            let worstOverlap = 0;

            scroller.scrollTop = options.direction === 'down' ? 0 : scroller.scrollHeight;
            await nextFrame();

            for (let guard = 0; guard < 400; guard += 1) {
                const maxScroll = scroller.scrollHeight - scroller.clientHeight;
                const from = scroller.scrollTop;
                const to =
                    options.direction === 'down'
                        ? Math.min(from + options.step, maxScroll)
                        : Math.max(from - options.step, 0);
                scroller.scrollTop = to;
                await nextFrame();
                steps += 1;

                const start = anchor();
                if (start !== null) {
                    let drift = 0;
                    for (let frame = 0; frame < options.settleFrames; frame += 1) {
                        await nextFrame();
                        const now = offsetOf(start.index);
                        if (now === null) {
                            lost += 1;
                            break;
                        }
                        drift = Math.max(drift, Math.abs(now - start.offset));
                    }
                    if (drift > options.tolerance) {
                        jumps.push({ index: start.index, drift: Number(drift.toFixed(1)) });
                    }
                }

                // Замер идёт после окна ожидания: кадр между приходом модели и перемером слота
                // наползание допускает по устройству виртуализации, а вот пережить его — нет.
                const excess = overlap();
                if (excess > options.tolerance) {
                    overlaps += 1;
                    worstOverlap = Math.max(worstOverlap, excess);
                }

                if (options.direction === 'down' ? to >= maxScroll : to <= 0) {
                    break;
                }
            }

            const drifts = jumps.map((jump) => jump.drift);
            return {
                steps,
                lost,
                jumps: jumps.length,
                worst: drifts.length === 0 ? 0 : Math.max(...drifts),
                total: drifts.reduce((sum, value) => sum + value, 0),
                sample: jumps.slice(0, 10),
                overlaps,
                worstOverlap: Number(worstOverlap.toFixed(1)),
            };
        },
        { direction, step: STEP_PX, settleFrames: SETTLE_FRAMES, tolerance: JUMP_TOLERANCE_PX },
    );
}

/**
 * «Прокрутка следует за сворачиванием»: отметка файла, который
 * ревьюер сейчас читает, уводит экран к следующему файлу; отметка последнего и снятие отметки
 * экран не двигают.
 */
test('отметка верхнего файла ведёт экран к следующему', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const start = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;

        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 20; frame += 1) {
            await nextFrame();
        }

        // Высокая развёрнутая карточка: ревьюер дочитал её до середины и жмёт тогл в липкой шапке.
        const item = [...document.querySelectorAll<HTMLElement>('.diff-list__item')]
            .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
            .find(
                (candidate) =>
                    candidate.querySelector('.file-card__collapsed--file') === null &&
                    candidate.getBoundingClientRect().height > 500,
            );
        if (item === undefined) {
            throw new Error('в середине fixture-large нужна высокая развёрнутая карточка');
        }
        const index = Number(item.dataset.index);
        scroller.scrollTop += item.getBoundingClientRect().top - toolbarBottom() + 200;
        for (let frame = 0; frame < 12; frame += 1) {
            await nextFrame();
        }
        return { index, scrollTop: scroller.scrollTop };
    });

    await page
        .locator(`.diff-list__item[data-index="${String(start.index)}"] .file-card__viewed`)
        .click();

    const after = await page.locator('.full-diff').evaluate(async (scroller, marked) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 40; frame += 1) {
            await nextFrame();
        }
        const toolbarBottom =
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        const items = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
            (left, right) => Number(left.dataset.index) - Number(right.dataset.index),
        );
        const top = items.find((candidate) => candidate.getBoundingClientRect().bottom > toolbarBottom + 1);
        if (top === undefined) {
            throw new Error('после отметки на экране не осталось ни одной карточки');
        }
        const markedItem = items.find((candidate) => Number(candidate.dataset.index) === marked);
        return {
            topIndex: Number(top.dataset.index),
            offset: Number((top.getBoundingClientRect().top - toolbarBottom).toFixed(1)),
            scrollTop: scroller.scrollTop,
            markedCollapsed: markedItem?.querySelector('.file-card__collapsed--file') !== null,
        };
    }, start.index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `advance: ${String(start.index)} → ${String(after.topIndex)}, offset=${after.offset.toFixed(1)}px`,
    });

    expect(after.markedCollapsed).toBe(true);
    // Экран ушёл с отмеченного файла на следующий — и встал шапкой ровно под липкий тулбар
    // (`scrollPaddingStart` = его высота). Сам `scrollTop` при этом уменьшается: свернувшаяся
    // карточка подтянула следующую к себе сильнее, чем ревьюер успел в неё вчитаться.
    expect(after.topIndex).toBeGreaterThan(start.index);
    expect(Math.abs(after.offset)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('отметка последнего файла и снятие отметки экран не двигают', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    // Последний файл фикстуры — generated: по умолчанию он и прочитан, и свёрнут. Разворачиваем
    // его и снимаем отметку, чтобы отметка шла ровно с последнего файла списка и с чистого листа.
    const index = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = scroller.scrollHeight;
        for (let frame = 0; frame < 60; frame += 1) {
            await nextFrame();
        }
        const index = Math.max(
            ...[...document.querySelectorAll<HTMLElement>('.diff-list__item')].map((item) =>
                Number(item.dataset.index),
            ),
        );
        document
            .querySelector<HTMLElement>(`.diff-list__item[data-index="${String(index)}"]`)
            ?.querySelector<HTMLElement>('.file-card__collapsed--file')
            ?.click();
        for (let frame = 0; frame < 30; frame += 1) {
            await nextFrame();
        }
        return index;
    });

    const toggle = page.locator(`.diff-list__item[data-index="${String(index)}"] .file-card__viewed`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }

    const before = await placeUnderToolbar(page, index);
    await toggle.click();
    const marked = await settleScroll(page, index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `last file: scrollTop ${before.scrollTop.toFixed(1)} → ${marked.scrollTop.toFixed(1)}, высота ${before.height.toFixed(1)} → ${marked.height.toFixed(1)}`,
    });

    expect(marked.collapsed).toBe(true);
    // Вперёд экран не уезжает: следующего файла нет, перехода не заказывали. Назад — только на
    // столько, на сколько ужался сам документ: свернувшаяся карточка была последней.
    expect(marked.scrollTop).toBeLessThanOrEqual(before.scrollTop + JUMP_TOLERANCE_PX);
    expect(before.scrollTop - marked.scrollTop).toBeLessThanOrEqual(
        before.height - marked.height + JUMP_TOLERANCE_PX,
    );

    await toggle.click();
    const restored = await settleScroll(page, index);
    expect(restored.collapsed).toBe(false);
    // Снятие отметки прокрутку не заказывает: карточка растёт вниз, документ над ней не двигается.
    expect(Math.abs(restored.scrollTop - marked.scrollTop)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

/**
 * Ставит карточку под липкий тулбар и отдаёт положение, от которого меряется прыжок. `depth` —
 * насколько ревьюер уже вчитался: на столько шапка уходит под тулбар, оставаясь липкой.
 */
function placeUnderToolbar(
    page: Page,
    index: number,
    depth = 0,
): Promise<{ scrollTop: number; height: number }> {
    return page.locator('.full-diff').evaluate(async (scroller, { target, depth }) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const itemOf = (): HTMLElement | null =>
            document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(target)}"]`);
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const item = itemOf();
            if (item === null) {
                throw new Error('карточка ушла из DOM до отметки');
            }
            scroller.scrollTop += item.getBoundingClientRect().top - toolbarBottom() + depth;
            for (let frame = 0; frame < 12; frame += 1) {
                await nextFrame();
            }
        }
        const item = itemOf();
        if (item === null) {
            throw new Error('карточка ушла из DOM до отметки');
        }
        return { scrollTop: scroller.scrollTop, height: item.getBoundingClientRect().height };
    }, { target: index, depth });
}

/** Позиция и свёртка карточки после того, как перемеры улеглись; `offset` — от кромки тулбара. */
function settleScroll(
    page: Page,
    index: number,
): Promise<{ scrollTop: number; height: number; collapsed: boolean; offset: number }> {
    return page.locator('.full-diff').evaluate(async (scroller, target) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 40; frame += 1) {
            await nextFrame();
        }
        const item = document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(target)}"]`);
        if (item === null) {
            throw new Error('карточка ушла из DOM после отметки');
        }
        const toolbarBottom =
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        return {
            scrollTop: scroller.scrollTop,
            height: item.getBoundingClientRect().height,
            collapsed: item.querySelector('.file-card__collapsed--file') !== null,
            offset: item.getBoundingClientRect().top - toolbarBottom,
        };
    }, index);
}

/**
 * Свёртка по чужой отметке (соседняя вкладка, перечитка прогресса, покрытие от остановок) —
 * не заказанный вью переход, а перемер под рукой ревьюера: экран обязан остаться на карточке,
 * которую он читает. Причина свёртки при этом `viewed`, и якорь списка не должен смотреть на неё.
 */
test('чужая отметка сворачивает читаемую карточку, не двигая её шапку', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const target = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 20; frame += 1) {
            await nextFrame();
        }
        const item = [...document.querySelectorAll<HTMLElement>('.diff-list__item')]
            .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
            .find(
                (candidate) =>
                    candidate.querySelector('.file-card__collapsed--file') === null &&
                    candidate.getBoundingClientRect().height > 500,
            );
        const fileId = item?.querySelector<HTMLElement>('.file-card[data-file]')?.dataset.file;
        if (item === undefined || fileId === undefined) {
            throw new Error('в середине fixture-large нужна высокая развёрнутая карточка');
        }
        return { index: Number(item.dataset.index), fileId };
    });

    // Ревьюер дочитал карточку до середины: её шапка липнет к тулбару, а верх уже уехал вверх —
    // ровно та геометрия, в которой свёртка без якоря утаскивает всё, что ниже.
    const before = await placeUnderToolbar(page, target.index, 400);

    // Отметка приходит мимо вью — как из соседней вкладки; в эту вкладку она вернётся по SSE.
    const token = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('t') ?? '');
    const response = await page.request.post(new URL('/api/ui/review/file-viewed', server.url).toString(), {
        headers: { authorization: `Bearer ${token}` },
        data: { fileId: target.fileId, viewed: true },
    });
    expect(response.ok()).toBe(true);

    const item = `.diff-list__item[data-index="${String(target.index)}"]`;
    await expect(page.locator(`${item} .file-card__collapsed--file`)).toHaveCount(1);
    const after = await settleScroll(page, target.index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `foreign viewed: offset=${after.offset.toFixed(1)}px, высота ${before.height.toFixed(1)} → ${after.height.toFixed(1)}`,
    });

    expect(after.collapsed).toBe(true);
    // Карточка схлопнулась под курсором — её шапка осталась под липким тулбаром.
    expect(Math.abs(after.offset)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('маршрут: отметка остановки ставит следующую на −150px от кромки контейнера', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const sectionIndex of raw.sections.keys()) {
        const task = await takeTask(server.worker, 'route.section');
        expect(task.planIndexes, `секция ${String(sectionIndex + 1)}`).toHaveLength(1);
        await submit(server.worker, task.taskId, sectionFor(task.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    await page.locator('[data-stop="s01"] .route-stop__viewed').click();

    // Прыжок длится ~320ms и доводится ещё раз после settle: меряем, когда всё улеглось.
    const geometry = await page.locator('.route').evaluate(async (container) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 90; frame += 1) {
            await nextFrame();
        }
        const section = container.querySelector<HTMLElement>('[data-stop="s02"]');
        if (section === null) {
            throw new Error('в маршруте фикстуры нет остановки s02');
        }
        return {
            offset: Number((section.getBoundingClientRect().top - container.getBoundingClientRect().top).toFixed(1)),
            scrollTop: container.scrollTop,
            maxScroll: container.scrollHeight - container.clientHeight,
        };
    });

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `route jump: s02 offset=${geometry.offset.toFixed(1)}px, scrollTop=${geometry.scrollTop.toFixed(1)}/${geometry.maxScroll.toFixed(1)}`,
    });

    expect(Math.abs(geometry.offset - ROUTE_JUMP_OFFSET_PX)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});
