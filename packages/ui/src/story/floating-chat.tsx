import type { PointerEvent, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { readingTop } from './reading-position.js';

interface Point { x: number; y: number }
const MARGIN = 16;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** Немодальный чат: не меняет ширину диффа, положение чтения и доступность остального UI. */
export function FloatingChat({ open, onClose, children }: {
    open: boolean; onClose: () => void;
    children: (controls: { headerActions: ReactNode }) => ReactNode;
}) {
    const t = useT();
    const [expanded, setExpanded] = useState(false);
    const [position, setPosition] = useState<Point | null>(null);
    const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight, top: readingTop() }));
    const drag = useRef<(Point & { pointerId: number; origin: Point }) | null>(null);
    useLayoutEffect(() => {
        if (!open) return;
        const measure = () => {
            const next = { width: window.innerWidth, height: window.innerHeight, top: readingTop() };
            setViewport((previous) => previous.width === next.width && previous.height === next.height && previous.top === next.top ? previous : next);
        };
        measure();
        const observer = new ResizeObserver(measure);
        const bar = document.querySelector('.story-preparation');
        if (bar !== null) observer.observe(bar);
        window.addEventListener('resize', measure);
        return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
    }, [open]);
    if (!open) return null;
    const width = Math.max(240, Math.min(expanded ? 880 : 560, viewport.width - MARGIN * 2));
    const height = Math.max(200, Math.min(expanded ? 840 : 680, viewport.height - viewport.top - MARGIN * 2));
    const x = clamp(position?.x ?? viewport.width - width - 24, MARGIN, viewport.width - width - MARGIN);
    const y = clamp(position?.y ?? viewport.height - height - 24, viewport.top + MARGIN, viewport.height - height - MARGIN);
    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return <div className="story-chat" role="dialog" aria-modal={false} aria-label={t('chat.aria')} data-expanded={expanded}
        style={{ left: x, top: y, width, height }}
        onKeyDownCapture={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } }}
        onPointerDownCapture={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.button !== 0 || target?.closest('.chat-panel__header') == null || target.closest('button,summary,a,input,textarea') !== null) return;
            event.preventDefault();
            drag.current = { x: event.clientX, y: event.clientY, origin: { x, y }, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
            const current = drag.current;
            if (current?.pointerId !== event.pointerId) return;
            setPosition({ x: clamp(current.origin.x + event.clientX - current.x, MARGIN, viewport.width - width - MARGIN),
                y: clamp(current.origin.y + event.clientY - current.y, viewport.top + MARGIN, viewport.height - height - MARGIN) });
        }}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }}>
        {children({ headerActions: <button type="button" className="ctl ctl--toolbar-icon chat-panel__resize" aria-label={t(expanded ? 'chat.restore' : 'chat.expand')} title={t(expanded ? 'chat.restore' : 'chat.expand')} onClick={() => { setExpanded((value) => !value); }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={expanded ? 'M8 3v5H3m13 13v-5h5M8 8 3 3m13 13 5 5' : 'M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7'} /></svg>
        </button> })}
    </div>;
}
