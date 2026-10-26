// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { DraftBufferEntry, PublishResult, Thread, UiSettings, Verdict } from '@sherpa/protocol';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { ThreadPinProvider } from '../iterations/thread-pin.tsx';
import { countDraftComments } from '../progress/summary.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { usePrCommentsGate } from './pr-comments-gate.js';
import type { RouteProgress } from './review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
} from './review-action-bar.tsx';
import { ReviewComplete } from './review-complete.tsx';

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const DRAFT_THREADS = withDraft(DATA.threads);
const BUFFERED: DraftBufferEntry = {
    id: 'ck-1',
    draft: { body: 'подождёт связи', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'Арканум: 502',
    attempts: 1,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
};

const TRANSPORT = {
    save: () => Promise.reject(new Error('не вызывается при статическом рендере')),
    update: () => Promise.reject(new Error('не вызывается при статическом рендере')),
    delete: () => Promise.reject(new Error('не вызывается при статическом рендере')),
};

function renderBar(
    options: {
        menu?: boolean;
        threads?: typeof DRAFT_THREADS;
        /** Режимы публикации PR; по умолчанию — как у фикстуры. */
        verdicts?: readonly Verdict[];
        route?: RouteProgress | null;
        /** Активная итерация PR: пометка про черновики прошлых коммитов считается от неё. */
        activeDiffId?: string;
        draftBuffer?: readonly DraftBufferEntry[];
        reviewHost?: string;
        /** Сохранённый режим сплит-кнопки. */
        shipMode?: UiSettings['shipMode'];
    } = {},
): string {
    const threads = options.threads ?? DRAFT_THREADS;
    const settings = createUiSettingsStore({ loaded: true, initial: { shipMode: options.shipMode ?? 'ship' } });
    return renderToStaticMarkup(
        <SettingsProvider store={settings}>
        <ThreadPinProvider
            value={{
                activeDiffId: options.activeDiffId ?? null,
                viewingDiffId: options.activeDiffId ?? null,
                openAtPin: null,
            }}
        >
        <ReviewActionBar
            pr={{
                ...DATA.pr,
                capabilities: {
                    ...DATA.pr.capabilities,
                    publishVerdicts: [...(options.verdicts ?? DATA.pr.capabilities.publishVerdicts)],
                },
            }}
            diff={DATA.diff}
            diffStore={createDiffViewStore({ files: DATA.diff.files })}
            threadStore={createThreadStore(threads, FILE_IDS)}
            connection="online"
            hostName="FixtureHost"
            reviewHost={options.reviewHost ?? 'fixture'}
            composerTransport={TRANSPORT}
            {...(options.draftBuffer === undefined ? {} : { draftBuffer: options.draftBuffer })}
            onPublish={() => Promise.reject(new Error('не вызывается при статическом рендере'))}
            onComplete={() => undefined}
            route={options.route ?? null}
            {...(options.menu === undefined ? {} : { defaultMenuOpen: options.menu })}
        />
        </ThreadPinProvider>
        </SettingsProvider>,
    );
}

function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('для теста нужен хотя бы один тред');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.style.overflow = '';
});

/** Живая панель: открытие портальной модалки статической разметкой не проверить. */
function mountBar(): { readonly commentButton: HTMLButtonElement } {
    // Раскладка markdown детерминирована: обычная textarea вместо ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const threadStore = createThreadStore(DRAFT_THREADS, FILE_IDS);
    const root = createRoot(host);

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <ReviewActionBar
                    pr={DATA.pr}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={threadStore}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={() => Promise.reject(new Error('тест не публикует'))}
                    onComplete={() => undefined}
                    route={null}
                />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const commentButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Комментарий к PR',
    );
    if (commentButton === undefined) {
        throw new Error('в панели нет кнопки «Комментарий к PR»');
    }
    return { commentButton };
}

