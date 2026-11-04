import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { formatCommand } from './command.js';

it('runs a standalone node entry through a shell when paths and arguments contain spaces or quotes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devflow skill's "));
    try {
        const entry = path.join(dir, 'bin with spaces.mjs');
        await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
        const output = execFileSync('sh', ['-c', formatCommand(entry, 'task', 'two words', "it's ready")], { encoding: 'utf8' });
        expect(JSON.parse(output)).toEqual(['task', 'two words', "it's ready"]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
