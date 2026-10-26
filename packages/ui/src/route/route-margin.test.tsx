import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteMarginFile } from './margin-model.js';
import { RouteBadge, useMarginStrips } from './route-margin.tsx';

/** Разметка полей маршрута: бейджи обоих видов и штриховка, включая честную деградацию. */

const DATA = fixtureIteration('medium');

function modelOf(path: string): DiffFileModel {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре нет файла ${path}`);
    }
    return parseFileDiff(toParseRequest(file));
}

function marginFile(patch: Partial<RouteMarginFile> = {}): RouteMarginFile {
    return {
        fileId: 'f1',
        stops: [{ stopId: 's02', planLabel: '02', title: 'кэш сбрасывается после записи' }],
        uncovered: [],
        uncoveredLines: 0,
        parsed: true,
        changed: true,
        ...patch,
    };
}

function Strips({
    model,
    rowsShown,
    ranges,
    line,
}: {
    model: DiffFileModel | null;
    rowsShown: boolean;
    ranges: readonly AnchorSpan[];
    line: { side: 'old' | 'new'; number: number };
}) {
    const strips = useMarginStrips({ model, rowsShown, ranges });
    return (
        <>
            {strips.underHeader}
            {strips.renderAfterLine(line.side, line.number)}
        </>
    );
}

describe('поля маршрута в разметке', () => {
    it('бейдж карточки — кнопка с озвученной целью', () => {
        const html = renderToStaticMarkup(
            <RouteBadge file={marginFile()} otherStopId="other" variant="card" onJump={() => undefined} />,
        );

        expect(html).toContain('<button');
        expect(html).toContain('объяснено в 02 · кэш сбрасывается после записи');
        expect(html).toContain('aria-label="Объяснено в остановке 02 · кэш сбрасывается после записи — перейти"');
        expect(html).not.toContain('route-badge--hatched');
    });

    it('метка дерева озвучивается номером: заголовок остановки не читается раньше имени файла', () => {
        const html = renderToStaticMarkup(
            <RouteBadge
                file={marginFile({
                    stops: [
                        { stopId: 's02', planLabel: '02', title: 'кэш сбрасывается после записи' },
                        { stopId: 's05', planLabel: '05', title: 'инвалидация индекса' },
                    ],
                })}
                otherStopId="other"
                variant="tree"
                onJump={() => undefined}
            />,
        );

        expect(html).toContain('aria-label="остановка 02"');
        // Перечень остановок никуда не делся — он в тултипе.
        expect(html).toContain('Объяснено в остановках 02, 05 · кэш сбрасывается после записи — перейти');
    });

    it('без обработчика перехода бейдж остаётся подписью', () => {
        const html = renderToStaticMarkup(
            <RouteBadge file={marginFile()} otherStopId="other" variant="tree" />,
        );

        expect(html).not.toContain('<button');
        expect(html).toContain('<span class="route-badge route-badge--tree"');
        expect(html).toContain('>02<');
    });

    it('штриховка в дереве говорит фоном и тултипом, текста в метке нет, ведёт к «Прочему»', () => {
        const html = renderToStaticMarkup(
            <RouteBadge
                file={marginFile({ stops: [] })}
                otherStopId="other"
                variant="tree"
                onJump={() => undefined}
            />,
        );

        expect(html).toContain('route-badge--hatched');
        // Метка 17×13 текста не вмещает: причина остаётся в тултипе.
        expect(html).toContain('Без остановки маршрута — перейти к «Прочему»');
        expect(html).toMatch(/><\/button>$/);
        expect(html).toContain('tabindex="-1"');
    });

    it('файл без изменённых строк бейджа не получает вовсе', () => {
        expect(
            renderToStaticMarkup(
                <RouteBadge
                    file={marginFile({ stops: [], changed: false })}
                    otherStopId="other"
                    variant="card"
                    onJump={() => undefined}
                />,
            ),
        ).toBe('');
    });

    it('полоса встаёт под последней строкой диапазона', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const range = firstChangedLine(model);
        const html = renderToStaticMarkup(
            <Strips
                model={model}
                rowsShown
                ranges={[{ side: range.side, start: range.line, end: range.line }]}
                line={{ side: range.side, number: range.line }}
            />,
        );

        expect(html).toContain('route-strip');
        expect(html).toContain(`строка ${String(range.line)} без остановки маршрута`);
    });

    it('строки на экране нет — диапазоны уходят в один свод, а не пропадают', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const html = renderToStaticMarkup(
            <Strips
                model={model}
                rowsShown={false}
                ranges={[
                    { side: 'new', start: 18, end: 26 },
                    { side: 'old', start: 4, end: 4 },
                ]}
                line={{ side: 'new', number: 26 }}
            />,
        );

        expect(html).toContain('10 строк без остановки маршрута');
        expect(count(html, 'route-strip"')).toBe(1);
    });
});

function firstChangedLine(model: DiffFileModel): { side: 'old' | 'new'; line: number } {
    if (model.content.kind !== 'text') {
        throw new Error('нужен текстовый патч');
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null) {
                return { side: 'new', line: line.newLine };
            }
            if (line.kind === 'del' && line.oldLine !== null) {
                return { side: 'old', line: line.oldLine };
            }
        }
    }
    throw new Error('в патче нет изменённых строк');
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
