import { useEffect, useEffectEvent } from 'react';
import type { RefObject } from 'react';
import { readingTop } from './reading-position.js';

/** Пассивно отмечает читаемую часть ленты: не двигает фокус, выделение и позицию. */
export function useGuideScroll(root: RefObject<HTMLElement | null>, enabled: boolean, onActive: (page: string) => void) {
    const active = useEffectEvent(onActive);
    useEffect(() => {
        const element = root.current;
        if (!enabled || element === null) return;
        let frame = 0;
        const update = () => {
            const markers = [...element.querySelectorAll<HTMLElement>('[data-guide-page]')];
            const top = readingTop() + 1;
            let current = markers[0];
            for (const marker of markers) {
                if (marker.getBoundingClientRect().top > top) break;
                current = marker;
            }
            // Последний короткий файл может не достичь верхней границы окна.
            const last = markers.at(-1);
            if (last !== undefined && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2 && last.getBoundingClientRect().top < window.innerHeight) current = last;
            if (current?.dataset.guidePage !== undefined) active(current.dataset.guidePage);
        };
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
        const resize = new ResizeObserver(schedule);
        resize.observe(element);
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        schedule();
        return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
    }, [root, enabled]);
}
