import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../i18n/index.js';
import { reviewProgressSummary } from '../progress/summary.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { EmptyPrNotice } from './full-diff.tsx';
import { ViewFrame } from './view-frames.tsx';

/** Пустой PR (docs/design/SPEC-elements.md §4.1): «Nothing to review», карточек Обзора нет, шип остаётся доступен. */

const DATA = fixtureIteration('medium');
const EMPTY_DIFF = { ...DATA.diff, files: [] };

function overview(locale: 'ru' | 'en'): string {
    return renderToStaticMarkup(
        <LocaleProvider locale={locale}>
            <ViewFrame
                view="overview"
                prKey="fixture-empty"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                pr={DATA.pr}
                diff={EMPTY_DIFF}
                lenses={{ ownership: null, extra: [], ownershipSource: null }}
                threads={[]}
                threadStore={createThreadStore([], new Set())}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable
            />
        </LocaleProvider>,
    );
}

describe('пустой PR', () => {
    it('на полном диффе — экран вместо пустого списка файлов', () => {
        const html = renderToStaticMarkup(<EmptyPrNotice />);

        expect(html).toContain('Нечего ревьюить');
        expect(html).toContain('В этом PR нет изменений относительно базы.');
        // Выхода отсюда нет: предлагать «к активной итерации» или фильтр нечего.
        expect(html).not.toContain('<button');
    });

    it('английский текст — дословно из docs/design/SPEC-elements.md §4.1', () => {
        const html = renderToStaticMarkup(
            <LocaleProvider locale="en">
                <EmptyPrNotice />
            </LocaleProvider>,
        );

        expect(html).toContain('Nothing to review');
        expect(html).toContain('This PR has no changes against the base.');
    });

    it('на Обзоре — тот же экран вместо карточек, которые соврали бы пустотой', () => {
        const html = overview('ru');

        expect(html).toContain('Нечего ревьюить');
        expect(html).toContain('В этом PR нет изменений относительно базы.');
        expect(html).not.toContain('ownership-card');
        expect(html).not.toContain('overview__grid');
        expect(overview('en')).toContain('Nothing to review');
    });

    it('панель действий не мешает шипу: непросмотренного нет, прогресс 100%', () => {
        expect(reviewProgressSummary([], new Map())).toMatchObject({
            filesSeen: 0,
            filesTotal: 0,
            percentSeen: 100,
        });
    });
});
