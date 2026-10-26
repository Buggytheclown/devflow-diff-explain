import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Lens } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    filterFragmentValue,
    filterStats,
    type FileFilter,
    findFilter,
    selectFilter,
    zeroResultText,
} from './lens-filters.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

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

function lens(id: string, label: string, paths: readonly string[], patch: Partial<Lens> = {}): Lens {
    return { id, label, paths: [...paths], available: true, note: null, zones: null, ...patch };
}

const FILES = [
    file('src/a.ts'),
    file('src/b.ts'),
    file('gen/c.ts', { generated: true, additions: 100, deletions: 0 }),
];

describe('buildFileFilters', () => {
    it('порядок хендофф §Filters: все → мои → линзы хоста → машинные', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', ['src/a.ts']),
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])], t,});

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'pci', 'generated']);
    });

    it('известные id подписаны по-русски, счётчики живые от диффа', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', ['src/a.ts']),
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])], t, zoneSource: 'CODEOWNERS',});

        expect(filters.map((filter) => [filter.label, filter.count])).toEqual([
            ['Все файлы', 3],
            ['Мои файлы · CODEOWNERS', 1],
            ['Файлы PCI DSS', 1],
            ['Сгенерированные', 1],
        ]);
    });

    it('без источника зон «мои файлы» подписаны без него', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', ['src/a.ts']),
            extra: [], t,});

        expect(filters.find((filter) => filter.id === 'mine')?.label).toBe('Мои файлы');
    });

    it('счётчик линзы считается по пересечению с диффом, а не по её длине', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', ['src/a.ts', 'src/gone.ts', 'src/also-gone.ts'])], t,});

        expect(findFilter(filters, 'pci')?.count).toBe(1);
    });

    it('незнакомая линза хоста попадает в список с хостовым лейблом как есть', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('security-scope', 'Security scope', ['src/b.ts'])], t,});

        const unknown = findFilter(filters, 'security-scope');
        expect(unknown?.label).toBe('Security scope');
        expect(unknown?.shortLabel).toBe('Security scope');
        expect(unknown?.count).toBe(1);
    });

    it('хост не может переопределить синтетические all и generated', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('all', 'Everything', []), lens('generated', 'Robots', [])], t,});

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'generated']);
        expect(findFilter(filters, 'generated')?.count).toBe(1);
    });

    it('нет ownership-линзы — фильтра «мои» просто нет', () => {
        const filters = buildFileFilters({ files: FILES, ownership: null, extra: [], t});

        expect(findFilter(filters, 'mine')).toBeNull();
    });

    it('ownership без зоны — пункт выключен и объясняет причину (SPEC-elements §4.2)', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', [], {
                available: false,
                note: 'у тебя нет зоны CODEOWNERS в этом PR',
            }),
            extra: [], t,});

        const mine = findFilter(filters, 'mine');
        expect(mine?.available).toBe(false);
        expect(mine?.note).toBe('у тебя нет зоны CODEOWNERS в этом PR');
    });

    it('все файлы мои — счётчик тот же, что у «всех», и это не преселект', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', FILES.map((item) => item.path)),
            extra: [], t,});

        expect(findFilter(filters, 'mine')?.count).toBe(3);
        expect(selectFilter(filters, null).id).toBe(ALL_FILTER_ID);
    });

    it('машинных файлов нет — фильтра generated нет в составе', () => {
        const filters = buildFileFilters({ files: [file('src/a.ts')], ownership: null, extra: [], t});

        expect(findFilter(filters, 'generated')).toBeNull();
    });

    it('пустая линза хоста не попадает в состав независимо от available', () => {
        const available = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', [])], t,});
        const unavailable = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', [], { available: false, note: 'скоуп недоступен' })], t,});

        expect(findFilter(available, 'pci')).toBeNull();
        expect(findFilter(unavailable, 'pci')).toBeNull();
    });

    it('large: пустой недоступный PCI скрыт, живые ownership и generated остаются', () => {
        const data = fixtureIteration('large');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses, t,});

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'generated']);
        expect(findFilter(filters, 'pci')).toBeNull();
    });

    it('edge: ownership без зоны остаётся выключенным с причиной хоста', () => {
        const data = fixtureIteration('edge');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses, t,});

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'generated']);
        expect(findFilter(filters, 'mine')).toMatchObject({
            available: false,
            count: 0,
            note: 'You do not own any CODEOWNERS zone touched by this PR.',
        });
    });

    it('medium: обе хостовые линзы и generated образуют полный состав', () => {
        const data = fixtureIteration('medium');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses, t,});

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'pci', 'generated']);
        expect(filters.every((filter) => filter.available)).toBe(true);
    });

    it('ownership доступен, но своих файлов нет — пункт остаётся с причиной UI', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', []),
            extra: [], t,});

        expect(findFilter(filters, 'mine')).toMatchObject({
            available: false,
            count: 0,
            note: 'в этом PR нет ваших файлов',
        });
    });
});

describe('selectFilter', () => {
    const filters = buildFileFilters({
        files: FILES,
        ownership: lens('mine', 'My files', [], { available: false, note: 'нет зоны' }),
        extra: [lens('pci', 'PCI DSS', ['src/b.ts'])], t,});

    it('находит фильтр по id', () => {
        expect(selectFilter(filters, 'pci').id).toBe('pci');
    });

    it('мусор из URL и выключенный пункт откатываются к «всем файлам»', () => {
        expect(selectFilter(filters, 'nonsense').id).toBe(ALL_FILTER_ID);
        expect(selectFilter(filters, 'mine').id).toBe(ALL_FILTER_ID);
        expect(selectFilter(filters, null).id).toBe(ALL_FILTER_ID);
    });
});

describe('filterFiles', () => {
    const filters = buildFileFilters({
        files: FILES,
        ownership: null,
        extra: [lens('pci', 'PCI DSS', ['src/b.ts'])], t,});

    it('«все файлы» пропускает список как есть', () => {
        expect(filterFiles(FILES, selectFilter(filters, ALL_FILTER_ID))).toBe(FILES);
    });

    it('линза оставляет только свои файлы', () => {
        expect(filterFiles(FILES, selectFilter(filters, 'pci')).map((item) => item.path)).toEqual(['src/b.ts']);
    });
});

describe('filterStats', () => {
    it('считает файлы и изменённые строки фильтра против всего диффа', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])], t,});

        expect(filterStats(FILES, selectFilter(filters, 'pci'))).toEqual({
            files: 1,
            changedLines: 12,
            totalFiles: 3,
            totalChangedLines: 124,
        });
    });
});

describe('filterFragmentValue', () => {
    it('дефолтный фильтр не попадает в адрес', () => {
        expect(filterFragmentValue(ALL_FILTER_ID)).toBeNull();
        expect(filterFragmentValue('pci')).toBe('pci');
    });
});

describe('zeroResultText', () => {
    function emptyFilter(id: string, label: string, note: string | null): FileFilter {
        return {
            id,
            label,
            shortLabel: label,
            count: 0,
            available: true,
            note,
            fileIds: new Set(),
        };
    }

    it('без хостовой причины UI объясняет своими словами', () => {
        expect(zeroResultText(emptyFilter('pci', 'Файлы PCI DSS', null), t)).toBe(
            'В этом PR нет файлов фильтра «Файлы PCI DSS».',
        );
    });

    it('хостовая note старше своего текста', () => {
        expect(zeroResultText(emptyFilter('sox', 'SOX scope', 'скоуп SOX для этого коммита ещё не опубликован'), t)).toBe(
            'скоуп SOX для этого коммита ещё не опубликован',
        );
    });
});
