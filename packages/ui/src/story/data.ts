import type { FileDiff, PrDiff, UiChatAskAnchor } from '@sherpa/protocol';

import { fetchReviewDiff } from '../api.js';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import type { DiffMemory } from './reading-state.js';

export interface SavedFile { model: DiffFileModel | null; selected: UiChatAskAnchor | null }
export function createStoryData(token: string) {
    let client: DiffClient | null = null;
    const diffs = new Map<string, Promise<PrDiff>>();
    const files = new Map<string, SavedFile>();
    const views = new Map<string, DiffMemory>();
    return {
        diff: (id: string | null): Promise<PrDiff> => {
            const key = id ?? 'active';
            let promise = diffs.get(key);
            if (promise === undefined) {
                promise = fetchReviewDiff(token, { diffId: id }).then((diff) => {
                    diffs.set(diff.diffId, Promise.resolve(diff)); return diff;
                }, (error: unknown) => { diffs.delete(key); throw error; });
                diffs.set(key, promise);
            }
            return promise;
        },
        parse: (diffId: string, file: FileDiff) => (client ??= createDiffClient()).parseFile(diffId, toParseRequest(file)),
        file: (diffId: string, fileId: string): SavedFile => {
            const key = `${diffId}:${fileId}`;
            let state = files.get(key);
            if (state === undefined) { state = { model: null, selected: null }; files.set(key, state); }
            return state;
        },
        view: (diffId: string): DiffMemory => {
            let state = views.get(diffId);
            if (state === undefined) { state = { fileId: null, query: '' }; views.set(diffId, state); }
            return state;
        },
        updateFile: (diffId: string, fileId: string, patch: Partial<SavedFile>) => {
            const key = `${diffId}:${fileId}`;
            files.set(key, { model: null, selected: null, ...files.get(key), ...patch });
        },
        updateView: (diffId: string, patch: Partial<DiffMemory>) => {
            views.set(diffId, { fileId: null, query: '', ...views.get(diffId), ...patch });
        },
        close: () => { client?.close(); client = null; },
    };
}
export type StoryData = ReturnType<typeof createStoryData>;
