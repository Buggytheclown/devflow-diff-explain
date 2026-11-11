// @vitest-environment jsdom
import type { CodeLocation, FileContent, FileDiff } from '@sherpa/protocol';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Api from '../api.js';
import { downloadFileOriginal, fetchFileContent } from '../api.js';
import { parseFileDiff } from '../diff/parse.js';
import { toParseRequest } from '../diff/model.js';
import * as expansion from '../diff-view/expand.js';
import { createStoryData } from './data.js';
import { ReadFile } from './read-file.tsx';

vi.mock('../api.js', async (original) => ({ ...await original<typeof Api>(), fetchFileContent: vi.fn(), downloadFileOriginal: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = architectureStoryFixture().first;
const file: FileDiff = { ...fixture, fileId: 'file-a', path: 'a.ts', oldPath: null, binary: false, image: null,
    changeType: 'modify', additions: 1, deletions: 1, patch: '@@ -2,1 +2,1 @@\n-before\n+after\n' };
const content: FileContent = { oldText: 'first\nbefore\ntail\n', newText: 'first\nafter\ntail\n' };
const noop = () => undefined;
let host: HTMLDivElement;
let root: Root | null = null;
afterEach(async () => {
    if (root !== null) await act(async () => { root?.unmount(); await Promise.resolve(); });
    root = null; host.remove(); vi.restoreAllMocks(); vi.mocked(fetchFileContent).mockReset(); vi.mocked(downloadFileOriginal).mockReset();
});
function setup() {
    const onSelect = vi.fn();
    const data = { ...createStoryData('test'), parse: vi.fn((_diffId: string, entry: FileDiff) => Promise.resolve(parseFileDiff(toParseRequest(entry)))) };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    return { data, onSelect, render: async (entry = file, diffId = 'a', navigation?: CodeLocation) => {
        await act(async () => { root?.render(<ReadFile file={entry} diffId={diffId} data={data} token="test" originals navigation={navigation} onSelect={onSelect} onLayout={noop} />); await Promise.resolve(); });
    } };
}
async function click(selector: string) {
    const button = host.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); await Promise.resolve(); });
}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('локальное чтение и повтор файла', () => {
    it('сохраняет готовый дифф при ошибке оригинала и повторяет загрузку контекста', async () => {
        vi.mocked(fetchFileContent).mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(content);
        const { data, render } = setup(); await render();
        const before = data.file('a', file.fileId).model;
        await click('.story-file-expand');
        expect(host.querySelector('[role=alert]')?.textContent).toContain('network failed');
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
        expect(data.file('a', file.fileId).model).toBe(before);
        await click('[role=alert] button');
        expect(fetchFileContent).toHaveBeenCalledTimes(2);
        expect(data.parse).toHaveBeenCalledTimes(1);
        expect(host.querySelector('[role=alert]')).toBeNull();
        expect(host.querySelector('[data-key="c3:3"]')?.textContent).toContain('tail');
    });

    it('перехватывает исключение преобразования и повторяет ту же операцию', async () => {
        vi.mocked(fetchFileContent).mockResolvedValue(content);
        const { render } = setup(); await render();
        const transform = vi.spyOn(expansion, 'expandFileContext').mockImplementationOnce(() => { throw new Error('transform failed'); });
        await click('.story-file-expand');
        expect(host.querySelector('[role=alert]')?.textContent).toContain('transform failed');
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
        await click('[role=alert] button');
        expect(transform).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[role=alert]')).toBeNull();
    });

    it('показывает отсутствие оригинала и позволяет повторить его получение', async () => {
        vi.mocked(fetchFileContent).mockResolvedValueOnce(null).mockResolvedValueOnce(content);
        const { render } = setup(); await render(); await click('.story-file-expand');
        expect(host.querySelector('[role=alert]')).not.toBeNull();
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
        await click('[role=alert] button');
        expect(fetchFileContent).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[role=alert]')).toBeNull();
    });

    it('повторяет парсинг после ошибки начального чтения', async () => {
        const { data, render } = setup(); data.parse.mockRejectedValueOnce(new Error('worker failed'));
        await render(); expect(host.querySelector('[role=alert]')?.textContent).toContain('worker failed');
        await click('[role=alert] button');
        expect(data.parse).toHaveBeenCalledTimes(2);
        expect(fetchFileContent).not.toHaveBeenCalled();
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
    });

    it('переход к скрытой строке сохраняет готовые строки при ошибке и повторяет раскрытие', async () => {
        vi.mocked(fetchFileContent).mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(content);
        const { render } = setup();
        await render(file, 'a', { path: file.path, side: 'new', start: 3, end: 3 });
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
        await click('[role=alert] button');
        expect(fetchFileContent).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[role=alert]')).toBeNull();
    });

    it('не публикует запоздавшее раскрытие A после переключения на B', async () => {
        const pending = deferred<FileContent | null>(); vi.mocked(fetchFileContent).mockReturnValue(pending.promise);
        const { data, render } = setup(); await render();
        const before = data.file('a', file.fileId).model;
        await click('.story-file-expand');
        await render({ ...file, path: 'b.ts' }, 'b');
        const current = data.file('b', file.fileId).model;
        await act(async () => { pending.resolve(content); await Promise.resolve(); });
        expect(data.file('a', file.fileId).model).toBe(before);
        expect(data.file('b', file.fileId).model).toBe(current);
        expect(host.querySelector('header code')?.textContent).toBe('b.ts');
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
    });

    it('не показывает и не выделяет строки A под заголовком B, пока B разбирается', async () => {
        const pending = deferred<ReturnType<typeof parseFileDiff>>();
        const { data, onSelect, render } = setup(); await render();
        data.parse.mockReturnValueOnce(pending.promise);
        await render({ ...file, path: 'b.ts' }, 'b');
        expect(host.querySelector('header code')?.textContent).toBe('b.ts');
        expect(host.querySelectorAll('.diff-row')).toHaveLength(0);
        expect(host.querySelector('[data-reading-wait]')).not.toBeNull();
        await act(async () => { host.querySelector('[data-reading-wait]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => { pending.resolve(parseFileDiff(toParseRequest({ ...file, path: 'b.ts' }))); await Promise.resolve(); });
        expect(host.querySelectorAll('.diff-row')).toHaveLength(2);
    });

    it('не сохраняет запоздалый разбор A и не показывает ошибку скачивания A в B', async () => {
        const parsed = deferred<ReturnType<typeof parseFileDiff>>();
        const { data, render } = setup(); data.parse.mockReturnValueOnce(parsed.promise);
        await render(); await render({ ...file, path: 'b.ts' }, 'b');
        await act(async () => { parsed.resolve(parseFileDiff(toParseRequest(file))); await Promise.resolve(); });
        expect(data.file('a', file.fileId).model).toBeNull();
        const downloaded = deferred<undefined>(); vi.mocked(downloadFileOriginal).mockReturnValue(downloaded.promise);
        await click('header button');
        await render({ ...file, path: 'c.ts' }, 'c');
        await act(async () => { downloaded.reject(new Error('old download failed')); await Promise.resolve(); });
        expect(host.querySelector('[role=alert]')).toBeNull();
    });
});
