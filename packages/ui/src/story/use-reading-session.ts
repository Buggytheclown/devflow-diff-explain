import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { CodeLocation } from '@sherpa/protocol';

import type { ReadingPosition } from './reading-position.js';
import { capturePosition, restorePosition, revealCode, revealGuidePage, readingFocus } from './reading-position.js';
import type { ReadingRequest, ReturnPoint, StoryMemory } from './reading-state.js';
import { storyMemory, returnForSnapshot } from './reading-state.js';
import { readPositions, writeCache } from './reading-cache.js';

/** Память принадлежит вкладке, а не удаляемым компонентам документа и файла. */
export function useReadingSession(root: RefObject<HTMLElement | null>, scope: string, storyKey: string | null, initialPage?: string) {
    const focuses = useRef(new Map<string, string>());
    const [initialPositions] = useState(() => new Map<string, ReadingPosition>(readPositions()));
    const positions = useRef(initialPositions);
    const stories = useRef(new Map<string, StoryMemory>());
    const [origin, setOrigin] = useState<ReturnPoint | null>(null);
    const [expansions, setExpansions] = useState<Record<string, ReadonlySet<string>>>({});
    const pending = useRef<ReadingRequest | null>(null);
    const epoch = useRef(0);
    const loading = useRef(false);
    const previousStory = useRef(storyKey);
    const [, redraw] = useState(0);
    const saved = (key: string): StoryMemory => {
        let memory = stories.current.get(key);
        if (memory === undefined) { memory = storyMemory(); stories.current.set(key, memory); }
        return memory;
    };
    const capture = (): void => {
        if (root.current === null || pending.current !== null) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.current.contains(active)) {
            const address = readingFocus(active);
            if (address !== undefined) focuses.current.set(scope, address);
        }
        const position = capturePosition(root.current);
        if (position !== null) { positions.current.set(scope, position); writeCache('positions', [...positions.current].slice(-100)); }
        if (storyKey !== null && scope === storyKey) {
            const memory = saved(storyKey);
            memory.position = position;
            memory.focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.readingFocus ?? null : null;
        }
    };
    const begin = (): number => { capture(); pending.current = null; loading.current = true; return ++epoch.current; };
    const restore = (target: string, requestEpoch: number, focus: string | null = null, restoreFocus = true, memoryKey = target): void => {
        loading.current = false;
        pending.current = { kind: 'restore', epoch: requestEpoch, scope: target, position: positions.current.get(memoryKey) ?? null, focus: restoreFocus ? focuses.current.get(memoryKey) ?? focus : null };
        redraw((n) => n + 1);
    };
    // Догрузка и смена оформления сохраняют место, но не отбирают текущий фокус.
    const preserve = (): void => { if (pending.current !== null || loading.current) return; const id = begin(); restore(scope, id, null, false); };
    const relayout = (): void => { if (pending.current === null && !loading.current) restore(scope, ++epoch.current, null, false); };
    useLayoutEffect(() => {
        if (previousStory.current !== storyKey) {
            previousStory.current = storyKey;
            const position = positions.current.get(scope);
            pending.current = position === undefined && initialPage !== undefined && initialPage !== 'intro' ? { kind: 'jump', scope, epoch: ++epoch.current, page: initialPage, focus: null } : { kind: 'restore', scope, epoch: ++epoch.current, position: position ?? null, focus: null };
        }
        const request = pending.current;
        if (request?.scope !== scope || root.current === null || request.epoch !== epoch.current) return;
        const applied = request.kind === 'code' ? revealCode(root.current, request.location)
            : request.kind === 'jump' ? revealGuidePage(root.current, request.page) : request.position === null ? (window.scrollTo({ top: 0, behavior: 'instant' }), true) : restorePosition(root.current, request.position);
        if (!applied && (root.current.querySelector('[data-reading-wait]') !== null || root.current.querySelector('[role="alert"]') === null)) return;
        pending.current = null;
        const actual = capturePosition(root.current);
        if (actual !== null) positions.current.set(scope, actual);
        if (request.focus !== null) {
            const target = [...root.current.querySelectorAll<HTMLElement>('[data-reading-focus], .diff-row[data-key]')]
                .find((element) => readingFocus(element) === request.focus);
            // Программный возврат фокуса не должен заменять сохранённое выделение одним рядом.
            if (target !== undefined) { target.dataset.restoringFocus = 'true'; target.focus({ preventScroll: true }); delete target.dataset.restoringFocus; }
        }
    });
    useEffect(() => {
        let frame = 0;
        const scroll = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
        const cancel = (): void => { if (pending.current !== null || loading.current) { pending.current = null; loading.current = false; ++epoch.current; } };
        const key = (event: KeyboardEvent): void => { if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '].includes(event.key) && !(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) cancel(); };
        window.addEventListener('scroll', scroll, { passive: true });
        window.addEventListener('wheel', cancel, { passive: true });
        window.addEventListener('touchmove', cancel, { passive: true });
        window.addEventListener('keydown', key);
        return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', scroll); window.removeEventListener('wheel', cancel); window.removeEventListener('touchmove', cancel); window.removeEventListener('keydown', key); };
    });
    useEffect(() => {
        const resize = relayout;
        window.addEventListener('resize', resize);
        return () => { window.removeEventListener('resize', resize); };
    });
    return { saved,
        bookmark: (key: string) => { capture(); const position = positions.current.get(scope); if (position !== undefined) positions.current.set(key, position); const focus = focuses.current.get(scope); if (focus !== undefined) focuses.current.set(key, focus); },
        jump: (target: string, id: number, page: string) => {
            loading.current = false;
            pending.current = { kind: 'jump', epoch: id, scope: target, page, focus: page.startsWith('file:') ? page : `block:${page}` }; redraw((n) => n + 1);
        },
        origin: returnForSnapshot(origin, storyKey), setOrigin, capture, begin, restore, preserve, relayout,
        expanded: storyKey === null ? undefined : expansions[storyKey],
        isPending: () => pending.current !== null || loading.current,
        isCurrent: (id: number) => id === epoch.current,
        cancel: () => { pending.current = null; loading.current = false; ++epoch.current; },
        code: (target: string, id: number, location: CodeLocation) => {
            loading.current = false;
            pending.current = { kind: 'code', epoch: id, scope: target, location, focus: null }; redraw((n) => n + 1);
        },
        ready: () => { redraw((n) => n + 1); },
        toggle: (section: string) => {
            if (storyKey === null) return;
            preserve();
            setExpansions((value) => {
                const next = new Set(value[storyKey]);
                if (!next.delete(section)) next.add(section);
                return { ...value, [storyKey]: next };
            });
        },
    };
}
