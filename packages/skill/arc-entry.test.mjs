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

it('pins the latest diff even when it is a draft, exports it, invokes standalone CLI, and removes private export', async () => {
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
        if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: 39940000, pull_request_id: 16729612, published: false, commit_ids: { base, merge: head } }), stderr: '' };
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
    expect(exportOptions).toMatchObject({ cwd: '/arc/billing', project: `arcanum-${pr}`, diffId: '39940000', baseCommit: base, headCommit: head });
    expect(calls.find((call) => call.file === 'ya' && call.args[3] === 'diff').args).toEqual([
        'tool', 'gena-arcanum-cli', '--json', 'diff', 'get', '39940000', '--fields', 'id,commit_ids(base,merge)',
    ]);
    expect(calls.find((call) => call.file === process.execPath).args).toEqual([
        '/installed skill/bin/devflow-diff-explain.mjs', 'up', '--snapshot', manifest,
        '--harness', 'codex', '--model', 'gpt-6', '--lang', 'ru', '--no-open',
    ]);
    expect(output).toEqual(['http://127.0.0.1:4000/#t=new&code=pinned\n']);
    await expect(fs.stat(path.dirname(manifest))).rejects.toThrow();
});

it('selects a draft-only PR and an explicitly named older published or draft iteration', async () => {
    async function select(rows, requestedDiffSet) {
        let exported;
        const calls = [];
        await runArcEntry([pr, ...(requestedDiffSet === undefined ? [] : ['--diff-set', requestedDiffSet])], {
            cwd: '/arc/billing',
            invoke: (file, args) => {
                calls.push({ file, args });
                if (file === 'arc') return { status: 0, stdout: JSON.stringify({ repository: 'arcadia' }), stderr: '' };
                if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
                if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: Number(args[5]), commit_ids: { base, merge: head } }), stderr: '' };
                throw new Error('unexpected command');
            },
            exportSnapshot: async (options) => { exported = options; throw new Error('selection checked'); },
            out: () => undefined, err: () => undefined,
        });
        return { exported, calls };
    }
    const draftOnly = [{ id: 39940000, published: false }];
    expect((await select(draftOnly)).exported).toMatchObject({ diffId: '39940000', baseCommit: base, headCommit: head });
    const mixed = [
        { id: 39898740, pull_request_id: 16729612, published: false },
        { id: 39933879, pull_request_id: 16729612, published: true },
        { id: 39940000, pull_request_id: 16729612, published: false },
    ];
    expect((await select(mixed, '39933879')).exported).toMatchObject({ diffId: '39933879' });
    expect((await select(mixed, '39898740')).exported).toMatchObject({ diffId: '39898740' });
});

it('rejects a diff-set from another PR even if a native list or detail misreports it', async () => {
    const errors = [];
    let exported = false;
    const code = await runArcEntry([pr, '--diff-set', '39940000'], {
        cwd: '/arc/billing',
        invoke: (file, args) => {
            if (file === 'arc') return { status: 0, stdout: JSON.stringify({ repository: 'arcadia' }), stderr: '' };
            if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify([
                { id: 39940000, pull_request_id: 16729612, published: false },
            ]), stderr: '' };
            return { status: 0, stdout: JSON.stringify({ id: 39940000, pull_request_id: 999, published: false, commit_ids: { base, merge: head } }), stderr: '' };
        },
        exportSnapshot: async () => { exported = true; throw new Error('unexpected export'); },
        out: () => undefined, err: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(exported).toBe(false);
    expect(errors.join('')).toContain('does not belong to PR');
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
                if (file === 'ya' && args[3] === 'pr') return { status: 0, stdout: JSON.stringify([{ id: 39933879, pull_request_id: 16729612, published: true }]), stderr: '' };
                if (file === 'ya' && args[3] === 'diff') return { status: 0, stdout: JSON.stringify({ id: 39933879, pull_request_id: 16729612, published: true, commit_ids: { base, merge: head } }), stderr: '' };
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
