import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { AgentNote } from '@sherpa/protocol';

import type { SherpaDatabase } from './db.js';
import { isProcessAlive } from './manifest.js';

/** Временный корень стейта на один тест. */
export async function makeTempSherpaDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-test-'));
}

export async function removeTempSherpaDir(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
}

/** PID гарантированно мёртвого процесса: поднимаем короткоживущий node и ждём, пока он исчезнет. */
export async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error('не удалось запустить процесс для получения мёртвого PID');
    }

    await new Promise<void>((resolve) => {
        child.once('exit', () => {
            resolve();
        });
    });

    for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
        await delay(20);
    }
    if (isProcessAlive(pid)) {
        throw new Error(`процесс ${String(pid)} не завершился — тест на протухший манифест не подготовить`);
    }
    return pid;
}

/** GET на локальный сервер; токен передаётся, только если задан. */
export async function get(port: number, pathname: string, token?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
}

/** POST с сырым телом — им проверяется реакция на невалидный JSON. */
export async function postRaw(
    port: number,
    pathname: string,
    body: string,
    token?: string,
    signal?: AbortSignal,
): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body,
        ...(signal === undefined ? {} : { signal }),
    });
}

export async function postJson(
    port: number,
    pathname: string,
    body: unknown,
    token?: string,
    signal?: AbortSignal,
): Promise<Response> {
    return postRaw(port, pathname, JSON.stringify(body), token, signal);
}

/** PATCH с JSON-телом: им ходит только ручка глобальных настроек UI. */
export async function patchJson(
    port: number,
    pathname: string,
    body: unknown,
    token?: string,
): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
    });
}

/**
 * Кладёт готовые заметки фикстуры в БД вместе с их обменами — так их записал бы принятый
 * ответ агента. Тестам переноса якорей нужны заметки, а не путь, которым они появились.
 */
export function seedAgentNotes(db: SherpaDatabase, notes: readonly AgentNote[]): void {
    for (const note of notes) {
        db.prepare(
            `INSERT INTO chat_exchanges (
                id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                created_at, updated_at
             ) VALUES (?, ?, ?, 'done', ?, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(
            note.exchangeId,
            `вопрос ${String(note.exchangeId)}`,
            JSON.stringify(note.origin.anchor),
            note.text,
            note.origin.commit,
            note.createdAt,
            note.createdAt,
        );
        db.prepare(
            `INSERT INTO agent_notes (
                id, exchange_id, anchor, text, commit_hash, lost_anchor, origin_anchor, origin_commit, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            note.id,
            note.exchangeId,
            JSON.stringify(note.anchor),
            note.text,
            note.origin.commit,
            note.lostAnchor ? 1 : 0,
            JSON.stringify(note.origin.anchor),
            note.origin.commit,
            note.createdAt,
        );
    }
}
