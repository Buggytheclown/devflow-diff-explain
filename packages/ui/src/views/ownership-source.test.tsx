import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { RouteWorkspace } from './route/route-workspace.tsx';
import { ViewFrame } from './view-frames.tsx';

/**
 * Источник зон ответственности подписан тем, что отдал хост (`ownershipSource`): у GitHub —
 * CODEOWNERS, у другого хоста — своё имя (здесь MAINTAINERS). Имя стоит и в шапке Обзора,
 * и в подписи фильтра «мои файлы», который рисуют Маршрут и Полный дифф.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();


function render(ownershipSource: string | null, ownership = DATA.ownership): string {
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            diff={DATA.diff}
            lenses={{ ownership, extra: DATA.extraLenses, ownershipSource }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
        />,
    );
}

describe('Обзор: имя источника зон ответственности', () => {
    it('источник CODEOWNERS подписывает зоны', () => {
        const html = render('CODEOWNERS');

        expect(html).toContain('CODEOWNERS · ');
        expect(html).toContain('Ваша зона ответственности по CODEOWNERS.');
        expect(html).not.toContain('MAINTAINERS');
    });

    it('объяснение хоста видно и у работающей линзы', () => {
        const note = 'GitHub did not tell which teams you are in (read:org scope?).';
        const ownership = DATA.ownership === null ? null : { ...DATA.ownership, note };

        expect(render('CODEOWNERS', ownership)).toContain(note);
    });

    it('источник MAINTAINERS подписывает зоны', () => {
        const html = render('MAINTAINERS');

        expect(html).toContain('MAINTAINERS · ');
        expect(html).toContain('Ваша зона ответственности по MAINTAINERS.');
        expect(html).not.toContain('CODEOWNERS · ');
        expect(html).not.toContain('по CODEOWNERS');
    });
});

/** Фильтр «мои файлы» выбран: полную подпись селект показывает у выбранного фильтра. */
function renderRoute(ownershipSource: string): string {
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource }}
            snapshot={SNAPSHOT}
            session={createSessionStore({ initial: { view: 'route', filter: 'mine' } })}
            store={createDiffViewStore({ files: DATA.diff.files })}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={() => Promise.resolve(0)}
        />,
    );
}

describe('Обзор без линз', () => {
    it('шапка без источника зон', () => {
        const html = renderToStaticMarkup(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                diff={DATA.diff}
                lenses={null}
                threads={DATA.threads}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable={false}
            />,
        );

        expect(html).toContain('>Зона ответственности недоступна<');
        expect(html).not.toContain('CODEOWNERS · ');
    });
});

describe('Фильтр «мои файлы»: имя источника зон', () => {
    it('источник CODEOWNERS подписывает фильтр', () => {
        const html = renderRoute('CODEOWNERS');

        expect(html).toContain('Мои файлы · CODEOWNERS');
        expect(html).not.toContain('MAINTAINERS');
    });

    it('локальное ревью подписывает фильтр своим источником', () => {
        const html = renderRoute('arc diff');

        expect(html).toContain('Мои файлы · arc diff');
        expect(html).not.toContain('Мои файлы · CODEOWNERS');
    });

    it('источник MAINTAINERS подписывает фильтр', () => {
        const html = renderRoute('MAINTAINERS');

        expect(html).toContain('Мои файлы · MAINTAINERS');
        expect(html).not.toContain('Мои файлы · CODEOWNERS');
    });
});
