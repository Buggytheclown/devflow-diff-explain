import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportArcSnapshot } from './arc-export.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const LINK_A = 'c'.repeat(40);
const LINK_B = 'd'.repeat(40);
const text = (value) => Buffer.from(value, 'utf8');
const entry = (name, mode = '100644', type = 'blob', hash = '1'.repeat(40)) => ({ name, mode, type, hash });

async function fixture(data) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-export-test-'));
    const arcBinary = path.join(root, 'fake-arc.mjs');
    const calls = path.join(root, 'calls.jsonl');
    const script = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const data = ${JSON.stringify(data)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'info') process.stdout.write(JSON.stringify({ repository: 'arcadia' }));
else if (args[0] === 'root') process.stdout.write(${JSON.stringify(root)} + '\\n');
else if (args[0] === 'diff') process.stdout.write(JSON.stringify([{ names:
  args.includes('--resolve-moves=0') ? data.flatInventory ?? data.inventory : data.inventory }]));
else if (args[0] === 'ls-tree') {
  const [revision, rawQuery] = args.slice(2);
  const query = rawQuery.replace(/^\\.\\//, '');
  process.stdout.write(JSON.stringify((data.trees[revision] ?? []).filter((item) => path.posix.dirname(item.name) === query || item.name === query)));
} else if (args[0] === 'export') {
  const revision = args[1];
  const to = args[args.indexOf('--to') + 1];
  for (const argument of args.slice(2, args.indexOf('--to'))) {
    const name = argument.replace(/^\\.\\//, '');
    const bytes = data.shows[revision + ':' + name];
    if (bytes === undefined) { process.stderr.write('missing object'); process.exitCode = 2; break; }
    const destination = path.join(to, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (data.links?.includes(revision + ':' + name)) fs.symlinkSync(Buffer.from(bytes, 'base64').toString('utf8'), destination);
    else fs.writeFileSync(destination, Buffer.from(bytes, 'base64'));
  }
} else process.exitCode = 2;
`;
    await fs.writeFile(arcBinary, script, { mode: 0o700 });
    await fs.chmod(arcBinary, 0o700);
    return { root, arcBinary, calls, remove: () => fs.rm(root, { recursive: true, force: true }) };
}

function completeData() {
    const image = Buffer.from([137, 80, 78, 71, 0, 255, 13, 10]);
    return { image, data: {
        inventory: [
            { status: 'new file', type: 'directory', path: 'service/generated' },
            { status: 'modified', type: 'file', path: 'service/a.ts' },
            { status: 'renamed', type: 'file', path: 'service/new.ts', source: { path: 'service/old.ts' } },
            { status: 'new file', type: 'file', path: 'image.png' },
            { status: 'new file', type: 'file', path: 'links/current' },
            { status: 'modified', type: 'file', path: 'vendor/sub' },
        ],
        trees: {
            [BASE]: [entry('service/a.ts'), entry('service/old.ts'), entry('vendor/sub', '160000', 'commit', LINK_A)],
            [HEAD]: [entry('service/a.ts', '100755'), entry('service/new.ts'), entry('image.png'),
                entry('links/current', '120000'), entry('vendor/sub', '160000', 'commit', LINK_B)],
        },
        links: [`${HEAD}:links/current`],
        shows: {
            [`${BASE}:service/a.ts`]: text('old\n').toString('base64'),
            [`${HEAD}:service/a.ts`]: text('new\n').toString('base64'),
            [`${BASE}:service/old.ts`]: text('move\n').toString('base64'),
            [`${HEAD}:service/new.ts`]: text('move\n').toString('base64'),
            [`${HEAD}:image.png`]: image.toString('base64'),
            [`${HEAD}:links/current`]: text('../service/new.ts').toString('base64'),
        },
    } };
}

test('exports exact committed text, binary, rename, symlink and gitlink bytes into a private manifest', async () => {
    const { image, data } = completeData();
    const fake = await fixture(data);
    try {
        const manifestPath = await exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'opaque-iteration',
            capturedAt: '2026-11-04T00:00:00.000Z', pr: null });
        try {
            const root = path.dirname(manifestPath);
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            assert.equal(path.basename(root).startsWith('devflow-arc-export-'), true);
            assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
            assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
            assert.equal(manifest.format, 'code-snapshot/1');
            assert.deepEqual(manifest.files.map((file) => [file.changeType, file.path, file.oldPath]), [
                ['modify', 'service/a.ts', null], ['move', 'service/new.ts', 'service/old.ts'],
                ['add', 'image.png', null], ['add', 'links/current', null], ['modify', 'vendor/sub', null],
            ]);
            assert.equal(manifest.files[0].before.mode, undefined);
            assert.equal(manifest.files[0].after.mode, '100755');
            assert.equal(manifest.files[2].after.kind, 'binary');
            assert.equal(manifest.files[3].after.kind, 'symlink');
            assert.equal(manifest.files[4].after.kind, 'gitlink');
            const bytes = (side) => fs.readFile(path.join(root, side.file));
            assert.deepEqual(await bytes(manifest.files[2].after), image);
            assert.deepEqual(await bytes(manifest.files[3].after), text('../service/new.ts'));
            assert.deepEqual(await bytes(manifest.files[4].after), text(LINK_B));
            assert.equal((await fs.stat(path.join(root, manifest.files[2].after.file))).mode & 0o777, 0o600);
            const calls = (await fs.readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
            assert.deepEqual(calls[0].args, ['info', '--json']);
            assert.equal(calls.find((call) => call.args[0] === 'diff')?.cwd, await fs.realpath(fake.root));
            assert.equal(calls.filter((call) => call.args[0] === 'ls-tree' && call.args[2] === BASE && call.args[3] === 'service').length, 1);
            assert.equal(calls.filter((call) => call.args[0] === 'export').length, 2);
            assert.equal(calls.some((call) => call.args[0] === 'export' && call.args.includes('./vendor/sub')), false);
            assert.equal(createHash('sha256').update(await bytes(manifest.files[2].after)).digest('hex'),
                createHash('sha256').update(image).digest('hex'));
        } finally { await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }); }
    } finally { await fake.remove(); }
});

test('fails closed and removes partial export when a committed object mode is unknown', async () => {
    const { data } = completeData();
    data.trees[HEAD].find((item) => item.name === 'service/a.ts').mode = '100664';
    const fake = await fixture(data);
    try {
        await assert.rejects(exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'opaque-iteration' }), /unsupported type\/mode/);
        assert.deepEqual((await fs.readdir(fake.root)).filter((name) => name.startsWith('devflow-arc-export-')), []);
    } finally { await fake.remove(); }
});

test('rejects an unsupported move without its old path before reading objects', async () => {
    const { data } = completeData();
    delete data.inventory[2].source;
    const fake = await fixture(data);
    try {
        await assert.rejects(exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'opaque-iteration' }), /old path/);
        assert.deepEqual((await fs.readdir(fake.root)).filter((name) => name.startsWith('devflow-arc-export-')), []);
    } finally { await fake.remove(); }
});

test('rejects regular-file fallback for a committed symlink without following its target', async () => {
    const { data } = completeData();
    data.links = [];
    const fake = await fixture(data);
    try {
        await assert.rejects(exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'opaque-iteration' }), /did not preserve symlink/);
        assert.deepEqual((await fs.readdir(fake.root)).filter((name) => name.startsWith('devflow-arc-export-')), []);
    } finally { await fake.remove(); }
});

test('exports a deleted file while ignoring Arc deleted-directory markers', async () => {
    const filePath = 'service/removed/file.txt';
    const fake = await fixture({
        inventory: [{ status: 'deleted', type: 'directory', path: 'service/removed' },
            { status: 'new file', type: 'directory', path: filePath },
            { status: 'deleted', type: 'file', path: filePath }],
        trees: { [BASE]: [entry(filePath)], [HEAD]: [] },
        shows: { [`${BASE}:${filePath}`]: text('removed\n').toString('base64') },
    });
    try {
        const manifestPath = await exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'reverse-diff' });
        try {
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            assert.equal(manifest.files.length, 1);
            assert.equal(manifest.files[0].changeType, 'delete');
            assert.equal(manifest.files[0].after, null);
            assert.deepEqual(await fs.readFile(path.join(path.dirname(manifestPath), manifest.files[0].before.file)), text('removed\n'));
            const calls = (await fs.readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
            assert.equal(calls.filter((call) => call.args[0] === 'export').length, 1);
        } finally { await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }); }
    } finally { await fake.remove(); }
});

test('passes a root-level filename beginning with a dash as an Arc path', async () => {
    const filePath = '-old.txt';
    const fake = await fixture({
        inventory: [{ status: 'deleted', type: 'file', path: filePath }],
        trees: { [BASE]: [entry(filePath)], [HEAD]: [] },
        shows: { [`${BASE}:${filePath}`]: text('old\n').toString('base64') },
    });
    try {
        const manifestPath = await exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'dash-path' });
        try {
            const calls = (await fs.readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
            assert.deepEqual(calls.find((call) => call.args[0] === 'ls-tree').args.slice(-1), ['./-old.txt']);
            assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).files.length, 1);
        } finally { await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }); }
    } finally { await fake.remove(); }
});

test('expands collapsed directory moves and copies from the flat Arc inventory', async () => {
    const fake = await fixture({
        inventory: [
            { type: 'directory', status: 'renamed', path: 'dst', source: { path: 'src' } },
            { type: 'directory', status: 'copied', path: 'clone', source: { path: 'template' } },
        ],
        flatInventory: [
            { type: 'file', status: 'deleted', path: 'src/a.txt' },
            { type: 'file', status: 'new file', path: 'dst/a.txt' },
            { type: 'file', status: 'new file', path: 'dst/new.txt' },
            { type: 'file', status: 'new file', path: 'clone/t.txt' },
            { type: 'file', status: 'new file', path: 'clone/new.txt' },
        ],
        trees: {
            [BASE]: [entry('src/a.txt'), entry('template/t.txt')],
            [HEAD]: [entry('dst/a.txt'), entry('dst/new.txt'), entry('clone/t.txt'), entry('clone/new.txt')],
        },
        shows: {
            [`${BASE}:src/a.txt`]: text('a\n').toString('base64'),
            [`${HEAD}:dst/a.txt`]: text('a\n').toString('base64'),
            [`${HEAD}:dst/new.txt`]: text('new\n').toString('base64'),
            [`${BASE}:template/t.txt`]: text('t\n').toString('base64'),
            [`${HEAD}:clone/t.txt`]: text('t\n').toString('base64'),
            [`${HEAD}:clone/new.txt`]: text('novel\n').toString('base64'),
        },
    });
    try {
        const manifestPath = await exportArcSnapshot({ cwd: fake.root, arcBinary: fake.arcBinary, tmpDir: fake.root,
            baseCommit: BASE, headCommit: HEAD, project: 'arcadia-42', diffId: 'directory-move-copy' });
        try {
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            assert.deepEqual(manifest.files.map((file) => [file.path, file.changeType, file.oldPath]), [
                ['dst/a.txt', 'move', 'src/a.txt'], ['dst/new.txt', 'add', null],
                ['clone/t.txt', 'copy', 'template/t.txt'], ['clone/new.txt', 'add', null],
            ]);
            const calls = (await fs.readFile(fake.calls, 'utf8')).trim().split('\n').map(JSON.parse);
            assert.equal(calls.filter((call) => call.args[0] === 'diff').length, 2);
        } finally { await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }); }
    } finally { await fake.remove(); }
});
