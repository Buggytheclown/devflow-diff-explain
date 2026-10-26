import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = process.argv.indexOf('--target');
const target = path.resolve(option < 0 ? path.join(os.homedir(), '.agents/skills/devflow-diff-explain') : process.argv[option + 1]);
if (!process.argv.includes('--no-build')) {
    execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--filter', '@sherpa/skill', 'build'], { cwd: root, stdio: 'inherit' });
}
const source = path.join(root, 'packages/skill/dist');
const files = ['SKILL.md', 'version.json', 'bin/devflow-diff-explain.mjs', 'bin/devflow-diff-explain-server.mjs'];
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const name of files) if (!fs.statSync(path.join(source, name)).isFile()) throw new Error(`Missing artifact: ${name}`);
const id = randomUUID();
const backup = path.join(os.tmpdir(), 'devflow-diff-explain-backups', id);
const staging = path.join(path.dirname(target), `.devflow-diff-explain-${id}`);
fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
for (const name of files) {
    fs.copyFileSync(path.join(source, name), path.join(staging, name));
    if (digest(path.join(source, name)) !== digest(path.join(staging, name))) throw new Error(`Copy verification failed: ${name}`);
}
fs.chmodSync(path.join(staging, 'bin/devflow-diff-explain.mjs'), 0o755);
fs.mkdirSync(backup, { recursive: true });
if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Expected a standalone skill copy, found a symlink.');
    fs.renameSync(target, path.join(backup, 'previous'));
}
try { fs.renameSync(staging, target); } catch (error) {
    if (fs.existsSync(path.join(backup, 'previous'))) fs.renameSync(path.join(backup, 'previous'), target);
    throw error;
}
if (process.argv.includes('--replace-sherpa')) {
    const legacy = path.join(path.dirname(target), 'sherpa');
    if (fs.existsSync(legacy) && legacy !== target) fs.renameSync(legacy, path.join(backup, 'sherpa'));
}
process.stdout.write(JSON.stringify({ target, version: JSON.parse(fs.readFileSync(path.join(target, 'version.json'), 'utf8')).version, filesVerified: files.length, backup }) + '\n');
