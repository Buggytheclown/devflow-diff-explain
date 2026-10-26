import type { TourRing as TourRingGeometry } from './placement.js';

/**
 * Кольцо вокруг подсвеченного элемента (docs/design/SPEC-onboarding-2026-09-02.md §1). Ничего не перехватывает:
 * `pointer-events: none`, клик по обведённому элементу работает и тур не закрывает (§4).
 */
export function TourRing({ ring }: { ring: TourRingGeometry }) {
    return (
        <div
            className="tour-ring"
            aria-hidden="true"
            style={{
                left: `${String(Math.round(ring.left))}px`,
                top: `${String(Math.round(ring.top))}px`,
                width: `${String(Math.round(ring.width))}px`,
                height: `${String(Math.round(ring.height))}px`,
            }}
        />
    );
}
