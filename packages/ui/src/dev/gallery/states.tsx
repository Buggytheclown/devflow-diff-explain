import type { ReactNode } from 'react';
import { STORY_STATES, GUIDED_STORY_STATES } from './story-states.tsx';

export interface GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

/** Только состояния приложения объяснения; сохранённые форматы рассказа входят в приёмку. */
export const GALLERY_STATES: readonly GalleryState[] = [...STORY_STATES, ...GUIDED_STORY_STATES];