describe('модалка комментариев к PR', () => {
    it('кнопка открывает dialog, закрытие возвращает фокус на кнопку', async () => {
        const { commentButton } = mountBar();

        expect(commentButton.getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('.pr-comments-modal')).toBeNull();

        act(() => {
            commentButton.click();
        });
        const dialog = document.querySelector<HTMLElement>('.pr-comments-modal');
        expect(commentButton.getAttribute('aria-expanded')).toBe('true');
        expect(dialog?.getAttribute('role')).toBe('dialog');
        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(dialog?.contains(document.activeElement)).toBe(true);

        const close = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть комментарии к PR"]');
        await act(async () => {
            close?.click();
            await Promise.resolve();
        });

        expect(document.querySelector('.pr-comments-modal')).toBeNull();
        expect(commentButton.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(commentButton);
        expect(document.body.style.overflow).toBe('');
    });

    it('открывается снаружи панели и возвращает фокус вызвавшей кнопке', async () => {
        const { outside } = mountSharedGate();

        act(() => {
            outside.click();
        });

        expect(document.querySelector('.pr-comments-modal')).not.toBeNull();

        const close = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть комментарии к PR"]');
        await act(async () => {
            close?.click();
            await Promise.resolve();
        });

        expect(document.querySelector('.pr-comments-modal')).toBeNull();
        expect(document.activeElement).toBe(outside);
    });
});

/**
 * Панель с общим состоянием модалки: открыть её вправе и карточка обсуждения
 * на Обзоре, и фокус обязан вернуться туда, откуда открыли.
 */
function mountSharedGate(): { readonly outside: HTMLButtonElement } {
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
        const gate = usePrCommentsGate();
        const ref = useRef<HTMLButtonElement | null>(null);
        return (
            <SettingsProvider store={settings}>
                <button
                    type="button"
                    ref={ref}
                    className="outside-opener"
                    onClick={() => {
                        gate.openModal(() => {
                            ref.current?.focus();
                        });
                    }}
                >
                    Написать к PR
                </button>
                <ReviewActionBar
                    pr={DATA.pr}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={createThreadStore(DRAFT_THREADS, FILE_IDS)}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={() => Promise.reject(new Error('тест не публикует'))}
                    onComplete={() => undefined}
                    prComments={gate}
                    route={null}
                />
            </SettingsProvider>
        );
    }

    act(() => {
        root.render(<Harness />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const outside = host.querySelector<HTMLButtonElement>('.outside-opener');
    if (outside === null) {
        throw new Error('в тесте нет внешней кнопки');
    }
    return { outside };
}

/** Режимы публикации PR, где стики-шип выключен настройками. */
const WITHOUT_STICKY: readonly Verdict[] = ['comment', 'ship', 'request_changes'];

/**
 * Живая панель для проверок публикации: по умолчанию публикация всегда успешна, `results`
 * задаёт ответы хоста по очереди.
 */
function mountShipBar(options: {
    readonly shipMode: UiSettings['shipMode'];
    readonly verdicts: readonly Verdict[];
    readonly menu?: boolean;
    readonly threads?: readonly Thread[];
    readonly results?: PublishResult[];
}): {
    readonly host: HTMLElement;
    readonly published: Verdict[];
    readonly shipMode: () => UiSettings['shipMode'];
} {
    const settings = createUiSettingsStore({ initial: { shipMode: options.shipMode } });
    const published: Verdict[] = [];
    const results = [...(options.results ?? [])];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <ReviewActionBar
                    pr={{ ...DATA.pr, capabilities: { ...DATA.pr.capabilities, publishVerdicts: [...options.verdicts] } }}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={createThreadStore([...(options.threads ?? [])], FILE_IDS)}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={(verdict) => {
                        published.push(verdict);
                        return Promise.resolve(
                            results.shift() ?? { publishedCommentIds: [], failed: [], verdictApplied: true },
                        );
                    }}
                    onComplete={() => undefined}
                    route={null}
                    defaultMenuOpen={options.menu ?? false}
                />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, published, shipMode: () => settings.getSnapshot().shipMode };
}

function clickByText(host: HTMLElement, selector: string, text: string): void {
    const target = [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent.includes(text));
    if (target === undefined) {
        throw new Error(`в панели нет элемента ${selector} с текстом «${text}»`);
    }
    act(() => {
        target.click();
    });
}

describe('глобальный режим шипа', () => {
    it('публикация понижённым режимом не затирает выбор ревьюера', async () => {
        // Настройки просят sticky, но на этом PR его нет: кнопка публикует ship — это не выбор.
        const bar = mountShipBar({ shipMode: 'sticky_ship', verdicts: WITHOUT_STICKY });

        clickByText(bar.host, '.review-action-bar__ship-primary', 'Ship');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['ship']);
        expect(bar.shipMode()).toBe('sticky_ship');
    });

    it('явный выбор режима в меню запоминается', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: DATA.pr.capabilities.publishVerdicts, menu: true });

        clickByText(bar.host, '.review-action-menu__option', 'Sticky ship');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['sticky_ship']);
        expect(bar.shipMode()).toBe('sticky_ship');
    });
});

