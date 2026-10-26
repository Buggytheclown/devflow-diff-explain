import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readResultFile } from './cli.js';
import { CliError } from './errors.js';

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

        await expect(readResultFile(atLimit, 42)).resolves.toHaveLength(RESULT_MAX_BYTES);
        await expect(readResultFile(overLimit, 42)).rejects.toThrow('the limit is 256 KB');
    });

    it('размер считается в байтах, а не в символах', async () => {
        // Кириллица — два байта в UTF-8: по длине строки файл в лимит уложился бы.
        const file = await writeResult('utf8.md', 'я'.repeat(RESULT_MAX_BYTES / 2 + 1));

        await expect(readResultFile(file, 42)).rejects.toThrow(CliError);
    });

    it('нет файла или это каталог — понятная ошибка с подсказкой', async () => {
        const missing = path.join(workDir, 'нет.md');
        await expect(readResultFile(missing, 42)).rejects.toThrow(
            `Write the result to ${missing} and call \`devflow-diff-explain task complete 42 --file ${missing}\` again.`,
        );
        await expect(readResultFile(workDir, 42)).rejects.toThrow('is not a file');
    });
});
