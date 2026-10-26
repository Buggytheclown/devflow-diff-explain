import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { OtherStopFacts } from '../route/other-stop.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * Overview и вкладка «Маршрут» в генеративных фазах (docs/design/README.md §6–7, docs/design/SPEC-elements.md §4.1): что показывает
 * карточка «Кратко» и появляется ли карточка генерации в правом рельсе.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

function state(name: 'medium' | 'small', phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures(name)?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`фикстуре ${name} нужно состояние ${phase}`);
    }
    return fixture;
}

function render(view: 'overview' | 'route', route: UiRouteState | null, other?: OtherStopFacts): string {
    return renderToStaticMarkup(
        <ViewFrame
            view={view}
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view, filter: 'all' } })}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
            generation={other === undefined ? { route } : { route, other }}
        />,
    );
}

describe('Overview в фазах генерации', () => {
    it('фаза A: скелетон вместо Summary и карточка чтения в рельсе', () => {
        const html = render('overview', state('medium', 'reading'));

        expect(html).toContain('summary-skeleton');
        expect(html).toContain('Читаю дифф, планирую маршрут');
        expect(html).toContain('Читаю весь дифф · 21 файл');
        // Каретки нет: summary приезжает целиком со скелетом.
        expect(html).not.toContain('caret');
    });

    it('фаза B: полный текст summary с провенансом и карточка заполнения', () => {
        const html = render('overview', state('medium', 'filling'));

        expect(html).not.toContain('summary-skeleton');
        expect(html).toContain('PR вводит 30-минутное окно редактирования');
        expect(html).toContain('claude-code · claude-opus-5 · ');
        expect(html).toContain('3 из 6 готовы');
        expect(html).not.toContain('Прочее — модель не разместила');
        // Summary и слоты плана — профиль маршрута: бэктики становятся моно-кодом.
        expect(html).toContain('<code class="md-code">EditWindow</code>');
        expect(html).toContain('<code class="md-code">README.md</code>');
        expect(html).not.toContain('`');
    });

    it('провал: Summary честно говорит, что описания нет, рядом красная карточка', () => {
        const html = render('overview', state('medium', 'failed'));

        expect(html).toContain('Краткого описания нет.');
        expect(html).toContain('gen-failed--compact');
    });

    it('генерации не было: приглашение остаётся, карточки генерации нет', () => {
        const html = render('overview', state('medium', 'none'));

        expect(html).toContain('Маршрута ещё нет.');
        expect(html).not.toContain('gen-card');
    });

    it('малый PR: Summary объясняет отсутствие маршрута вместо приглашения запустить скилл', () => {
        const html = render('overview', state('small', 'none'));

        expect(html).toContain('Малый PR — маршрут не нужен.');
        expect(html).not.toContain('Запусти скилл');
        expect(html).not.toContain('gen-card');
    });

    it('готовый маршрут, где модель разместила все строки, — «Прочее» не входит в счёт остановок', () => {
        const placed = render('overview', state('medium', 'ready'), { uncovered: 0, conflictFiles: 0 });
        const withOther = render('overview', state('medium', 'ready'), { uncovered: 38, conflictFiles: 0 });

        expect(placed).toContain('Маршрут готов · 6 остановок');
        expect(placed).not.toContain('Прочее — модель не разместила');
        expect(withOther).toContain('Маршрут готов · 7 остановок');
        expect(withOther).toContain('Прочее — модель не разместила');
    });

    it('карточки снапшотов нет и после готовности маршрута', () => {
        const html = render('overview', state('medium', 'ready'));

        expect(html).not.toContain('Снапшоты');
        expect(html).not.toContain('Снапшотов нет');
    });
});

describe('вкладка «Маршрут» без маршрута', () => {
    it('малый PR объясняет порог и уводит в читалку, таб остаётся живым', () => {
        const html = render('route', state('small', 'none'));

        expect(html).toContain('Малый PR — маршрут не нужен');
        expect(html).toContain('Читать полный дифф');
        expect(html).not.toContain('Маршрута для этого PR ещё нет');
    });

    it('обычный PR без маршрута — прежнее приглашение запустить скилл', () => {
        const html = render('route', state('medium', 'none'));

        expect(html).toContain('Маршрута для этого PR ещё нет');
    });

    it('состояние маршрута ещё не приехало — приглашение, а не пустой экран', () => {
        expect(render('route', null)).toContain('Маршрута для этого PR ещё нет');
    });
});
