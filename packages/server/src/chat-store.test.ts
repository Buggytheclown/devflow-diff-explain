import path from 'node:path';

import { chatFixtures, fixtureData } from '@sherpa/fixtures';
import type { PrDiff } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, LEGACY_DIFF_ID, opaqueMap } from './iterations/index.js';
import { makeTempSherpaDir, removeTempSherpaDir, seedAgentNotes } from './test-support.js';

/**
 * Миграция якорей заметок между итерациями. Ожидаемый результат задан фикстурой:
 * `chatFixtures('medium').notesAfterPush` — те же заметки глазами второй итерации.
 */

const DATA = fixtureData('medium');
const NOTES = chatFixtures('medium')?.notes ?? [];
const NOTES_AFTER_PUSH = chatFixtures('medium')?.notesAfterPush ?? [];

function iterationAt(index: number): { diffId: string; baseCommit: string; headCommit: string; diff: PrDiff } {
    const iteration = DATA.iterations[index];
    if (iteration === undefined) {
        throw new Error(`у фикстуры medium нет итерации ${String(index + 1)}`);
    }
    return { ...iteration.iteration, diff: iteration.diff };
}

const V1 = iterationAt(0);
const V2 = iterationAt(1);
const V3 = iterationAt(2);

/** Карта переноса строк между итерациями фикстуры — из её же готового среза. */
function mapBetween(from: typeof V1, to: typeof V1): IterationMap {
    const interdiff = DATA.interdiffs.find((slice) => slice.base === from.diffId && slice.head === to.diffId);
    if (interdiff === undefined) {
        throw new Error(`у фикстуры medium нет среза ${from.diffId}→${to.diffId}`);
    }
    return buildIterationMap({
        interdiff: interdiff.diff,
        fromBaseCommit: from.baseCommit,
        toBaseCommit: to.baseCommit,
    });
}

function fileIdsOf(iteration: typeof V1): (path: string) => string | null {
    const byPath = new Map(iteration.diff.files.map((file) => [file.path, file.fileId]));
    return (path) => byPath.get(path) ?? null;
}

describe('перенос якорей заметок', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: ChatStore;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'chat.db'));
        store = new ChatStore({ db });
    });

    afterEach(async () => {
        store.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function migrate(from: typeof V1, to: typeof V1): { moved: number; lost: number } {
        return store.migrateNotes(from.diffId, to.diffId, mapBetween(from, to), fileIdsOf(to), to.headCommit);
    }

    it('заметки переезжают на вторую итерацию ровно так, как их описывает фикстура', () => {
        seedAgentNotes(db, NOTES);

        const result = migrate(V1, V2);

        expect(result).toEqual({ moved: 4, lost: 1 });
        expect(store.read().notes).toEqual(NOTES_AFTER_PUSH);
    });

    it('исходное место заметки перенос не двигает', () => {
        seedAgentNotes(db, NOTES);

        migrate(V1, V2);

        expect(store.read().notes.map((note) => note.origin)).toEqual(NOTES.map((note) => note.origin));
    });

    it('повторный вызов ничего не находит: заметки уже на новой итерации', () => {
        seedAgentNotes(db, NOTES);
        migrate(V1, V2);
        const revision = store.revision;

        expect(migrate(V1, V2)).toEqual({ moved: 0, lost: 0 });
        expect(store.revision).toBe(revision);
    });

    it('заметка без якоря больше не мигрирует никогда', () => {
        seedAgentNotes(db, NOTES);
        migrate(V1, V2);
        const lost = store.read().notes.filter((note) => note.lostAnchor);

        const second = migrate(V2, V3);

        expect(lost).toHaveLength(1);
        expect(store.read().notes.filter((note) => note.lostAnchor)).toEqual(lost);
        expect(second.lost).toBe(0);
    });

    it('без среза переносить нечем — якорь теряют все', () => {
        seedAgentNotes(db, NOTES);

        const result = store.migrateNotes(V1.diffId, V2.diffId, opaqueMap(), fileIdsOf(V2), V2.headCommit);

        expect(result).toEqual({ moved: 0, lost: NOTES.length });
        expect(store.read().notes.every((note) => note.lostAnchor)).toBe(true);
        // Якорь потерявшей заметки — последний удачный: он остаётся на своей итерации.
        expect(store.read().notes.map((note) => note.anchor)).toEqual(NOTES.map((note) => note.anchor));
    });

    it('перенос на ту же итерацию — не работа', () => {
        seedAgentNotes(db, NOTES);

        expect(store.migrateNotes(V1.diffId, V1.diffId, opaqueMap(), fileIdsOf(V1), V1.headCommit)).toEqual({
            moved: 0,
            lost: 0,
        });
    });

    it('перенос двигает ревизию один раз на всю пачку', () => {
        seedAgentNotes(db, NOTES);
        const before = store.revision;

        migrate(V1, V2);

        expect(store.revision).toBe(before + 1);
    });
});

describe('усыновление якорей старого формата', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: ChatStore;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'legacy.db'));
        store = new ChatStore({ db });
    });

    afterEach(async () => {
        store.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    /** Якорь старого формата: итерацию он не называет вовсе. */
    function seedLegacy(): void {
        const note = NOTES[0];
        if (note === undefined) {
            throw new Error('фикстуре medium нужна хотя бы одна заметка');
        }
        const legacy = JSON.stringify({ ...note.anchor, diffId: undefined });
        db.prepare(
            `INSERT INTO chat_exchanges (
                id, question, anchor, status, answer, progress_text, error, task_id, head_commit, created_at, updated_at
             ) VALUES (1, 'вопрос', ?, 'done', 'ответ', NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(legacy, note.createdAt, note.createdAt);
        db.prepare(
            `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
             VALUES (1, 1, ?, 'ответ', NULL, ?)`,
        ).run(legacy, note.createdAt);
    }

    it('якорь без итерации усыновляет активная — и текущий, и исходный', () => {
        seedLegacy();
        expect(store.read().notes[0]?.anchor.diffId).toBe(LEGACY_DIFF_ID);

        expect(store.adoptLegacyAnchors(V2.diffId)).toBe(1);

        const note = store.read().notes[0];
        expect(note?.anchor.diffId).toBe(V2.diffId);
        expect(note?.origin.anchor.diffId).toBe(V2.diffId);
        // Строки усыновление не двигает: якорь тот же, у него лишь появилась итерация.
        expect(note?.anchor.start).toBe(NOTES[0]?.anchor.start);
    });

    it('повторный вызов усыновлять уже некого', () => {
        seedLegacy();
        store.adoptLegacyAnchors(V2.diffId);
        const revision = store.revision;

        expect(store.adoptLegacyAnchors(V2.diffId)).toBe(0);
        expect(store.revision).toBe(revision);
    });
});
