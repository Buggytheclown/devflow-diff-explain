import type { ExplanationBlock, ReadableExample, GuidedFile, StoryEvidenceBlock, FlowState } from '@sherpa/protocol';

/** Принятый план и заполнение не зависят от модели ревью. */
export interface AcceptedExplanation {
    summary: string; storyContractVersion: 2 | 3 | 4 | 5 | 6; summaryEvidence: StoryEvidenceBlock; flow?: FlowState;
    stops: ExplanationBlock[]; tourOrder: string[]; intents: Map<number, string>;
}
export interface ExplanationFilling {
    planIndex: number; paragraph: string | null; storyEvidence?: StoryEvidenceBlock; partial?: boolean;
    guidedFiles?: GuidedFile[]; example?: ReadableExample | null;
}
