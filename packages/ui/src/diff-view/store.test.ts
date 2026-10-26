import type { FileDiff } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import { describe, expect, it } from 'vitest';

import { FILE_EXPANSION_KEY } from './expand.js';
import type { DiffMode } from './store.js';
import { createDiffViewStore, fileCollapseReason, SPLIT_MIN_WIDTH } from './store.js';

/** Состояние дифф-вью: режим, ширина, отметки, раскрытие контекста и выделение. */

function file(fileId: string, viewed: boolean | null = false): FileDiff {
    return {
        fileId,
        path: `src/${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 3,
        deletions: 1,
        patch: null,
        viewed,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
}

function generated(fileId: string): FileDiff {
    return { ...file(fileId), generated: true };
}

function modelWithGap(fileId: string): DiffFileModel {
    return {
        fileId,
        path: `src/${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        language: 'ts',
        modeChange: null,
        additions: 1,
        deletions: 1,
        onlyAdditions: false,
        onlyDeletions: false,
        whitespaceOnly: false,
        malformed: false,
        content: {
            kind: 'text',
            blocks: [{ kind: 'gap', edge: 'leading', hiddenLines: 40, oldStart: 1, newStart: 1 }],
        },
    };
}


describe('стор дифф-вью', () => {
    it('без записей прогресса read-state считается от самого файла', () => {
        const store = createDiffViewStore({
            files: [file('a', true), file('b', false), file('c', null), generated('d')],
        });

        const { readState } = store.getSnapshot();
        expect([readState.get('a'), readState.get('b'), readState.get('c'), readState.get('d')].map(
            (state) => state?.state,
        )).toEqual(['read', 'unread', 'unread', 'read']);
    });

    it('ручная свёртка и развёртка живут отдельным персистимым слоем', () => {
        const target = file('a');
        const store = createDiffViewStore({ files: [target] });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['a', true]]));

        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['a', false]]));
    });

    it('выбор свёртки заменяется целиком: состояние PR доехало позже создания стора', () => {
        const target = file('a');
        const other = file('b');
        const store = createDiffViewStore({ files: [target, other] });
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        store.setCollapsePreferences(new Map([['a', true]]));
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        expect(store.getSnapshot().collapseCollapsed).toEqual(new Set(['a']));
        expect(notified).toBe(1);

        // Тот же выбор ничего не двигает: иначе доливка карты перерисовывала бы карточки.
        store.setCollapsePreferences(new Map([['a', true]]));
        expect(notified).toBe(1);

        store.setCollapsePreferences(new Map([['b', false]]));
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseCollapsed).toEqual(new Set());
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set(['b']));
    });

    it('просмотренная свёртка временная: снятие отметки возвращает прежнюю ручную развёртку', () => {
        const target = file('a');
        const store = createDiffViewStore({
            files: [target],
            collapsed: new Map([['a', false]]),
        });

        store.markViewed('a', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseExpandedViewed).toEqual(new Set(['a']));

        store.markViewed('a', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set(['a']));
        expect(store.getSnapshot().collapseExpandedViewed).toEqual(new Set());
    });

    it('read от полного покрытия тоже сворачивает, partial — нет', () => {
        const target = file('a');
        const store = createDiffViewStore({
            files: [target],
            progress: [{ fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 1, end: 4 }] }],
        });

        expect(store.getSnapshot().readState.get('a')?.state).toBe('read');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');

        store.setProgress([{ fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 1, end: 2 }] }]);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('partial');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
    });

    it('машинный дефолт — отдельная ветка: ручная развёртка переживает un-pin и возвращается к умолчанию', () => {
        const target = generated('d');
        const store = createDiffViewStore({ files: [target] });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('generated');
        store.toggleFileCollapse('d');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['d', false]]));

        store.markViewed('d', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.markViewed('d', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().readState.get('d')?.state).toBe('unread');

        store.toggleFileCollapse('d');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('generated');
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set());
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map());
    });

    it('ручная свёртка старше generated-дефолта, viewed — старше ручной', () => {
        const target = generated('d');
        const store = createDiffViewStore({
            files: [target],
            collapsed: new Map([['d', true]]),
        });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        store.markViewed('d', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.markViewed('d', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
    });

    it('свёртка >2000 остаётся отдельным слоем поверх формулы файлов', () => {
        const target = { ...file('big'), additions: 2001 };
        const store = createDiffViewStore({ files: [target] });

        store.markViewed('big', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.toggleFileCollapse('big');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().opened.has('big')).toBe(false);

        store.openFile('big');
        expect(store.getSnapshot().opened.has('big')).toBe(true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
    });

    it('прогресс сервера старше умолчаний: снятая отметка машинного файла переживает загрузку', () => {
        const store = createDiffViewStore({ files: [generated('d'), file('a')] });

        store.setProgress([
            { fileId: 'd', viewed: false, seenRanges: [] },
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        const { readState } = store.getSnapshot();
        expect([readState.get('d')?.state, readState.get('a')?.state]).toEqual(['unread', 'read']);
    });

    it('стартовый прогресс приезжает в конструктор', () => {
        const store = createDiffViewStore({
            files: [generated('d')],
            progress: [{ fileId: 'd', viewed: false, seenRanges: [] }],
        });

        expect(store.getSnapshot().readState.get('d')?.state).toBe('unread');
    });

    it('оптимистичная отметка и откат к прежней записи', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        store.markViewed('a', true);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('read');
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });

        // Записи до отметки не было — откат обязан её убрать, а не оставить `viewed: false`.
        store.restoreProgress('a', null);
        expect(store.getSnapshot().progress.has('a')).toBe(false);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('unread');

        store.markViewed('a', true);
        store.restoreProgress('a', { fileId: 'a', viewed: false, seenRanges: [] });
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: false, seenRanges: [] });
    });

    it('отметка меняет только флаг: диапазоны записи остаются на месте', () => {
        const ranges = [{ side: 'new' as const, start: 1, end: 2 }];
        const store = createDiffViewStore({
            files: [file('a')],
            progress: [{ fileId: 'a', viewed: false, seenRanges: ranges }],
        });

        store.markViewed('a', true);
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: ranges });

        // Снятие возвращает состояние, посчитанное по диапазонам, а не «ничего не прочитано».
        store.markViewed('a', false);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('partial');
    });

    it('read-state прочих файлов при отметке остаётся тем же объектом', () => {
        const store = createDiffViewStore({ files: [file('a'), file('b')] });
        const before = store.getSnapshot().readState.get('b');

        store.markViewed('a', true);

        expect(store.getSnapshot().readState.get('b')).toBe(before);
    });

    it('стартует с режимом из настроек и сообщает о смене наружу', () => {
        const changes: DiffMode[] = [];
        const store = createDiffViewStore({
            files: [],
            diffMode: 'split',
            onDiffModeChange: (mode) => changes.push(mode),
        });
        expect(store.getSnapshot().diffMode).toBe('split');

        store.setDiffMode('unified');
        expect(store.getSnapshot().diffMode).toBe('unified');
        // Повтор того же режима наружу не уходит: PATCH без изменения не нужен.
        store.setDiffMode('unified');

        expect(changes).toEqual(['unified']);
    });

    it('без явного режима стартует в unified', () => {
        expect(createDiffViewStore({ files: [] }).getSnapshot().diffMode).toBe('unified');
    });

    it('на узкой ширине split недоступен, выбор пользователя сохраняется', () => {
        const store = createDiffViewStore({ files: [] });
        store.setDiffMode('split');

        store.setAvailableWidth(SPLIT_MIN_WIDTH - 1);
        expect(store.getSnapshot()).toMatchObject({
            diffMode: 'split',
            splitAvailable: false,
            effectiveMode: 'unified',
        });

        store.setAvailableWidth(SPLIT_MIN_WIDTH);
        expect(store.getSnapshot().effectiveMode).toBe('split');
    });

    it('раскрытие хранится по перемычке и направлению, полное раскрытие ставит all', () => {
        const store = createDiffViewStore({ files: [file('a')] });
        const key = 'leading:1:1:40';

        store.expandGap('a', key, 'up');
        store.expandGap('a', key, 'up');
        expect(store.getSnapshot().expansion.get('a')?.get(key)).toEqual({ up: 40, down: 0, all: false });

        store.setModel('a', modelWithGap('a'));
        store.expandFile('a', ['clip:visible']);
        expect(store.getSnapshot().expansion.get('a')?.get(key)).toEqual({ up: 40, down: 0, all: true });
        expect(store.getSnapshot().expansion.get('a')?.get('clip:visible')?.all).toBe(true);
        expect(store.getSnapshot().expansion.get('a')?.get(FILE_EXPANSION_KEY)?.all).toBe(true);
    });

    it('выделение тянется в обе стороны и снимается', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        store.beginSelection();
        store.startSelection('a', 'c40:42');
        store.extendSelection('a', 'a37');
        expect(store.getSnapshot()).toMatchObject({
            selection: { fileId: 'a', anchor: 'c40:42', focus: 'a37' },
            selectionDragging: true,
        });
        store.finishSelection();
        expect(store.getSnapshot().selectionDragging).toBe(false);

        // Выделение в другом файле начинается заново, а не тянется через файлы.
        store.extendSelection('b', 'd12');
        expect(store.getSnapshot().selection).toMatchObject({ fileId: 'b', anchor: 'd12' });

        store.clearSelection();
        expect(store.getSnapshot().selection).toBeNull();
    });

    it('движение мыши тянет выделение только внутри начатой протяжки', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        // Зажатая кнопка без протяжки из гаттера (выделение текста в коде) ничего не начинает.
        store.dragSelection('a', 'a37');
        expect(store.getSnapshot().selection).toBeNull();

        store.beginSelection();
        store.startSelection('a', 'c40:42');
        store.dragSelection('a', 'a37');
        expect(store.getSnapshot().selection).toMatchObject({ anchor: 'c40:42', focus: 'a37' });
        store.finishSelection();

        // Готовое выделение зажатое движение над строками больше не трогает.
        store.dragSelection('a', 'a50');
        expect(store.getSnapshot().selection).toMatchObject({ anchor: 'c40:42', focus: 'a37' });
    });

    it('помнит раскрытие whitespace-only строк вне FileCard', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        store.showWhitespace('a');
        store.showWhitespace('a');

        expect(store.getSnapshot().whitespaceShown).toEqual(new Set(['a']));
    });

    it('переключает Markdown-документ и сбрасывает выделение только этого файла', () => {
        const store = createDiffViewStore({ files: [file('a'), file('b')] });

        store.startSelection('b', 'a3');
        store.toggleMarkdown('a');
        expect(store.getSnapshot().markdownShown).toEqual(new Set(['a']));
        expect(store.getSnapshot().selection).toMatchObject({ fileId: 'b' });

        store.startSelection('a', 'a3');
        store.beginSelection();
        store.toggleMarkdown('a');
        expect(store.getSnapshot().markdownShown).toEqual(new Set());
        expect(store.getSnapshot().selection).toBeNull();
        expect(store.getSnapshot().selectionDragging).toBe(false);
    });

    it('подписчики будятся на каждое изменение и только на него', () => {
        const store = createDiffViewStore({ files: [file('a')] });
        let calls = 0;
        const stop = store.subscribe(() => {
            calls += 1;
        });

        store.markViewed('a', true);
        store.clearSelection();
        expect(calls).toBe(1);

        stop();
        store.markViewed('a', false);
        expect(calls).toBe(1);
    });
});