describe('публикация без вердикта', () => {
    it('строка Comment в меню публикует comment и запоминает режим', async () => {
        const bar = mountShipBar({
            shipMode: 'ship',
            verdicts: DATA.pr.capabilities.publishVerdicts,
            threads: DRAFT_THREADS,
            menu: true,
        });

        clickByText(bar.host, '.review-action-menu__option', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
        expect(bar.shipMode()).toBe('comment');
    });

    it('сохранённый Comment — главная часть с кареткой', async () => {
        const bar = mountShipBar({ shipMode: 'comment', verdicts: DATA.pr.capabilities.publishVerdicts, threads: DRAFT_THREADS });

        expect(bar.host.querySelector('.review-action-bar__ship-caret')).not.toBeNull();
        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
    });

    it('клавиатура в меню ходит по трём строкам, Enter на выключенной ничего не делает', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: WITHOUT_STICKY, threads: [], menu: true });
        const menu = bar.host.querySelector<HTMLElement>('.review-action-menu');
        if (menu === null) {
            throw new Error('меню не открыто');
        }
        const press = (key: string): void => {
            act(() => {
                menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        };

        press('ArrowDown');
        press('ArrowDown');
        press('ArrowDown');
        expect(menu.getAttribute('aria-activedescendant')).toBe('review-ship-option-2');
        // Comment без черновиков выключен.
        press('Enter');
        press('ArrowUp');
        // Sticky ship вне режимов хоста выключен.
        press('Enter');
        await act(async () => {
            await Promise.resolve();
        });
        expect(bar.published).toEqual([]);

        press('ArrowUp');
        press('Enter');
        await act(async () => {
            await Promise.resolve();
        });
        expect(bar.published).toEqual(['ship']);
    });

    it('один режим: кнопка Comment без каретки, выбор не запоминается', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: ['comment'], threads: DRAFT_THREADS });

        expect(bar.host.querySelector('.review-action-bar__ship-caret')).toBeNull();
        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
        expect(bar.shipMode()).toBe('ship');
    });

    it('после сбоя повтор публикует тот же comment', async () => {
        const bar = mountShipBar({
            shipMode: 'ship',
            verdicts: ['comment'],
            threads: DRAFT_THREADS,
            results: [
                { publishedCommentIds: [], failed: [{ commentId: 'draft-1', message: 'host refused' }], verdictApplied: false },
            ],
        });

        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });
        clickByText(bar.host, '.review-action-error__summary button', 'повторить');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment', 'comment']);
    });
});

describe('условие монтирования плавающей панели', () => {
    const base = {
        completed: false,
        reviewHost: 'fixture',
        pr: DATA.pr,
    } as const;

    it('монтируется только с рабочими данными, в любом виде', () => {
        expect(reviewActionBarVisible({ ...base, dataReady: false })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true })).toBe(true);
    });

    it('завершённое ревью и отсутствие PR или хоста прячут панель', () => {
        expect(reviewActionBarVisible({ ...base, dataReady: true, completed: true })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true, reviewHost: null })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true, pr: null })).toBe(false);
    });
});

