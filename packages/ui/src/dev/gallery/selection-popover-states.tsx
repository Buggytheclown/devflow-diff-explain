import type { FileDiff } from '@sherpa/protocol';

import { SelectionPopover } from '../../components/selection-popover.tsx';
import { parseFileDiff } from '../../diff/parse.js';
import type { LineSelection } from '../../diff-view/selection.js';

const DIFF_ID = 'gallery-iteration';
const FILE: FileDiff = {
    fileId: 'gallery-selection-file',
    path: 'src/review/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    image: null,
    patch: ['@@ -40,3 +40,5 @@', ' const cached = readCache(key);', '-return cached;', '+if (cached !== null) {', '+    return cached;', '+}', ' return load(key);', ''].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const SELECTION: LineSelection = {
    fileId: FILE.fileId,
    side: 'new',
    anchor: 'a41',
    focus: 'a43',
};
export const SELECTION_POPOVER_STATES = [
    { id: 'selection-popover-rest', title: 'покой', render: () => <PopoverState mode="rest" connected /> },
    { id: 'selection-popover-disabled', title: 'агент отключён', render: () => <PopoverState mode="rest" connected={false} /> },
    { id: 'selection-popover-in-flight', title: 'вопрос в работе', render: () => <PopoverState mode="sent" connected /> },
] as const;

function PopoverState({ mode, connected }: { mode: 'rest' | 'sent'; connected: boolean }) {
    return (
        <div className="gallery-selection-popover selection-popover-host">
            <div className="gallery-selection-popover__card">
                <div className="gallery-selection-popover__header">cache.ts</div>
                <div className="gallery-selection-popover__row">40&nbsp;&nbsp; const cached = readCache(key);</div>
                <div className="gallery-selection-popover__row is-selected">41 + if (cached !== null) &#123;</div>
                <div className="gallery-selection-popover__row is-selected">42 + &nbsp;&nbsp;&nbsp; return cached;</div>
                <div className="gallery-selection-popover__row is-selected">43 + &#125;</div>
                <div className="gallery-selection-popover__row">44&nbsp;&nbsp; return load(key);</div>
            </div>
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected={connected}
                inFlight={mode === 'sent'}
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode, position: { left: 130, top: 142 } }}
            />
        </div>
    );
}
