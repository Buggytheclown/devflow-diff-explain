// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Lens } from '@sherpa/protocol';
import { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileFilter } from '../filters/lens-filters.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import type { FileReadState, ReadState } from '../progress/read-state.js';
import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { FilePanelProps, FileTreeCursor } from './file-panel.tsx';
import { FilePanel } from './file-panel.tsx';
import { createT } from '../i18n/index.js';

const t = createT('ru');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const virtual = vi.hoisted(() => ({ measure: vi.fn() }));

vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        measure: virtual.measure,
        getTotalSize: () => count * estimateSize(),
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * estimateSize(),
                size: estimateSize(),
                end: (index + 1) * estimateSize(),
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: false,
    note: 'No files of this PR are in the PCI DSS scope.',
    zones: null,
};
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [EMPTY_PCI], t});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    readOnly = false,
    filters: readonly FileFilter[] = FILTERS,
    settings: UiSettingsStore = createUiSettingsStore({ loaded: true }),
    props: Partial<FilePanelProps> = {},
) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onFilter = vi.fn<(id: string) => void>();
    const onOpenFile = vi.fn<(fileId: string) => void>();
    const onToggleViewed = vi.fn<(fileId: string) => void>();
    const cursorRef = createRef<FileTreeCursor>();
    const prState = createUiPrStateStore();

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <PrStateProvider store={prState}>
                    <ReadOnlyIterationProvider readOnly={readOnly}>
                        <FilePanel
                            files={FILES}
                            filters={filters}
                            activeFilter={selectFilter(filters, 'all')}
                            onFilter={onFilter}
                            pciFileIds={new Set()}
                            mineFileIds={new Set()}
                            readState={new Map()}
                            route={null}
                            activeFileId={null}
                            onOpenFile={onOpenFile}
                            onToggleViewed={onToggleViewed}
                            writeError={null}
                            outline={null}
                            onOpenHunk={() => undefined}
                            cursorRef={cursorRef}
                            {...props}
                        />
                    </ReadOnlyIterationProvider>
                </PrStateProvider>
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, onFilter, onOpenFile, onToggleViewed, cursorRef };
}

describe('теги строк дерева', () => {
    it('конфликтный файл получает тег conflict (SPEC-elements §4.1)', () => {
        const { host } = mount();
        const tags = [...host.querySelectorAll('.file-tree__tag--conflict')];

        expect(tags.map((tag) => tag.textContent)).toEqual(['conflict']);
        expect(FILES.filter((file) => file.changeType === 'conflict')).toHaveLength(1);
    });
});

describe('чипы фильтров FilePanel', () => {
    it('нулевые PCI и generated скрыты, «Мои» видим и выключен с причиной', () => {
        const { host, onFilter } = mount();
        const chips = [...host.querySelectorAll<HTMLButtonElement>('.file-panel__chip')];

        expect(chips.map((chip) => chip.textContent.trim())).toEqual([`Все ${String(FILES.length)}`, 'Мои 0']);
        const mine = chips[1];
        expect(mine?.disabled).toBe(true);
        expect(mine?.title).toBe('You do not own any CODEOWNERS zone touched by this PR.');
        expect(host.textContent).not.toContain('PCI');
        expect(host.textContent).not.toContain('Машинные');

        act(() => {
            mine?.click();
        });
        expect(onFilter).not.toHaveBeenCalled();
    });

    it('единственный фильтр «Все» — ряда чипов нет', () => {
        const single = buildFileFilters({ files: FILES, ownership: null, extra: [EMPTY_PCI], t });
        expect(single.map((filter) => filter.id)).toEqual(['all']);

        const { host } = mount(false, single);

        expect(host.querySelector('.file-panel__chips')).toBeNull();
        expect(host.querySelector('.file-panel__search')).not.toBeNull();
    });

    it('два фильтра и больше — ряд чипов на месте', () => {
        const { host } = mount();

        expect(host.querySelectorAll('.file-panel__chips .file-panel__chip')).toHaveLength(2);
    });
});

