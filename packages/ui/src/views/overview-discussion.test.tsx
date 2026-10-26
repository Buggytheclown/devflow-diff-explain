// @vitest-environment jsdom
import { anchor, bot, comment, human, thread } from '@sherpa/fixtures';
import { fixtureIteration } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import type { SessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { OverviewDiscussion } from './overview-discussion.tsx';
import { ViewFrame } from './view-frames.tsx';

/**
 * Карточка «Обсуждение» на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e): сводка и вход. Треды людей вне диффа
 * она раскрывает (читать их больше негде), бот-треды — никогда, участников показывает не
 * больше шести.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DIFF_ID = 'd1';
const ALIVE = 'services/orders/src/alive.ts';
const GONE = 'services/orders/src/gone.ts';
const FILE_IDS = new Set([anchor(DIFF_ID, ALIVE).fileId]);
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const PEOPLE = ['ada', 'morgan', 'kai', 'iris', 'dana', 'nora', 'sam'];

/** Семь человек по одному треду у кода: шестая строка — предел, седьмой прячется за «ещё N». */
const AT_CODE: readonly Thread[] = PEOPLE.map((login, index) =>
    thread({
        id: `code-${login}`,
        anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: index + 1 }),
        root: comment({
            id: `code-${login}-root`,
            author: human(login, login),
            body: 'at the code',
            createdAt: `2026-08-24T1${String(index)}:00:00.000Z`,
        }),
    }),
);

const OUTSIDE: readonly Thread[] = [
    thread({
        id: 'pr-level',
        anchor: null,
        root: comment({
            id: 'pr-level-root',
            author: human('ada', 'ada'),
            body: 'PR-level body',
            createdAt: '2026-08-24T11:30:00.000Z',
        }),
    }),
    thread({
        id: 'gone-file',
        anchor: anchor(DIFF_ID, GONE, { side: 'new', line: 4 }),
        root: comment({
            id: 'gone-file-root',
            author: human('morgan', 'morgan'),
            body: 'gone file body',
            createdAt: '2026-08-24T11:00:00.000Z',
            replies: [
                // Своих тредов не открывал — строка участника у него только из-за этого ответа.
                comment({
                    id: 'gone-file-reply',
                    author: human('riley', 'riley'),
                    body: 'reply body',
                    createdAt: '2026-08-24T11:10:00.000Z',
                }),
            ],
        }),
    }),
];

const BOT_OUTSIDE = thread({
    id: 'bot-pr-level',
    anchor: null,
    root: comment({
        id: 'bot-pr-level-root',
        author: bot('ai-review-bot', 'AI Review'),
        body: 'bot body never shown',
        createdAt: '2026-08-24T11:45:00.000Z',
    }),
});

const THREADS: readonly Thread[] = [...AT_CODE, ...OUTSIDE, BOT_OUTSIDE];

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

/** Карточка в Обзоре читает треды из стора, а не из пропа-константы: черновики видны сразу. */
function CardUnderTest({
    session,
    store,
    onWritePrComment,
}: {
    session: SessionStore;
    store: ThreadStore;
    onWritePrComment?: (returnFocus: () => void) => void;
}) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return (
        <OverviewDiscussion
            threads={snapshot.threads}
            fileIds={FILE_IDS}
            session={session}
            store={store}
            transport={TRANSPORT}
            now={NOW}
            loading={false}
            error={null}
            {...(onWritePrComment === undefined ? {} : { onWritePrComment })}
        />
    );
}