describe('плавающая панель ревью', () => {
    it('показывает живой счётчик драфтов и число на всех терминальных кнопках', () => {
        const drafts = countDraftComments(DRAFT_THREADS);
        expect(drafts).toBeGreaterThan(0);

        const html = renderBar();

        expect(html).toContain(`${String(drafts)} черновик`);
        expect(html).toContain(`Request changes · ${String(drafts)}`);
        expect(html).toContain(`Ship · ${String(drafts)}`);
        // Отдельной кнопки публикации без вердикта нет: Comment — режим меню Ship.
        expect(html).not.toContain('Опубликовать');
        expect(html).not.toContain('Comment ·');
    });

    it('только комментарии: одна кнопка Comment без каретки и вердиктов', () => {
        const html = renderBar({ verdicts: ['comment'] });

        expect(html).toMatch(
            /<button[^>]*class="ctl ctl--primary review-action-bar__ship-primary"[^>]*title="Опубликует 1 черновик без вердикта"[^>]*>Comment · 1<\/button>/,
        );
        expect(html).not.toContain('Request changes');
        expect(html).not.toContain('review-action-bar__ship-caret');
        expect(html).not.toContain('ic-thumb');
    });

    it('только комментарии без черновиков: Comment выключен с причиной', () => {
        const html = renderBar({ threads: [], verdicts: ['comment'] });

        expect(html).toMatch(/<button[^>]*review-action-bar__ship-primary"[^>]*disabled=""[^>]*title="нет неопубликованных комментариев"/);
        expect(html).toContain('>Comment</button>');
    });

    it('сохранённый Comment без черновиков: главная часть выключена, каретка доступна', () => {
        const html = renderBar({ threads: [], shipMode: 'comment' });

        expect(html).toMatch(/<button[^>]*review-action-bar__ship-primary"[^>]*disabled=""[^>]*title="нет неопубликованных комментариев"/);
        expect(html).toMatch(/<button[^>]*review-action-bar__ship-caret"(?![^>]*disabled)[^>]*>/);
    });

    it('сохранённый sticky вне режимов PR падает в ship', () => {
        const html = renderBar({ shipMode: 'sticky_ship', verdicts: WITHOUT_STICKY });

        expect(html).toContain(`>Ship · ${String(countDraftComments(DRAFT_THREADS))}</button>`);
    });

    it('без request_changes в режимах кнопки Request changes нет, шип остаётся', () => {
        const html = renderBar({ verdicts: ['comment', 'ship'] });

        expect(html).not.toContain('Request changes');
        expect(html).toContain('review-action-bar__ship-primary');
        expect(html).toContain('review-action-bar__ship-caret');
    });

    it('без comment в режимах сохранённый Comment падает в ship', () => {
        const html = renderBar({ shipMode: 'comment', verdicts: ['ship', 'request_changes'] });

        expect(html).toContain(`>Ship · ${String(countDraftComments(DRAFT_THREADS))}</button>`);
        expect(html).not.toContain('review-action-bar__ship-caret');
    });

    it('без режимов сплит-кнопки её нет, Request changes остаётся', () => {
        const html = renderBar({ verdicts: ['request_changes'] });

        expect(html).not.toContain('review-action-bar__ship-primary');
        expect(html).toContain('Request changes');
    });

    it('локальное ревью: черновики уходят агенту, а не публикуются', () => {
        const html = renderBar({ verdicts: ['comment'], reviewHost: 'local-arc' });

        expect(html).toContain('1 черновик уйдёт агенту');
        expect(html).toContain('title="Передаст 1 черновик агенту"');
        expect(html).not.toContain('при публикации');
    });

    it('локальное ревью без черновиков: «нет комментариев для агента»', () => {
        const html = renderBar({ threads: [], verdicts: ['comment'], reviewHost: 'local-arc' });

        expect(html).toContain('<span class="review-action-bar__no-drafts">нет комментариев для агента</span>');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="нет комментариев для агента"/);
    });

    it('локальное ревью с вердиктами: Request changes и Ship без каретки, оба — агенту', () => {
        const html = renderBar({ verdicts: ['request_changes', 'ship'], reviewHost: 'local-arc' });

        expect(html).toContain('title="Передаст 1 черновик агенту и запросит изменения"');
        expect(html).toMatch(
            /<button[^>]*review-action-bar__ship-primary"[^>]*title="Передаст 1 черновик агенту и одобрит изменения"[^>]*>.*Ship · 1<\/button>/,
        );
        expect(html).not.toContain('review-action-bar__ship-caret');
        expect(html).not.toContain('>Comment');
    });

    // Вердикт сессия обязана узнать и без замечаний: пустой Ship и пустой Request changes не выключены.
    it('локальное ревью с вердиктами без черновиков: Ship и Request changes доступны', () => {
        const html = renderBar({ threads: [], verdicts: ['request_changes', 'ship'], reviewHost: 'local-arc' });

        expect(html).toContain('review-action-bar__ship-primary');
        expect(html).toContain('Request changes');
        expect(html).not.toContain('disabled=""');
    });

    it('с нулём драфтов показывает нейтральный текст', () => {
        const html = renderBar({ threads: [] });

        expect(html).toContain('нет неопубликованных комментариев');
        expect(html).not.toContain('уйдут при публикации');
    });

    it('согласует глагол для чисел, оканчивающихся на один', () => {
        const source = DRAFT_THREADS[0];
        if (source === undefined) {
            throw new Error('для теста нужен тред');
        }
        const threads = Array.from({ length: 21 }, (_, index) => ({
            ...source,
            id: `draft-thread-${String(index)}`,
            root: { ...source.root, id: `draft-${String(index)}`, draft: true },
        }));

        expect(renderBar({ threads })).toContain('21 черновик уйдёт при публикации');
    });

    // Сколько черновиков откроют замечание — приписка к счётчику (SPEC-changes-2026-09-20 §1).
    it('дописывает к счётчику черновиков число issue', () => {
        const source = DRAFT_THREADS[0];
        if (source === undefined) {
            throw new Error('для теста нужен тред');
        }
        const threads = [0, 1].map((index) => ({
            ...source,
            id: `issue-thread-${String(index)}`,
            root: { ...source.root, id: `issue-draft-${String(index)}`, draft: true, issue: true },
        }));

        expect(renderBar({ threads })).toContain('· 2 issues');
    });

    it('без issue-черновиков приписки нет', () => {
        expect(renderBar()).not.toContain('issue');
    });

    it('считает issue и у черновиков буфера', () => {
        const html = renderBar({
            threads: [],
            draftBuffer: [{ ...BUFFERED, draft: { ...BUFFERED.draft, issue: true } }],
        });

        expect(html).toContain('· 1 issue');
    });

    // Буфер черновиков: записи считаются в пакете и держат ship, пока не доедут.
    it('черновики буфера попадают в счётчик и блокируют ship с причиной', () => {
        const drafts = countDraftComments(DRAFT_THREADS);

        const html = renderBar({ draftBuffer: [BUFFERED] });

        expect(html).toContain(`${String(drafts + 1)} черновик`);
        expect(html).toContain('1 ещё не отправлен');
        expect(html).toContain('1 черновик ещё не отправлен — ship недоступен, пока не сохранится');
        expect(html).toContain('class="ctl ctl--primary review-action-bar__ship-primary" disabled=""');
    });

    // Правка относится к черновику, который в тредах уже посчитан: второго черновика от неё
    // в пакете не появляется, а ship она держит наравне с созданием.
    it('буферная правка не удваивает счётчик черновиков, но держит ship', () => {
        const drafts = countDraftComments(DRAFT_THREADS);

        const html = renderBar({ draftBuffer: [{ ...BUFFERED, commentId: 'draft-1' }] });

        expect(html).toContain(`${String(drafts)} черновик`);
        expect(html).toContain('1 ещё не отправлен');
        expect(html).toContain('ship недоступен, пока не сохранится');
    });

    // Счётчик нерешённых тредов с панели снят: он ни о чём не просил и публикацию не держал.
    it('про нерешённые треды панель не пишет и ship из-за них не выключает', () => {
        expect(DRAFT_THREADS.filter((thread) => !thread.resolved).length).toBeGreaterThan(0);

        expect(renderBar()).not.toContain('нерешённ');
        expect(renderBar()).not.toContain('review-action-bar__ship-primary" disabled');
    });

    it('меню: Ship, Sticky ship и Comment со следствием', () => {
        const html = renderBar({ menu: true });

        expect(html.indexOf('<strong>Ship</strong>')).toBeLessThan(html.indexOf('<strong>Sticky ship</strong>'));
        expect(html.indexOf('<strong>Sticky ship</strong>')).toBeLessThan(html.indexOf('<strong>Comment</strong>'));
        expect(html).toContain('id="review-ship-option-2"');
        expect(html).toContain('<span>Опубликует 1 черновик без вердикта</span>');
    });

    it('меню без черновиков: строка Comment выключена с причиной', () => {
        const html = renderBar({ menu: true, threads: [] });

        expect(html).toMatch(
            /id="review-ship-option-2"[^>]*aria-disabled="true"[^>]*title="нет неопубликованных комментариев"/,
        );
    });

    it('меню содержит неблокирующий гард, точные следствия и причину disabled sticky', () => {
        const html = renderBar({ menu: true, verdicts: WITHOUT_STICKY });

        expect(html).toContain('всё равно шипнуть?');
        expect(html).toContain('Одобряет только этот снапшот. Новый пуш снимает одобрение и спросит снова.');
        // Копирайт честный: зонной отмены у нас нет, публикуется обычный sticky ship Арканума (№36).
        expect(html).toContain('Одобрение переносится на следующие пуши — обычный sticky ship Арканума.');
        expect(html).not.toContain('a.yaml-зоне');
        expect(html).toContain('Здесь Sticky ship недоступен.');
        expect(html).toContain('aria-disabled="true"');
    });

    it('при готовом маршруте гардрейл считает остановки вместо файлов', () => {
        const route = {
            stopIds: ['s01', 's02', 's03'],
            otherStopId: 's03',
            uncoveredLines: 34,
            viewed: new Map([['s01', true]]),
        };

        const html = renderBar({ menu: true, route });

        expect(html).toContain('2 остановки не просмотрены — всё равно шипнуть?');
        expect(html).not.toContain('файлов не просмотрено');
    });

    it('все остановки просмотрены — гардрейла нет вовсе', () => {
        const route = {
            stopIds: ['s01', 's02'],
            otherStopId: null,
            uncoveredLines: 0,
            viewed: new Map([
                ['s01', true],
                ['s02', true],
            ]),
        };

        const html = renderBar({ menu: true, route });

        expect(html).not.toContain('всё равно шипнуть?');
    });

    it('без маршрута остаётся файловый гардрейл по файлам', () => {
        const html = renderBar({ menu: true });

        expect(html).toContain('файлов не просмотрено — всё равно шипнуть?');
    });

    it('прячется только пока diff store держит активную протяжку', () => {
        const diffStore = createDiffViewStore({ files: DATA.diff.files });
        diffStore.beginSelection();
        diffStore.startSelection(DATA.diff.files[0]?.fileId ?? 'file', 'a1');
        const props = {
            pr: DATA.pr,
            diff: DATA.diff,
            diffStore,
            threadStore: createThreadStore(DRAFT_THREADS, FILE_IDS),
            connection: 'online' as const,
            hostName: 'FixtureHost',
            reviewHost: 'fixture',
            composerTransport: TRANSPORT,
            onPublish: () => Promise.reject(new Error('не вызывается при статическом рендере')),
            onComplete: () => undefined,
        };

        expect(renderToStaticMarkup(<ReviewActionBar {...props} />)).toBe('');
        diffStore.finishSelection();
        expect(renderToStaticMarkup(<ReviewActionBar {...props} />)).toContain('review-action-bar');
    });

    it('error-состояние показывает текст несдавшегося комментария и только ретрай', () => {
        const html = renderToStaticMarkup(
            <ReviewActionBar
                pr={DATA.pr}
                diff={DATA.diff}
                diffStore={createDiffViewStore({ files: DATA.diff.files })}
                threadStore={createThreadStore(DRAFT_THREADS, FILE_IDS)}
                connection="online"
                hostName="FixtureHost"
                reviewHost="fixture"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('не вызывается при статическом рендере'))}
                onComplete={() => undefined}
                initialFailure={{
                    verdict: 'ship',
                    failedCount: 1,
                    message: null,
                    comments: [{ commentId: 'bad', body: 'Исправить проверку границы', message: 'host refused' }],
                }}
            />,
        );

        expect(html).toContain('1 комментарий не опубликовался');
        expect(html).toContain('Исправить проверку границы');
        expect(html).toContain('host refused');
        expect(html).toContain('<button type="button" class="ctl ctl--link-muted">повторить</button>');
        expect(html).not.toContain('Request changes');
    });
});

