import { it, expect } from 'vitest';
import { chatFixtures } from '@sherpa/fixtures';
import { ChatStore } from './chat-store.js';
import { openDatabase } from './db.js';
import { seedAgentNotes } from './test-support.js';

it('исторические заметки остаются в БД, чтение чата не переносит и не создаёт их', () => {
    const db = openDatabase(':memory:');
    try {
        const notes = chatFixtures('medium')?.notes ?? [];
        seedAgentNotes(db, notes);
        const before = db.prepare('SELECT * FROM agent_notes ORDER BY id').all();
        const store = new ChatStore({ db });
        expect(store.read().notes).toEqual([]);
        store.close();
        const reopened = new ChatStore({ db });
        expect(reopened.read().exchanges).toHaveLength(notes.length);
        expect(db.prepare('SELECT * FROM agent_notes ORDER BY id').all()).toEqual(before);
        reopened.close();
    } finally { db.close(); }
});
