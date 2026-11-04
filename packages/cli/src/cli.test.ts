import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESULT_MAX_BYTES, STRUCTURAL_RESULT_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readResultFile } from './cli.js';
import { CliError } from './errors.js';
import { formatCommand } from './command.js';

describe('пре-чек размера результата', () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-result-'));
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    async function writeResult(name: string, content: string): Promise<string> {
        const file = path.join(workDir, name);
        await fs.writeFile(file, content);
        return file;
    }

    it('ровно лимит проходит, лимит плюс байт — нет', async () => {
        const atLimit = await writeResult('at-limit.md', 'a'.repeat(RESULT_MAX_BYTES));
        const overLimit = await writeResult('over-limit.md', 'a'.repeat(RESULT_MAX_BYTES + 1));

        await expect(readResultFile(atLimit, 42, 'arcanum-1')).resolves.toHaveLength(RESULT_MAX_BYTES);
        await expect(readResultFile(overLimit, 42, 'arcanum-1')).rejects.toThrow('the limit is 256 KB');
    });

    it('размер считается в байтах, а не в символах', async () => {
        // Кириллица — два байта в UTF-8: по длине строки файл в лимит уложился бы.
        const file = await writeResult('utf8.md', 'я'.repeat(RESULT_MAX_BYTES / 2 + 1));

        await expect(readResultFile(file, 42, 'arcanum-1')).rejects.toThrow(CliError);
    });

    it('structural result can exceed the chat cap, but keeps its own cap', async () => {
        const large = await writeResult('route.json', 'x'.repeat(RESULT_MAX_BYTES + 1));
        await expect(readResultFile(large, 42, 'arcanum-1', 'route.prepare')).resolves.toHaveLength(RESULT_MAX_BYTES + 1);
        const oversized = await writeResult('over-route.json', 'x'.repeat(STRUCTURAL_RESULT_MAX_BYTES + 1));
        await expect(readResultFile(oversized, 42, 'arcanum-1', 'route.prepare')).rejects.toThrow('the limit is 16384 KB');
    });

    it('нет файла или это каталог — понятная ошибка с подсказкой', async () => {
        const missing = path.join(workDir, 'нет.md');
        const leaseRef = 'a'.repeat(64);
        await expect(readResultFile(missing, 42, 'arcanum-1', 'chat', leaseRef)).rejects.toThrow(
            `Write the result to ${missing} and call \`${formatCommand(process.argv[1], 'task', 'complete', '42', '--file', missing, '--pr', 'arcanum-1', '--lease', leaseRef)}\` again.`,
        );
        await expect(readResultFile(workDir, 42, 'arcanum-1')).rejects.toThrow('is not a file');
    });
});
