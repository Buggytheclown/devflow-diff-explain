import { fixtureIteration } from '@sherpa/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchReviewDiff } from '../api.js';
import { createDiffClient } from '../diff/client.js';
import { parseFileDiff } from '../diff/parse.js';
import { toParseRequest } from '../diff/model.js';
import { createStoryData } from './data.js';

vi.mock('../api.js', () => ({ fetchReviewDiff: vi.fn() }));
vi.mock('../diff/client.js', () => ({ createDiffClient: vi.fn() }));
const diff = fixtureIteration('medium').diff;
const file = diff.files[0];
if (file === undefined) throw new Error('Missing fixture');
const model = parseFileDiff(toParseRequest(file));
afterEach(() => { vi.resetAllMocks(); });

describe('память данных читателя', () => {
    it('изолирует версии и удаляет только неудачную загрузку, разрешая локальный повтор', async () => {
        const fetch = vi.mocked(fetchReviewDiff);
        fetch.mockResolvedValueOnce(diff).mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ ...diff, diffId: 'next' });
        const data = createStoryData('token');
        expect(await data.diff(null)).toBe(diff);
        expect(await data.diff(diff.diffId)).toBe(diff);
        await expect(data.diff('next')).rejects.toThrow('temporary');
        expect((await data.diff('next')).diffId).toBe('next');
        expect(fetch).toHaveBeenCalledTimes(3);
        data.updateFile(diff.diffId, file.fileId, { model });
        expect(data.file(diff.diffId, file.fileId).model).toBe(model);
        expect(data.file('next', file.fileId).model).toBeNull();
    });
    it('освобождает воркер и допускает новый setup после cleanup StrictMode', async () => {
        const close = vi.fn();
        vi.mocked(createDiffClient).mockImplementation(() => ({ close, parseFile: vi.fn().mockResolvedValue(model) }));
        const data = createStoryData('token');
        data.close();
        expect(await data.parse(diff.diffId, file)).toBe(model);
        data.close();
        expect(close).toHaveBeenCalledOnce();
        expect(await data.parse(diff.diffId, file)).toBe(model);
        expect(createDiffClient).toHaveBeenCalledTimes(2);
        data.close();
    });
});
