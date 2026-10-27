import type { CodeLocation } from '@sherpa/protocol';
import { useRef } from 'react';

type Range = Pick<CodeLocation, 'side' | 'start' | 'end'>;

/** Shift сохраняет исходную границу, даже когда диапазон несколько раз меняет направление. */
export function useLineRange(selected: Range | null) {
    const anchor = useRef<{ side: Range['side']; line: number } | null>(null);
    const fromText = (side: Range['side'], first: number, last: number): Range => {
        anchor.current = { side, line: first };
        return { side, start: Math.min(first, last), end: Math.max(first, last) };
    };
    const choose = (side: Range['side'], line: number, extend = false): Range => {
        const first = extend && selected?.side === side
            ? anchor.current?.side === side ? anchor.current.line : selected.start
            : line;
        return fromText(side, first, line);
    };
    return { choose, fromText };
}