describe('коробки просмотра FilePanel', () => {
    it('коробка файла — кнопка вне tab-порядка и переключает просмотр без открытия файла', () => {
        const { host, onOpenFile, onToggleViewed } = mount();
        const button = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__read');
        const row = button?.closest<HTMLElement>('[role="treeitem"]');
        const tree = host.querySelector<HTMLElement>('[role="tree"]');

        expect(button).not.toBeNull();
        expect(button?.type).toBe('button');
        expect(button?.tabIndex).toBe(-1);
        expect(button?.getAttribute('aria-pressed')).toBe('false');
        expect(button?.getAttribute('aria-hidden')).toBe('true');

        act(() => {
            button?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(FILES.map((file) => file.fileId)).toContain(onToggleViewed.mock.calls[0]?.[0]);
        expect(onOpenFile).not.toHaveBeenCalled();
        expect(row?.classList.contains('is-cursor')).toBe(true);
        expect(tree?.getAttribute('aria-activedescendant')).toBe(row?.id);
    });

    it('у директорий коробки нет, а сводка прочитанности остаётся в title строки', () => {
        const { host } = mount();
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        expect(directory).not.toBeNull();
        expect(directory?.querySelector('.file-tree__read')).toBeNull();
        expect(directory?.title).toMatch(/^прочитано \d+ из \d+$/);
    });

    it('у файла нет слота шеврона, а каталог и файл одного уровня стоят на одном отступе', () => {
        const { host } = mount();
        const rows = [...host.querySelectorAll<HTMLElement>('.file-tree__row')];
        const files = rows.filter((row) => row.classList.contains('file-tree__row--file'));

        expect(files.length).toBeGreaterThan(0);
        for (const row of files) {
            expect(row.querySelector('.file-tree__chevron')).toBeNull();
        }
        const indentsByLevel = new Map<string, Set<string>>();
        for (const row of rows) {
            const level = row.getAttribute('aria-level') ?? '';
            indentsByLevel.set(level, (indentsByLevel.get(level) ?? new Set()).add(row.style.paddingLeft));
        }
        for (const indents of indentsByLevel.values()) {
            expect(indents.size).toBe(1);
        }
    });
});

describe('приглушение прочитанного в дереве', () => {
    function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
        return {
            fileId: `f-${path}`,
            path,
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 10,
            deletions: 2,
            patch: null,
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: null,
            ...patch,
        };
    }

    function read(state: ReadState): FileReadState {
        return { state, seen: state === 'read' ? 12 : state === 'partial' ? 5 : 0, total: 12, pinned: false, generatedDefault: false };
    }

    const files = [
        file('done/a.ts'),
        file('done/b.ts'),
        file('mixed/c.ts'),
        file('mixed/d.ts'),
        file('mixed/e.ts'),
        // Машинный файл без записи прогресса: прочитан по умолчанию (`readStateOf`).
        file('gen/schema.ts', { generated: true }),
    ];
    const readState = new Map<string, FileReadState>([
        ['f-done/a.ts', read('read')],
        ['f-done/b.ts', read('read')],
        ['f-mixed/c.ts', read('read')],
        ['f-mixed/d.ts', read('partial')],
        ['f-mixed/e.ts', read('unread')],
    ]);

    function mountTree(props: Partial<FilePanelProps> = {}) {
        // «Мои» — только `mixed`: `done` и `gen` становятся чужими корнями.
        return mount(false, FILTERS, undefined, {
            files,
            readState,
            mineFileIds: new Set(['f-mixed/c.ts', 'f-mixed/d.ts', 'f-mixed/e.ts']),
            ...props,
        });
    }

    function row(host: HTMLElement, kind: 'file' | 'dir', name: string): HTMLElement {
        const found = [...host.querySelectorAll<HTMLElement>(`.file-tree__row--${kind}`)].find(
            (candidate) => candidate.querySelector('.file-tree__label-name')?.textContent === name,
        );
        if (found === undefined) {
            throw new Error(`в дереве нет строки ${kind} ${name}`);
        }
        return found;
    }

    it('прочитанный файл получает is-read, частичный и непрочитанный — нет', () => {
        const { host } = mountTree();

        expect(row(host, 'file', 'a.ts').classList.contains('is-read')).toBe(true);
        expect(row(host, 'file', 'c.ts').classList.contains('is-read')).toBe(true);
        expect(row(host, 'file', 'd.ts').classList.contains('is-read')).toBe(false);
        expect(row(host, 'file', 'e.ts').classList.contains('is-read')).toBe(false);
    });

    it('каталог приглушён, только когда прочитаны все его файлы', () => {
        const { host } = mountTree();

        expect(row(host, 'dir', 'done').classList.contains('is-read')).toBe(true);
        expect(row(host, 'dir', 'mixed').classList.contains('is-read')).toBe(false);
    });

    it('прочитанность ставится и машинной строке, и чужому корню', () => {
        const { host } = mountTree();

        expect([...row(host, 'file', 'schema.ts').classList]).toEqual(
            expect.arrayContaining(['is-generated', 'is-read']),
        );
        expect([...row(host, 'dir', 'done').classList]).toEqual(expect.arrayContaining(['is-foreign', 'is-read']));
        expect([...row(host, 'dir', 'gen').classList]).toEqual(
            expect.arrayContaining(['is-generated', 'is-foreign', 'is-read']),
        );
    });

    it('каталог считается по видимым файлам: линза без непрочитанных приглушает его', () => {
        const { host } = mountTree({
            files: files.filter((candidate) => candidate.path !== 'mixed/d.ts' && candidate.path !== 'mixed/e.ts'),
        });

        expect(row(host, 'dir', 'mixed').classList.contains('is-read')).toBe(true);
    });

    it('активная прочитанная строка несёт оба класса: от приглушения её освобождает CSS', () => {
        const { host } = mountTree({ activeFileId: 'f-done/a.ts' });

        expect([...row(host, 'file', 'a.ts').classList]).toEqual(expect.arrayContaining(['is-active', 'is-read']));
    });
});

describe('меню файла в дереве', () => {
    it('кнопка «⋯» строки открывает меню и не открывает файл', () => {
        const { host, onOpenFile } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');

        expect(more?.tabIndex).toBe(-1);
        act(() => {
            more?.click();
        });

        const menu = document.body.querySelector('[role="menu"]');
        expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
        expect(more?.getAttribute('aria-expanded')).toBe('true');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('правый клик по строке открывает то же меню и ставит на неё курсор', () => {
        const { host, onOpenFile } = mount();
        const row = host.querySelector<HTMLElement>('.file-tree__row--file');

        act(() => {
            row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 44 }));
        });

        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
        expect(row?.classList.contains('is-cursor')).toBe(true);
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('«Просмотрено» из меню идёт той же цепочкой, что коробка прочитанности', () => {
        const { host, onToggleViewed } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');
        act(() => {
            more?.click();
        });

        const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items[3]?.textContent).toBe('Просмотрено');
        act(() => {
            items[3]?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it('клавиатура меню не достаётся дереву: ⏎ не открывает файл, стрелка не двигает курсор', () => {
        const { host, onOpenFile } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        act(() => {
            host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more')?.click();
        });
        const cursor = tree?.getAttribute('aria-activedescendant');
        const item = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');

        act(() => {
            item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        expect(onOpenFile).not.toHaveBeenCalled();
        expect(tree?.getAttribute('aria-activedescendant')).toBe(cursor);
    });

    it('повторный клик по «⋯» строки закрывает меню', () => {
        const { host } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');

        // `click()` не шлёт mousedown, а тумблер живёт на паре mousedown + click.
        const press = (): void => {
            act(() => {
                more?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                more?.click();
            });
        };
        press();
        press();

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(more?.getAttribute('aria-expanded')).toBe('false');
    });

    it('в прошлой итерации отметка из меню выключена', () => {
        const { host, onToggleViewed } = mount(true);
        act(() => {
            host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more')?.click();
        });

        const viewed = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][3];
        expect(viewed?.getAttribute('aria-disabled')).toBe('true');
        expect(viewed?.title).toBe('только в активной итерации');

        act(() => {
            viewed?.click();
        });
        expect(onToggleViewed).not.toHaveBeenCalled();
    });
});

describe('коробки просмотра в режиме чтения', () => {
    it('в прошлой итерации коробка выключена и объясняет причину', () => {
        const { host, onToggleViewed } = mount(true);
        const button = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__read');

        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe('только в активной итерации');

        act(() => {
            button?.click();
        });

        expect(onToggleViewed).not.toHaveBeenCalled();
    });
});

/**
 * Команда `v` живёт во вью полного диффа: у неё две цели — карточка файла и строка дерева.
 * Панель отдаёт наружу только свой курсор и метит строки файлов `data-file`, чтобы строка
 * под мышью тоже была целью.
 */
describe('курсор дерева для клавиши `v`', () => {
    it('строка файла несёт data-file, строка каталога — нет', () => {
        const { host } = mount();
        const file = host.querySelector<HTMLElement>('.file-tree__row--file');
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        expect(FILES.map((candidate) => candidate.fileId)).toContain(file?.dataset.file);
        expect(directory?.dataset.file).toBeUndefined();
    });

    it('курсор отдаётся наружу, только пока дерево держит фокус', () => {
        const { host, cursorRef } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        const row = host.querySelector<HTMLElement>('.file-tree__row--file');

        // Курсора ещё нет: по дереву не ходили.
        expect(cursorRef.current?.cursorFileId()).toBeNull();

        act(() => {
            row?.click();
        });
        // Курсор встал, но фокус не в дереве — цели по курсору нет.
        expect(cursorRef.current?.cursorFileId()).toBeNull();

        act(() => {
            tree?.focus();
        });
        expect(cursorRef.current?.cursorFileId()).toBe(row?.dataset.file);

        act(() => {
            tree?.blur();
        });
        expect(cursorRef.current?.cursorFileId()).toBeNull();
    });

    it('курсор на каталоге файла не даёт', () => {
        const { host, cursorRef } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        act(() => {
            directory?.click();
            tree?.focus();
        });

        expect(cursorRef.current?.cursorFileId()).toBeNull();
    });
});


describe('геометрия дерева из CSS', () => {
    it('использует размеры поддерева при отличающихся настройках и обновляет их при смене темы', async () => {
        const style = document.createElement('style');
        style.textContent = `
            .file-tree { --tree-row-height: 31px; --tree-indent-step: 27px; }
            [data-theme="arcanum-light"] .file-tree { --tree-row-height: 19px; --tree-indent-step: 15px; }
        `;
        document.head.append(style);
        mounted.push(() => {
            style.remove();
        });
        const settings = createUiSettingsStore({ loaded: true, initial: { arcanum: true } });
        const { host } = mount(false, FILTERS, settings);
        const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        const secondRow = rows[1];
        expect(secondRow?.style.top).toBe('31px');
        const nestedRow = rows.find((row) => row.getAttribute('aria-level') === '2');
        expect(nestedRow?.style.paddingLeft).toBe('53px');

        virtual.measure.mockClear();
        await act(async () => {
            host.setAttribute('data-theme', 'arcanum-light');
            await Promise.resolve();
        });

        expect(secondRow?.style.top).toBe('19px');
        // Общий отступ 26px под метку маршрута сохраняется и у файлов, и у каталогов.
        expect(nestedRow?.style.paddingLeft).toBe('41px');
        expect(virtual.measure).toHaveBeenCalled();
    });
});
