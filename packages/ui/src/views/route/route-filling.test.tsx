import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteReadingView } from './route-generating.tsx';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Маршрут в генеративных фазах (docs/design/README.md §8): все слоты плана на месте, незаполненные показывают
 * номер, заголовок и шиммер-скелетон вместо диффа, а полоса покрытия честно ждёт план.
 */

const DATA = fixtureIteration('medium');
const FILLING: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.filling?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен частично заполненный снапшот');
    }
    return snapshot;
})();
const READY: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

function render(options: { snapshot?: RouteSnapshot; agentStopped?: boolean } = {}): string {
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            snapshot={options.snapshot ?? FILLING}
            agentStopped={options.agentStopped ?? false}
            session={createSessionStore({ initial: { view: 'route', filter: 'all' } })}
            store={store}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={() => Promise.resolve(0)}
            onSetStopFileViewed={() => Promise.resolve(0)}
        />,
    );
}

function order(html: string): string[] {
    return [...html.matchAll(/data-stop="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

describe('маршрут в фазе заполнения', () => {
    it('держит все слоты плана в план-порядке, «Прочего» до готовности нет', () => {
        const html = render();

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06']);
        expect(html).toContain('01 / 6');
        expect(html).toContain('03 / 6');
    });

    it('незаполненный слот: бейдж, строка-объяснение и скелетон вместо диффа', () => {
        const html = render();

        // s03 и s04 в очереди, s06 заполняется — три скелетона, три приглушённых слота.
        expect(count(html, 'route-skeleton-card"')).toBe(3);
        expect(count(html, 'route-stop--unfilled')).toBe(3);
        expect(html).toContain('в очереди');
        expect(html).toContain('заполняется');
        expect(html).toContain('Агент ещё не заполнил эту остановку — она приземлится в этот слот.');
        expect(html).not.toContain('Ханков нет');
    });

    it('отметить незаполненную остановку нельзя — диапазонов у неё нет', () => {
        const html = render();

        expect(html).toContain('title="Остановка ещё не заполнена"');
        expect(count(html, 'disabled=""')).toBeGreaterThan(0);
    });

    it('полоса покрытия ждёт план и считает готовые слоты, а не файлы диффа', () => {
        const html = render();

        expect(html).toContain('покрытие известно после плана');
        expect(html).not.toContain('считаю покрытие по диффу');
        expect(html).not.toContain('% объяснено');
    });

    it('«Прочего» на недостроенном маршруте нет: непокрытое там — незанятые слоты, а не остаток модели', () => {
        const html = render();

        expect(html).not.toContain('data-stop="other"');
        expect(html).not.toContain('Маршрут ещё заполняется — сейчас сюда попадает всё');
        expect(html).not.toContain('Модель не разместила эти диапазоны');
    });

    it('агент умер посреди генерации: заполненное помечено, незаполненное — нет (docs/design/SPEC-elements.md §4.4)', () => {
        const stopped = render({ agentStopped: true });

        // Пометка встаёт только на готовых слотах: s01, s02, s05.
        expect(count(stopped, 'заполнено до остановки агента')).toBe(3);
        expect(render()).not.toContain('заполнено до остановки агента');
    });

    it('готовый маршрут скелетонов и plan-загрузки не показывает', () => {
        const html = render({ snapshot: READY });

        expect(html).not.toContain('route-skeleton-card');
        expect(html).not.toContain('покрытие известно после плана');
        expect(html).toContain('% объяснено');
    });
});

describe('маршрут в фазе чтения', () => {
    it('три безномерных плейсхолдера и полоса без чисел', () => {
        const html = renderToStaticMarkup(<RouteReadingView onOpenDiff={() => undefined} />);

        expect(count(html, '— / ?')).toBe(3);
        expect(count(html, 'route-skeleton-card"')).toBe(3);
        expect(html).toContain('покрытие известно после плана');
        expect(html).not.toContain('просмотрено');
        expect(html).toContain('Читать полный дифф');
    });
});
