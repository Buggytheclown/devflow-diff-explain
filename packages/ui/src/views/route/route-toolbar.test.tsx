import { fixtureIteration } from '@sherpa/fixtures';
import type { UiGenerationCap } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';
import { PRESET_DISABLED_TITLE, RouteToolbar, TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('ru');

/** Переключатель пресета в тулбаре: активная опция, подсказка и выключенное состояние (docs/design/SPEC-elements.md §2.5). */

const DATA = fixtureIteration('medium');

function render(options: { preset?: RoutePreset; disabled?: boolean; cap?: UiGenerationCap | null } = {}): string {
    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses, t,});
    return renderToStaticMarkup(
        <RouteToolbar
            store={createDiffViewStore({ files: DATA.diff.files })}
            preset={options.preset ?? 'triage'}
            onPreset={() => undefined}
            presetDisabled={options.disabled ?? false}
            filters={filters}
            filter={selectFilter(filters, 'all')}
            onFilter={() => undefined}
            strip={null}
            generationCap={options.cap ?? null}
        />,
    );
}

describe('тулбар маршрута', () => {
    it('активная опция помечена классом и aria-pressed, подсказка едет за пресетом', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain('route-preset__option is-active" aria-pressed="true"');
        expect(triage).toContain(t(TRIAGE_HINT));
        expect(tour).toContain(t(TOUR_HINT));
        expect(tour).toContain('aria-pressed="true">Полный тур</button>');
        expect(tour).toContain('aria-pressed="false">Триаж</button>');
    });

    it('строка капа появляется, только когда план покрыл не весь дифф (docs/design/SPEC-elements.md §4.1)', () => {
        const capped = render({ cap: { filesCovered: 120, filesTotal: 500, machineFiles: 380, truncated: false } });

        expect(capped).toContain('route-toolbar__cap');
        expect(capped).toContain('план покрывает 120 файлов из 500; 380 машинных — одной остановкой');
        expect(render()).not.toContain('route-toolbar__cap');
        // Кап есть, но урезания не было: говорить нечего.
        expect(
            render({ cap: { filesCovered: 18, filesTotal: 18, machineFiles: 0, truncated: false } }),
        ).not.toContain('route-toolbar__cap');
    });

    it('машинных файлов нет — строка о них молчит, а не печатает ноль', () => {
        // Крупный ручной рефакторинг без генерённых файлов: бюджет выбросил обычные файлы.
        const html = render({ cap: { filesCovered: 199, filesTotal: 200, machineFiles: 0, truncated: true } });

        expect(html).toContain('план покрывает 199 файлов из 200');
        expect(html).not.toContain('машинных');
    });

    it('без маршрута обе опции выключены и объясняют почему', () => {
        const html = render({ disabled: true });

        expect(html).toContain(`disabled="" title="${t(PRESET_DISABLED_TITLE)}"`);
        expect(count(html, t(PRESET_DISABLED_TITLE))).toBe(2);
        // Активная опция остаётся видимой: выключен переключатель, а не состояние.
        expect(html).toContain('route-preset__option is-active" aria-pressed="true" disabled=""');
        expect(render()).not.toContain(t(PRESET_DISABLED_TITLE));
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
