import type { FileContent } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, expandGap, gapKeyOf } from '../diff-view/expand.js';
import type { LineSelection } from '../diff-view/selection.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import {
    calculateSelectionPopoverPosition,
    chatAnchorFromSelection,
    SelectionPopover,
    selectionAskDisabled,
    selectionScrolledPast,
} from './selection-popover.tsx';

const DIFF_ID = 'iter-1';
const FILE = {
    fileId: 'f1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify' as const,
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    patch: ['@@ -10,3 +10,5 @@', ' keep', '-old', '+new', '+extra', ' tail', ''].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const SELECTION: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'a11', focus: 'a12' };
describe('Selection popover', () => {
    it('ставится под диапазоном и переворачивается над ним у низа вьюпорта', () => {
        const base = {
            host: { top: 20, left: 100, width: 800, scrollTop: 300, scrollLeft: 0 },
            selection: { top: 200, bottom: 240, left: 220, right: 620 },
            popover: { width: 360, height: 44 },
            viewportHeight: 700,
        };

        expect(calculateSelectionPopoverPosition(base)).toEqual({ left: 140, top: 528, placement: 'below' });
        expect(
            calculateSelectionPopoverPosition({
                ...base,
                selection: { ...base.selection, top: 640, bottom: 680 },
            }),
        ).toEqual({ left: 140, top: 868, placement: 'above' });
        expect(calculateSelectionPopoverPosition({ ...base, gap: 120 }).top).toBe(580);
    });

    it('не заходит под липкий тулбар и плавающую панель действий', () => {
        const base = {
            host: { top: 20, left: 100, width: 800, scrollTop: 300, scrollLeft: 0 },
            selection: { top: 580, bottom: 600, left: 220, right: 620 },
            popover: { width: 360, height: 44 },
            viewportHeight: 700,
            viewportTop: 50,
            viewportBottom: 631,
        };

        expect(calculateSelectionPopoverPosition(base)).toEqual({ left: 140, top: 808, placement: 'above' });
        expect(
            calculateSelectionPopoverPosition({
                ...base,
                selection: { ...base.selection, top: 60, bottom: 80 },
                viewportBottom: 100,
            }),
        ).toEqual({ left: 140, top: 338, placement: 'above' });
    });

    it('закрывается только после прокрутки дальше 200px от позиции открытия', () => {
        expect(selectionScrolledPast(500, 300)).toBe(false);
        expect(selectionScrolledPast(500, 299)).toBe(true);
        expect(selectionScrolledPast(500, 701)).toBe(true);
    });

    it('собирает контрактный anchor из стороны и диапазона выделения', () => {
        expect(chatAnchorFromSelection(FILE, MODEL, SELECTION, DIFF_ID)).toEqual({
            diffId: DIFF_ID,
            fileId: 'f1',
            path: 'src/cache.ts',
            side: 'new',
            start: 11,
            end: 12,
        });
        expect(chatAnchorFromSelection(FILE, MODEL, { ...SELECTION, fileId: 'other' }, DIFF_ID)).toBeNull();
    });

    it('считает раскрытые строки по модели, которую рисует карточка', () => {
        if (MODEL.content.kind !== 'text') {
            throw new Error('тесту нужна текстовая модель');
        }
        const gap = MODEL.content.blocks.find((block) => block.kind === 'gap' && block.edge === 'leading');
        if (gap?.kind !== 'gap') {
            throw new Error('тесту нужен ведущий пропуск');
        }
        const lines = Array.from({ length: 20 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: lines.join('\n'), newText: lines.join('\n') };
        const expanded = expandFileContext(MODEL, content, expandGap(new Map(), gapKeyOf(gap), 'up', 2));
        const selection: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'c8:8', focus: 'c9:9' };

        expect(chatAnchorFromSelection(FILE, MODEL, selection, DIFF_ID)).toBeNull();
        expect(chatAnchorFromSelection(FILE, expanded, selection, DIFF_ID)).toEqual({
            diffId: DIFF_ID,
            fileId: FILE.fileId,
            path: FILE.path,
            side: 'new',
            start: 8,
            end: 9,
        });
        expect(
            renderToStaticMarkup(
                <SelectionPopover
                    host={null}
                    diffId={DIFF_ID}
                    file={FILE}
                    model={expanded}
                    selection={selection}
                    dragging={false}
                    agentConnected
                    onAsk={() => undefined}
                    onComment={() => undefined}
                    onClear={() => undefined}
                    gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
                />,
            ),
        ).toContain('2 строки выделены');
    });

    it('считает диапазон маршрута только по строкам среза карточки', () => {
        const routeFile = {
            ...FILE,
            patch: ['@@ -1,10 +1,10 @@', ' one', '-old-2', '+new-2', ' three', ' four', ' five', ' six', ' seven', ' eight', '-old-9', '+new-9', ' ten'].join('\n'),
        };
        const raw = parseFileDiff(routeFile);
        const clipped = clipModelToAnchors(
            raw,
            [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 9, end: 9 },
            ],
            0,
        ).model;
        const selection: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'a2', focus: 'a9' };
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={routeFile}
                model={clipped}
                selection={selection}
                dragging={false}
                agentConnected
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('2 строки выделены');
        expect(html).not.toContain('9 строк выделено');
    });

    it('реальный нетерминальный обмен с тем же якорем сжимает поповер в чип', () => {
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected
                inFlight
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'sent', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('спрошено · ответ появится здесь');
        expect(html).not.toContain('Вопрос агенту по выделению');
    });

    it('при отключённом агенте блокирует только вопрос и ставит точный title', () => {
        expect(selectionAskDisabled(false)).toBe(true);
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected={false}
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="Переподключите агента, чтобы спросить о выделении"');
        expect(html).toContain('Комментировать');
        expect(html).toContain('Скопировать ссылку');
    });

    it('своя причина запрета выигрывает у подключённого агента и объясняет себя в title', () => {
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected
                askDisabledReason="в срезе вопрос не привязать к файлу"
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('title="в срезе вопрос не привязать к файлу"');
        expect(html).not.toContain('title="Переподключите агента, чтобы спросить о выделении"');
    });
});
