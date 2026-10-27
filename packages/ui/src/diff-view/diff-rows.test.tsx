// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FileContent } from '@sherpa/protocol';

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
const REMAINDER_MODEL = parseFileDiff({
    fileId: 'f3',
    path: 'src/remainder.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -21,1 +21,1 @@\n-old-21\n+new-21\n@@ -41,1 +41,1 @@\n-old-41\n+new-41\n',
});
const GAP_LINES = Array.from({ length: 80 }, (_, index) => `line-${String(index + 1)}`);
const GAP_CONTENT: FileContent = { oldText: GAP_LINES.join('\n'), newText: GAP_LINES.join('\n') };
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
        <DiffRows model={model} mode={mode} content={GAP_CONTENT} selection={null} />,
    );
    return host;
}

describe('категории подсветки', () => {
    it.each(['unified', 'split'] as const)('режим %s передаёт одну категорию имени на удалённой и добавленной строках', (mode) => {
        const model = parseFileDiff({
            fileId: 'classes', path: 'classes.ts', oldPath: null, changeType: 'modify', binary: false,
            patch: '@@ -1,1 +1,1 @@\n-class Before {}\n+class After {}',
        });
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(<DiffRows model={model} mode={mode} content={null} selection={null} />);

        const names = [...host.querySelectorAll('.syntax-type')];
        expect(names.map((name) => name.textContent)).toEqual(['Before', 'After']);
        expect(names.map((name) => name.className)).toEqual(['syntax-type diff-word', 'syntax-type diff-word']);
    });
});

describe('перемычки контекста', () => {
    it.each(['unified', 'split'] as const)('в режиме %s сохраняют направления и один tab-стоп', (mode) => {
        const host = renderGaps(mode);
        const leading = host.querySelector<HTMLElement>('.diff-gap[data-edge="leading"]');
        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const trailing = host.querySelector<HTMLElement>('.diff-gap[data-edge="trailing"]');

        expect(leading?.querySelectorAll('[data-direction="up"]')).toHaveLength(1);
        expect(leading?.querySelectorAll('[data-direction="down"]')).toHaveLength(0);
        expect(inner?.querySelectorAll('[data-direction="up"], [data-direction="down"]')).toHaveLength(2);
        expect(trailing?.querySelectorAll('[data-direction="up"]')).toHaveLength(0);
        expect(trailing?.querySelectorAll('[data-direction="down"]')).toHaveLength(1);

        for (const gap of [leading, inner, trailing]) {
            expect(gap?.getAttribute('tabindex')).toBe('0');
            expect(gap?.querySelectorAll('button[tabindex="-1"]')).toHaveLength(
                gap?.querySelectorAll('button').length ?? 0,
            );
        }
    });

    it('остаток меньше шага даёт одну мишень updown с точным aria-label', () => {
        const host = renderGaps('unified', REMAINDER_MODEL);
        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const target = inner?.querySelector<HTMLButtonElement>('[data-direction="all"]');

        expect(target).not.toBeNull();
        expect(target?.getAttribute('aria-label')).toBe('догрузить 19 строк, 19 строк скрыто');
        expect(target?.querySelector('svg[data-icon="updown"]')).not.toBeNull();
        expect(inner?.textContent).toContain('19 неизменённых строк');
        expect(inner?.textContent).not.toContain('раскрыть');
    });

    it('стрелки переключают визуально и через aria-activedescendant выбранное направление', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<DiffRows model={GAP_MODEL} mode="unified" content={GAP_CONTENT} selection={null} />);
        });

        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const up = inner?.querySelector<HTMLElement>('[data-direction="up"]');
        const down = inner?.querySelector<HTMLElement>('[data-direction="down"]');
        if (inner === null || up === null || up === undefined || down === null || down === undefined) {
            throw new Error('внутренняя перемычка не отрисовала оба направления');
        }

        expect(inner.getAttribute('role')).toBe('radiogroup');
        expect(inner.getAttribute('aria-activedescendant')).toBe(up.id);
        expect(up.classList.contains('is-active')).toBe(true);
        expect(up.getAttribute('aria-checked')).toBe('true');
        expect(down.getAttribute('aria-checked')).toBe('false');

        act(() => {
            inner.focus();
            inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });

        expect(inner.getAttribute('aria-activedescendant')).toBe(down.id);
        expect(down.classList.contains('is-active')).toBe(true);
        expect(down.getAttribute('aria-checked')).toBe('true');
        expect(up.getAttribute('aria-checked')).toBe('false');

        act(() => {
            root.unmount();
        });
        host.remove();
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
                    content={null}
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