function mount(options: { onWritePrComment?: (returnFocus: () => void) => void } = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const session: SessionStore = createSessionStore({
        initial: { view: 'overview', filter: 'all' },
    });
    const store = createThreadStore(THREADS, FILE_IDS);
    const root = createRoot(host);
    act(() => {
        root.render(
            <CardUnderTest
                session={session}
                store={store}
                {...(options.onWritePrComment === undefined
                    ? {}
                    : { onWritePrComment: options.onWritePrComment })}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, session, store };
}

function rows(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.discussion-participant__name')].map((node) => node.textContent);
}

function click(host: HTMLElement, selector: string, index = 0): void {
    const element = [...host.querySelectorAll<HTMLElement>(selector)][index];
    expect(element, selector).toBeDefined();
    act(() => {
        element?.click();
    });
}

describe('карточка обсуждения на Обзоре', () => {
    it('шапка считает все треды PR, чипов источников в карточке больше нет', () => {
        const { host } = mount();

        expect(host.querySelector('.discussion-card__counts')?.textContent).toBe('10 тредов · 10 открыты');
        expect(host.querySelector('.thread-chip')).toBeNull();
    });

    it('показывает не больше шести строк, остальные — за «ещё N участников»', () => {
        const { host } = mount();

        expect(rows(host)).toHaveLength(6);
        expect(host.querySelector('.discussion-card__more')?.textContent).toBe('ещё 3 участника');

        click(host, '.discussion-card__more');

        // Девятая строка — riley: своих тредов у него нет, только ответ в чужом.
        expect(rows(host)).toHaveLength(9);
        expect(rows(host)).toContain('riley');
        expect(host.querySelector('.discussion-card__more')).toBeNull();
    });

    it('свёртка «вне диффа» закрыта по умолчанию и раскрывает только треды людей', () => {
        const { host } = mount();
        const toggle = host.querySelector('.discussion-card__outside-toggle');

        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('.discussion-thread')).toBeNull();

        click(host, '.discussion-card__outside-toggle');

        expect(host.querySelectorAll('.discussion-thread')).toHaveLength(2);
        expect(host.textContent).toContain('PR-level body');
        expect(host.textContent).toContain('gone file body');
        expect(host.textContent).not.toContain('bot body never shown');
    });

    it('клик по участнику ставит линзу по автору и уводит на полный дифф', () => {
        const { host, session } = mount();

        // Первая строка — у кого больше открытых: у ada их два (у кода и уровня PR).
        click(host, '.discussion-participant');

        expect(session.getSnapshot().threadAuthor).toBe('ada');
        expect(session.getSnapshot().view).toBe('diff');
    });

    it('«Все треды у кода» снимает линзу по автору, а не уводит с ней на дифф', () => {
        const { host, session } = mount();

        click(host, '.discussion-participant');
        expect(session.getSnapshot().threadAuthor).toBe('ada');

        session.setView('overview');
        click(host, '.discussion-card__all');

        expect(session.getSnapshot().threadAuthor).toBeNull();
        expect(session.getSnapshot().view).toBe('diff');
    });

    it('чип состояния стоит у каждого треда вне диффа, включая открытый', () => {
        const { host } = mount();
        click(host, '.discussion-card__outside-toggle');

        expect([...host.querySelectorAll('.discussion-thread__state')].map((chip) => chip.textContent)).toEqual([
            'открыт',
            'открыт',
        ]);
    });

    it('ответы треда вне диффа читаются в карточке, а написанный ответ виден сразу', () => {
        const { host, store } = mount();
        click(host, '.discussion-card__outside-toggle');

        // Свёрнуты в счётчик: карточка остаётся сводкой, пока ответы не попросили.
        const toggle = host.querySelector('.discussion-thread__replies-toggle');
        expect(toggle?.textContent).toBe('1 ответ');
        expect(host.textContent).not.toContain('reply body');

        click(host, '.discussion-thread__replies-toggle');
        expect(host.textContent).toContain('reply body');

        // Композер закрывается на сохранении: новый ответ обязан появиться в самой карточке.
        click(host, '.discussion-thread__reply', 1);
        act(() => {
            store.addDraft(
                { parentId: 'gone-file-root', anchor: null, body: 'fresh reply' },
                comment({
                    id: 'fresh-reply',
                    author: human('me', 'me'),
                    body: 'fresh reply',
                    createdAt: '2026-08-24T11:40:00.000Z',
                    draft: true,
                }),
            );
        });

        expect(host.textContent).toContain('fresh reply');
    });

    it('«Написать к PR» зовёт открытие модалки и отдаёт возврат фокуса', () => {
        const onWrite = vi.fn();
        const { host } = mount({ onWritePrComment: onWrite });

        click(host, '.discussion-card__write');

        expect(onWrite).toHaveBeenCalledTimes(1);
        const returnFocus = onWrite.mock.calls[0]?.[0] as () => void;
        returnFocus();
        expect(document.activeElement).toBe(host.querySelector('.discussion-card__write'));
    });

    it('без тредов — приглашение начать у кода, подвал остаётся', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <OverviewDiscussion
                    threads={[]}
                    fileIds={FILE_IDS}
                    session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                    store={createThreadStore([], FILE_IDS)}
                    transport={TRANSPORT}
                    now={NOW}
                    loading={false}
                    error={null}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('Ни одного треда — обсуждение начинается у кода.');
        expect(host.querySelector('.thread-chip')).toBeNull();
        expect(host.querySelector('.discussion-card__write')).not.toBeNull();
    });
});

describe('карточка обсуждения в Обзоре целиком', () => {
    it('встаёт в правый рельс вместо ленты тредов', () => {
        const data = fixtureIteration('medium');
        const fileIds = new Set(data.diff.files.map((file) => file.fileId));
        const html = renderToStaticMarkup(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                pr={data.pr}
                diff={data.diff}
                lenses={{ ownership: data.ownership, extra: data.extraLenses, ownershipSource: 'CODEOWNERS' }}
                threads={data.threads}
                threadStore={createThreadStore(data.threads, fileIds)}
                threadNow={NOW}
                reviewHostAvailable
            />,
        );

        expect(html).toContain('class="discussion-card"');
        expect(html).toContain('aria-expanded="false"');
        // Лента тредов из старой карточки на Обзоре больше не живёт.
        expect(html).not.toContain('thread-outside__toggle');
        expect(html).not.toContain('thread__body');
    });
});

const TRANSPORT = {
    save: () => Promise.reject(new Error('нет записи в тесте')),
    update: () => Promise.reject(new Error('нет записи в тесте')),
    delete: () => Promise.reject(new Error('нет записи в тесте')),
};
