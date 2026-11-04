import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { expect, it } from 'vitest';

import { parseArcEntryArgs, runArcEntry } from './src/arc-entry.mjs';

const base = '0ec3cb9956cd2078984f407c364c9d707caedf18';
const head = 'ea4fcd93021bb4605cabfcbc7b80fe051d288f05';
const pr = '16729612';

it('accepts a PR number or URL with one native checkout directory', () => {
    expect(parseArcEntryArgs([pr, '--arc-dir', '/arc/billing', '--lang', 'ru'])).toMatchObject({ prId: pr, arcDir: '/arc/billing', lang: 'ru' });
    expect(parseArcEntryArgs([`https://a.yandex-team.ru/review/${pr}/files`, '--no-open'])).toMatchObject({ prId: pr, noOpen: true });
    expect(() => parseArcEntryArgs(['https://example.com/review/1'])).toThrow('Expected an Arcanum PR');
    expect(() => parseArcEntryArgs([pr, '--diff-set', 'draft'])).toThrow('positive numeric');
});

it('pins latest published native diff, exports it, invokes standalone CLI, and removes private export', async () => {
    const calls = [];
    const output = [];
    let manifest;
    let exportOptions;
    const invoke = (file, args, cwd) => {
        calls.push({ file, args, cwd });
        if (file === 'arc') return { status: 0, stdout: JSON.stringify({ repository: 'arcadia' }), stderr: '' };
        if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify([
            { id: 39933879, pull_request_id: 16729612, published: true },
            { id: 39940000, pull_request_id: 16729612, published: false },
            { id: 39898740, pull_request_id: 16729612, published: true },
        ]), stderr: '' };
        if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: 39933879, commit_ids: { base, merge: head } }), stderr: '' };
        if (file === process.execPath) return { status: 0, stdout: 'http://127.0.0.1:4000/#t=new&code=pinned\n', stderr: '' };
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    };
    const code = await runArcEntry([`https://a.yandex-team.ru/review/${pr}`, '--arc-dir', '/arc/billing', '--harness', 'codex', '--model', 'gpt-6', '--lang', 'ru', '--no-open'], {
        invoke,
        cliEntry: '/installed skill/bin/devflow-diff-explain.mjs',
        exportSnapshot: async (options) => {
            exportOptions = options;
            const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-arc-export-'));
            manifest = path.join(root, 'manifest.json');
            await fs.writeFile(manifest, '{}');
            return manifest;
        },
        out: (text) => output.push(text),
        err: (text) => output.push(`ERROR: ${text}`),
    });
    expect(code).toBe(0);
    expect(exportOptions).toMatchObject({ cwd: '/arc/billing', project: `arcanum-${pr}`, diffId: '39933879', baseCommit: base, headCommit: head });
    expect(calls.find((call) => call.file === process.execPath).args).toEqual([
        '/installed skill/bin/devflow-diff-explain.mjs', 'up', '--snapshot', manifest,
        '--harness', 'codex', '--model', 'gpt-6', '--lang', 'ru', '--no-open',
    ]);
    expect(output).toEqual(['http://127.0.0.1:4000/#t=new&code=pinned\n']);
    await expect(fs.stat(path.dirname(manifest))).rejects.toThrow();
});

it('selects an explicitly named published iteration and refuses a draft', async () => {
    const make = async (diffSet) => {
        const errors = [];
        let exported = false;
        const code = await runArcEntry([pr, '--diff-set', diffSet], {
        cwd: '/arc/billing',
        invoke: (file, args) => {
            if (file === 'arc') return { status: 0, stdout: JSON.stringify({ repository: 'arcadia' }), stderr: '' };
            if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify([
                { id: 39933879, published: true }, { id: 39940000, published: false },
            ]), stderr: '' };
            if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: 39933879, commit_ids: { base, merge: head } }), stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        },
            exportSnapshot: async () => { exported = true; throw new Error('export reached'); },
            out: () => undefined, err: (text) => errors.push(text),
        });
        return { code, exported, errors: errors.join('') };
    };
    expect(await make('39940000')).toMatchObject({ code: 1, exported: false });
    expect(await make('39933879')).toMatchObject({ code: 1, exported: true, errors: expect.stringContaining('export reached') });
});

it('preserves native Arc failure detail and tells a caller outside Arc how to select a checkout', async () => {
    const errors = [];
    const code = await runArcEntry([pr], {
        cwd: '/ordinary/project',
        invoke: () => ({ status: 1, stdout: '', stderr: 'Arc RPC denied' }),
        err: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join('')).toContain('Arc RPC denied');
    expect(errors.join('')).toContain('--arc-dir');
});

it('keeps a private export when the local import command fails', async () => {
    let manifest;
    const errors = [];
    try {
        const code = await runArcEntry([pr], {
            cwd: '/arc/billing',
            invoke: (file, args) => {
                if (file === 'arc') return { status: 0, stdout: JSON.stringify({ repository: 'arcadia' }), stderr: '' };
                if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify([{ id: 39933879, published: true }]), stderr: '' };
                if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: 39933879, commit_ids: { base, merge: head } }), stderr: '' };
                return { status: 1, stdout: '', stderr: 'import failed' };
            },
            exportSnapshot: async () => {
                const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-arc-export-'));
                manifest = path.join(root, 'manifest.json');
                await fs.writeFile(manifest, '{}');
                return manifest;
            },
            out: () => undefined, err: (text) => errors.push(text),
        });
        expect(code).toBe(1);
        expect(errors.join('')).toContain(`Export retained at ${manifest}`);
        expect((await fs.stat(manifest)).isFile()).toBe(true);
    } finally {
        if (manifest !== undefined) await fs.rm(path.dirname(manifest), { recursive: true, force: true });
    }
});
