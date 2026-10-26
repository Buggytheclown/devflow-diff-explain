import { codeLink } from '@sherpa/protocol';
import { expect, it } from 'vitest';

import { chatCodeLinkErrors } from './chat-code-links.js';
import { walkPatch } from './route/diff-index.js';
import { mediumDiff } from './route/fixture-support.js';

it('сверяет файл, сторону и полный диапазон с сохранённым патчем', () => {
    const diff = mediumDiff();
    const file = diff.files.find((entry) => entry.patch != null);
    if (file?.patch == null) throw new Error('No patch');
    const line = [...walkPatch(file.patch)].find((entry) => entry.new !== null)?.new;
    if (line == null) throw new Error('No line');
    const target = { path: file.path, side: 'new' as const, start: line, end: line };
    const answer = (location: typeof target) => `См. [источник](${codeLink(location)}).`;
    expect(chatCodeLinkErrors(answer(target), diff, null)).toEqual([]);
    expect(chatCodeLinkErrors(answer({ ...target, path: 'missing.ts' }), diff, null)).not.toEqual([]);
    expect(chatCodeLinkErrors(answer({ ...target, start: 999999, end: 999999 }), diff, null)).not.toEqual([]);
    expect(chatCodeLinkErrors(answer(target), null, null)).not.toEqual([]);
    expect(chatCodeLinkErrors('[ошибка](#code?path=a&side=new&start=0&end=1)', diff, null)).not.toEqual([]);
    expect(chatCodeLinkErrors('Обычный старый ответ без ссылок.', null, null)).toEqual([]);
});

it('принимает раскрытые строки только из выделения того же файла, стороны и версии', () => {
    const diff = mediumDiff();
    const file = diff.files.find((entry) => entry.patch != null);
    if (file === undefined) throw new Error('No file');
    const anchor = { diffId: diff.diffId, fileId: file.fileId, path: file.path, side: 'new' as const, start: 999900, end: 999905 };
    const answer = `См. [выделение](${codeLink({ ...anchor, start: 999901, end: 999904 })}).`;
    expect(chatCodeLinkErrors(answer, diff, anchor)).toEqual([]);
    expect(chatCodeLinkErrors(answer, diff, { ...anchor, diffId: 'another-version' })).not.toEqual([]);
    expect(chatCodeLinkErrors(answer, diff, { ...anchor, fileId: 'another-file' })).not.toEqual([]);
    expect(chatCodeLinkErrors(answer, diff, { ...anchor, side: 'old' })).not.toEqual([]);
    expect(chatCodeLinkErrors(answer, diff, { ...anchor, end: 999902 })).not.toEqual([]);
});
