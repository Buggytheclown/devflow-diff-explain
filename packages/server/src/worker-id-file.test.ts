import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcFailure } from './errors.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { writeWorkerIdFile } from './worker-id-file.js';

/** Файл идентичности сессии: его читает следующий вызов CLI, поэтому важны и содержимое, и права. */
describe('файл идентичности воркера', () => {
    let tempDir: string;
    let stateDir: string;
    let filePath: string;

    beforeEach(async () => {
        tempDir = await makeTempSherpaDir();
        stateDir = path.join(tempDir, 'state');
        filePath = path.join(stateDir, 'worker-id');
    });

    afterEach(async () => {
        await removeTempSherpaDir(tempDir);
    });

    function modeOf(target: string): number {
        return fs.statSync(target).mode & 0o777;
    }

    it('пишет id с переводом строки и права 0600', () => {
        writeWorkerIdFile(filePath, 'w-42');

        // Именно `<id>\n`: читатель отрезает ровно один перевод строки.
        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-42\n');
        expect(modeOf(filePath)).toBe(0o600);
    });

    it('перезапись чужого файла возвращает права 0600', () => {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(filePath, 'w-old\n', { mode: 0o644 });
        fs.chmodSync(filePath, 0o644);

        writeWorkerIdFile(filePath, 'w-new');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-new\n');
        // `writeFileSync` права существующего файла не трогает — их доставляет явный chmod.
        expect(modeOf(filePath)).toBe(0o600);
    });

    it('снесённый каталог стейта досоздаётся с правами 0700', () => {
        writeWorkerIdFile(filePath, 'w-1');
        fs.rmSync(stateDir, { recursive: true, force: true });

        writeWorkerIdFile(filePath, 'w-2');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-2\n');
        expect(modeOf(stateDir)).toBe(0o700);
    });

    it('каталог на месте файла — RpcFailure с кодом internal и путём в сообщении', () => {
        fs.mkdirSync(filePath, { recursive: true });

        try {
            writeWorkerIdFile(filePath, 'w-1');
            expect.unreachable('запись поверх каталога обязана упасть');
        } catch (error) {
            expect(error).toBeInstanceOf(RpcFailure);
            expect((error as RpcFailure).code).toBe('internal');
            expect((error as RpcFailure).message).toContain(filePath);
        }
    });
});
