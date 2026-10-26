import type { CodeLocation } from '@sherpa/protocol';

import type { ReadingPosition } from './reading-position.js';

export interface StoryMemory { position: ReadingPosition | null; focus: string | null }
export interface DiffMemory { fileId: string | null; query: string }
export interface ReturnPoint { storyKey: string; sectionId: string; focus: string | null }
export type ReadingRequest = { epoch: number; scope: string; focus: string | null } & (
    { kind: 'restore'; position: ReadingPosition | null } | { kind: 'code'; location: CodeLocation }
);

export function storyMemory(): StoryMemory { return { position: null, focus: null }; }
export function returnForSnapshot(point: ReturnPoint | null, storyKey: string | null): ReturnPoint | null {
    return point === null || storyKey === null || point.storyKey === storyKey ? point
        : { storyKey, sectionId: 'intro', focus: null };
}
