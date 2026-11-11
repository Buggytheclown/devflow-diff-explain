// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { DiffRows } from './diff-rows.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GAP_MODEL = parseFileDiff({
    fileId: 'f2',
    path: 'src/gaps.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -21,1 +21,1 @@\n-old-21\n+new-21\n@@ -51,1 +51,1 @@\n-old-51\n+new-51\n',
});
const LONG_MODEL = parseFileDiff({
    fileId: 'f-long',
    path: 'src/long.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -1,1 +1,1 @@',
        `-const endpoint = "https://wrap-fixture.invalid/payload/${'b'.repeat(600)}/orders";`,
        `+\tconst endpoint = "https://wrap-fixture.invalid/payload/${'a'.repeat(600)}/orders";   `,
        '\\ No newline at end of file',
    ].join('\n'),
});

function renderGaps(mode: 'unified' | 'split', model = GAP_MODEL): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
        <DiffRows model={model} mode={mode} selection={null} />,
    );
    return host;
}

it('заголовки ханков сохраняют диапазоны, стороны и число строк диффа', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<DiffRows showHunkHeaders model={GAP_MODEL} mode="unified" selection={null} />);
    expect([...host.querySelectorAll('.diff-hunk-header')].map((node) => node.textContent)).toEqual(['@@ -21,1 +21,1 @@', '@@ -51,1 +51,1 @@']);
    expect([...host.querySelectorAll('.diff-row')].map((node) => node.getAttribute('data-key'))).toEqual(['d21', 'a21', 'd51', 'a51']);
});

describe('категории подсветки', () => {
    it.each(['unified', 'split'] as const)('режим %s передаёт одну категорию имени на удалённой и добавленной строках', (mode) => {
        const model = parseFileDiff({
            fileId: 'classes', path: 'classes.ts', oldPath: null, changeType: 'modify', binary: false,
            patch: '@@ -1,1 +1,1 @@\n-class Before {}\n+class After {}',
        });
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(<DiffRows model={model} mode={mode} selection={null} />);

        const names = [...host.querySelectorAll('.syntax-type')];
        expect(names.map((name) => name.textContent)).toEqual(['Before', 'After']);
        expect(names.map((name) => name.className)).toEqual(['syntax-type diff-word', 'syntax-type diff-word']);
    });
});

describe('перемычки контекста', () => {
    it.each(['unified', 'split'] as const)('в режиме %s показывают скрытые строки без управления раскрытием', (mode) => {
        const host = renderGaps(mode);
        const gaps = [...host.querySelectorAll<HTMLElement>('.diff-gap')];
        expect(gaps.map((gap) => gap.dataset.edge)).toEqual(['leading', 'inner', 'trailing']);
        expect(gaps.map((gap) => gap.textContent)).toEqual(['20 неизменённых строк', '29 неизменённых строк', 'неизменённое до конца файла']);
        expect(host.querySelectorAll('.diff-gap button,.diff-gap[tabindex],.diff-gap[role]')).toHaveLength(0);
    });
});

describe('перенос длинной строки', () => {
    it('сохраняет табы и разметку длинной строки', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <DiffRows
                    model={LONG_MODEL}
                    mode="unified"

                    selection={{ fileId: LONG_MODEL.fileId, anchor: 'a1', focus: 'a1' }}
                        />,
            );
        });

        const code = host.querySelector<HTMLElement>('.diff-row--add .diff-row__code');
        if (code === null) {
            throw new Error('длинная строка не отрисовалась');
        }

        // jsdom не применяет CSS: вычисленные white-space/overflow-wrap проверяет e2e.
        expect(code.classList.contains('diff-row__code')).toBe(true);
        expect(code.textContent).toContain('    const endpoint');
        expect(code.querySelector('.diff-word')).not.toBeNull();
        expect(code.querySelector('.diff-trailing')?.textContent).toBe('   ');
        expect(code.querySelector('.diff-row__no-newline')).not.toBeNull();
        expect(code.closest('.diff-row')?.classList.contains('is-selected')).toBe(true);

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});
