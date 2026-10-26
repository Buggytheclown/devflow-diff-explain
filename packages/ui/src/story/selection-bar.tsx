import type { UiChatAskAnchor } from '@sherpa/protocol';

import { useLocale } from '../i18n/index.js';
import { storyCopy } from '../i18n/story.js';

export function SelectionBar({ selected, onAsk, onClear }: { selected: Pick<UiChatAskAnchor, 'start' | 'end'>; onAsk: () => void; onClear: () => void }) {
    const t = storyCopy[useLocale()];
    return <div className="story-selection" role="toolbar" aria-label={t.selected}>
        <span>{t.selected} · {selected.start}–{selected.end}</span>
        <button className="ctl" onClick={onAsk}>{t.askLines}</button>
        <button className="ctl" onClick={onClear}>{t.clearSelection}</button>
    </div>;
}
