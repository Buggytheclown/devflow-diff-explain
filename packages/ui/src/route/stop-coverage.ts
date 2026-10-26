import type { UiFileProgress } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { rangesCoverage, readStateOf } from '../progress/read-state.js';
import type { RouteEntry, RouteFileGroup } from './route-model.js';
import { entryGroups } from './route-model.js';

export interface StopCoverageSnapshot {
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    readonly readState: ReadonlyMap<string, FileReadState>;
}

/**
 * Покрытие строк карточки файла в записи маршрута её seen-диапазонами — единственное правило
 * «строки карточки прочитаны». Диапазоны группы — одни изменённые строки (`coveredChangedRanges`),
 * поэтому их длина и есть число изменённых строк карточки. Пустая группа не покрыта никогда.
 */
export function groupCoverage(group: RouteFileGroup, record: UiFileProgress | null): FileReadState {
    return rangesCoverage(group.seenRanges, record?.seenRanges ?? []);
}

/**
 * Read-state карточки файла в записи маршрута (docs/design/SPEC-elements.md §2.10): пин файла
 * (ручная отметка, хост, generated-дефолт) держит `read` в любой карточке, иначе считается
 * покрытие строк самой карточки, а не всего файла.
 */
export function groupReadState(
    group: RouteFileGroup,
    fileRead: FileReadState,
    record: UiFileProgress | null,
): FileReadState {
    return fileRead.state === 'read' && fileRead.pinned ? fileRead : groupCoverage(group, record);
}

/** `groupReadState` по снимку стора диффа. */
export function cardReadState(group: RouteFileGroup, snapshot: StopCoverageSnapshot): FileReadState {
    const record = snapshot.progress.get(group.fileId) ?? null;
    const fileRead = snapshot.readState.get(group.fileId) ?? readStateOf({ file: group.file, record });
    return groupReadState(group, fileRead, record);
}

/**
 * Покрыты ли просмотром все карточки записи маршрута. Generated-дефолт остановку не закрывает:
 * это умолчание, а не прочтение.
 */
export function stopCoveredByProgress(entry: RouteEntry, snapshot: StopCoverageSnapshot): boolean {
    // Запись, которую держат одни конфликты (docs/design/SPEC-elements.md §4.1): читаемых диапазонов в ней нет —
    // требовать прочтения того, что вне покрытия, гардрейл не вправе.
    if (conflictsOnlyEntry(entry)) {
        return true;
    }
    const groups = entryGroups(entry);
    if (groups.length === 0) {
        return false;
    }

    return groups.every((group) => {
        const read = cardReadState(group, snapshot);
        if (read.generatedDefault) {
            return groupCoverage(group, snapshot.progress.get(group.fileId) ?? null).state === 'read';
        }
        return read.state === 'read';
    });
}

/**
 * Чем отмечается карточка файла в записи маршрута: своими строками или, у нетекстового файла, —
 * пином всего файла (строк у него нет, а карточка показывает его целиком). Неразобранному файлу
 * отмечать нечего, пока нет модели, — тумблер выключен, как у остановки с таким файлом.
 */
export type CardViewedMark = 'ranges' | 'pin' | 'pending' | 'parseFailed';

export function cardViewedMark(
    group: RouteFileGroup,
    model: DiffFileModel | null,
    parseFailed: boolean,
): CardViewedMark {
    if (model === null) {
        return parseFailed ? 'parseFailed' : 'pending';
    }
    return group.seenRanges.length === 0 ? 'pin' : 'ranges';
}

/** Все файлы записи ушли в конфликты: карточек нет и прочитать в ней нечего. */
function conflictsOnlyEntry(entry: RouteEntry): boolean {
    return entry.kind === 'stop'
        ? entry.view.files.length === 0 && entry.view.conflictPaths.length > 0
        : entry.view.files.length === 0 && entry.view.conflictFiles > 0;
}
