// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { UiChatAskAnchor } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { AnchorSpan } from './anchor-clip.js';
import type { MarginStripActions } from './route-margin.tsx';
import { useMarginStrips } from './route-margin.tsx';

/**
 * Точка входа «попросить агента разложить» у штрихованной полосы (docs/design/README.md §10): якорь —
 * ровно диапазон полосы, вопрос в полёте заменяет кнопку чипом, отключённый агент её гасит.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path.endsWith('.ts'));
    if (file === undefined) {
        throw new Error('фикстуре medium нужен текстовый файл');
    }
    return file;
})();
const MODEL: DiffFileModel = parseFileDiff(toParseRequest(FILE));
const SPAN: AnchorSpan = (() => {
    if (MODEL.content.kind !== 'text') {
        throw new Error('нужен текстовый патч');
    }
    for (const block of MODEL.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null) {
                return { side: 'new', start: line.newLine, end: line.newLine };
            }
        }
    }
    throw new Error('в патче нет добавленных строк');
})();

function Strip({ actions }: { readonly actions: MarginStripActions }) {
    const strips = useMarginStrips({
        model: MODEL,
        rowsShown: true,
        ranges: [SPAN],
        file: { fileId: FILE.fileId, path: FILE.path },
        actions,
    });
    return <>{strips.renderAfterLine(SPAN.side, SPAN.end)}</>;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(actions: MarginStripActions): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Strip actions={actions} />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

const NOT_PENDING = (): boolean => false;

describe('точка входа штрихованной полосы', () => {
    it('отдаёт якорь ровно на диапазон полосы', () => {
        const onAskToPlace = vi.fn<(anchor: UiChatAskAnchor) => void>();
        const host = render({ agentConnected: true, isPending: NOT_PENDING, onAskToPlace });

        const button = host.querySelector<HTMLButtonElement>('.route-strip__action');
        expect(button?.textContent).toBe('Попросить агента разложить');
        expect(button?.title).toBe('ответ придёт в чат, маршрут не изменится');
        act(() => {
            button?.click();
        });

        expect(onAskToPlace).toHaveBeenCalledWith({
            fileId: FILE.fileId,
            path: FILE.path,
            side: SPAN.side,
            start: SPAN.start,
            end: SPAN.end,
        });
    });

    it('вопрос в полёте заменяет кнопку чипом', () => {
        const host = render({
            agentConnected: true,
            isPending: (anchor) => anchor.start === SPAN.start,
            onAskToPlace: () => undefined,
        });

        expect(host.querySelector('button')).toBeNull();
        expect(host.querySelector('.route-strip__chip')?.textContent).toBe('спрошено · ответ появится здесь');
        expect(host.textContent).toContain('без остановки маршрута');
    });

    it('отключённый агент гасит кнопку, но подпись полосы остаётся', () => {
        const host = render({ agentConnected: false, isPending: NOT_PENDING, onAskToPlace: () => undefined });

        const button = host.querySelector<HTMLButtonElement>('.route-strip__action');
        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe('Переподключите агента, чтобы спросить об этих строках');
        expect(host.textContent).toContain('без остановки маршрута');
    });

    it('без действия полоса остаётся подписью — в маршруте кнопки нет', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        function Plain() {
            const strips = useMarginStrips({ model: MODEL, rowsShown: true, ranges: [SPAN] });
            return <>{strips.renderAfterLine(SPAN.side, SPAN.end)}</>;
        }
        act(() => {
            root.render(<Plain />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.querySelector('button')).toBeNull();
        expect(host.querySelector('.route-strip')).not.toBeNull();
    });
});