describe('экран Review complete', () => {
    it('рендерит счётчики и amber-футер открытых тредов', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'sticky_ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'Арканум',
                    reviewHost: 'arcanum',
                    publishedComments: 2,
                    publishedReplies: 1,
                    progress: {
                        filesSeen: 17,
                        filesTotal: 18,
                        linesSeen: 800,
                        linesTotal: 862,
                        percentSeen: 92,
                    },
                    route: null,
                    openThreads: 1,
                    firstOpenThreadId: 'thread-1',
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('Sticky ship · PR 4821');
        expect(html).toContain('2 комментария опубликованы одним пакетом');
        expect(html).toContain('доставлено в Арканум');
        expect(html).toContain('17 из 18');
        expect(html).toContain('92% из 862 строк');
        expect(html).toContain('2 (из них 1 ответ)');
        expect(html).toContain('1 тред ещё открыт — шипу это не мешает');
        expect(html).toContain('Подписан снапшот');
        expect(html).toContain('К полному диффу');
        // Без маршрута строк про остановки в карточке нет.
        expect(html).not.toContain('Остановки просмотрены');
        expect(html).not.toContain('вне маршрута');
    });

    it('публикация без вердикта: «Комментарии опубликованы» и провенанс comment', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'comment',
                    prId: '42',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    reviewHost: 'github',
                    publishedComments: 2,
                    publishedReplies: 0,
                    progress: { filesSeen: 3, filesTotal: 5, linesSeen: 40, linesTotal: 90, percentSeen: 44 },
                    route: null,
                    openThreads: 2,
                    firstOpenThreadId: 'thread-1',
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('Комментарии опубликованы · PR 42');
        expect(html).toContain('comment · 9f3c1ab');
        expect(html).toContain('доставлено в GitHub');
        // Шипа не было и ничего не подписано: ни «шипу не мешает», ни «Подписан снапшот».
        expect(html).toContain('2 треда ещё открыты');
        expect(html).not.toContain('шип');
        expect(html).toContain('Просмотрен снапшот');
        expect(html).not.toContain('Подписан');
    });

    it('у локального ревью комментарии не доставляются, а уходят агенту', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'request_changes',
                    prId: 'local-arc-app-0badc0de',
                    headCommit: '9f3c1ab012345',
                    hostName: 'локальный чекаут',
                    reviewHost: 'local-arc',
                    publishedComments: 1,
                    publishedReplies: 0,
                    progress: {
                        filesSeen: 1,
                        filesTotal: 1,
                        linesSeen: 10,
                        linesTotal: 10,
                        percentSeen: 100,
                    },
                    route: null,
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('передано агенту');
        expect(html).not.toContain('доставлено в');
    });

    it('с маршрутом показывает остановки, «Прочее» и прочитанное вне маршрута', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'Арканум',
                    reviewHost: 'arcanum',
                    publishedComments: 2,
                    publishedReplies: 1,
                    progress: {
                        filesSeen: 18,
                        filesTotal: 18,
                        linesSeen: 862,
                        linesTotal: 862,
                        percentSeen: 100,
                    },
                    route: { stopsTotal: 7, stopsViewed: 7, otherViewed: true, uncoveredLines: 34 },
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('7 из 7 · Прочее прочитано сырым диффом');
        expect(html).toContain('100% из 862 строк');
        expect(html).toContain('34 строки, которые модель не разместила');
        // Файловый счётчик уступает место маршрутному.
        expect(html).not.toContain('Файлы просмотрены');
    });

    it('«Прочее» не прочитано — вторая клауза не пишется', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'Арканум',
                    reviewHost: 'arcanum',
                    publishedComments: 0,
                    publishedReplies: 0,
                    progress: {
                        filesSeen: 10,
                        filesTotal: 18,
                        linesSeen: 500,
                        linesTotal: 862,
                        percentSeen: 58,
                    },
                    route: { stopsTotal: 7, stopsViewed: 5, otherViewed: false, uncoveredLines: 34 },
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('5 из 7');
        expect(html).not.toContain('Прочее прочитано сырым диффом');
        // «Of that, read outside the route» — про увиденное: без отметки «Прочего» строки нет.
        expect(html).not.toContain('вне маршрута');
    });
});

describe('черновики, написанные до пуша', () => {
    const V2 = fixtureIteration('medium', 1);

    it('панель считает черновики в тредах прошлых коммитов отдельной пометкой', () => {
        const pinned = V2.threads.find((thread) => thread.pinnedTo !== null && thread.anchor !== null);
        if (pinned === undefined) {
            throw new Error('фикстуре medium нужен тред с пином');
        }
        const threads = [{ ...pinned, root: { ...pinned.root, draft: true } }];

        const html = renderBar({ threads, activeDiffId: V2.diff.diffId });

        expect(html).toContain('1 закреплён за прошлыми коммитами');
    });

    it('пин совпал с активной итерацией — пометки нет', () => {
        const pinned = V2.threads.find((thread) => thread.pinnedTo !== null && thread.anchor !== null);
        if (pinned?.pinnedTo == null) {
            throw new Error('фикстуре medium нужен тред с пином');
        }
        const threads = [{ ...pinned, root: { ...pinned.root, draft: true } }];

        const html = renderBar({ threads, activeDiffId: pinned.pinnedTo.diffId });

        expect(html).not.toContain('закреплён за прошлыми коммитами');
    });
});
