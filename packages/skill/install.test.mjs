import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(packageRoot, '../..');
const installer = join(root, 'scripts/install-local.mjs');
const files = ['SKILL.md', 'version.json', 'bin/devflow-diff-explain.mjs', 'bin/devflow-diff-explain-server.mjs'];
let temp;
const backups = [];
beforeAll(() => {
    if (!existsSync(join(root, 'packages/ui/dist/index.html'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: root, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
    temp = mkdtempSync(join(tmpdir(), 'diff-explain-install-'));
}, 180_000);
afterAll(() => {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
    for (const backup of backups) rmSync(backup, { recursive: true, force: true });
});

it('устанавливает standalone-копию, проверяет состав и сохраняет предыдущую установку вне скиллов', () => {
    const target = join(temp, 'devflow-diff-explain');
    const install = () => {
        const result = JSON.parse(execFileSync(process.execPath, [installer, '--no-build', '--target', target], { encoding: 'utf8' }));
        backups.push(result.backup);
        return result;
    };
    const first = install();
    expect(first.filesVerified).toBe(4);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    for (const name of files) expect(hash(join(target, name))).toBe(hash(join(packageRoot, 'dist', name)));
    expect(lstatSync(join(target, 'bin/devflow-diff-explain.mjs')).mode & 0o111).toBe(0o111);
    writeFileSync(join(target, 'stale'), 'previous');
    const second = install();
    expect(existsSync(join(target, 'stale'))).toBe(false);
    expect(readFileSync(join(second.backup, 'previous/stale'), 'utf8')).toBe('previous');
    expect(second.backup.startsWith(temp)).toBe(false);
});

it('отказывается заменять симлинк и не меняет его цель', () => {
    const target = join(temp, 'link');
    symlinkSync(join(packageRoot, 'dist'), target);
    const result = spawnSync(process.execPath, [installer, '--no-build', '--target', target], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected a standalone skill copy');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
});
