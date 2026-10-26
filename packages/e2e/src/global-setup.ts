import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Артефакты, которые e2e гоняет как прод: статика UI и бандл CLI, которым ходит fake-воркер. */
export default async function globalSetup(): Promise<void> {
    await run('pnpm', ['--filter', '@sherpa/ui', 'build'], 'Сборка UI');
    await run(process.execPath, ['build.mjs'], 'Сборка CLI', path.join(REPO_ROOT, 'packages/cli'));
}

function run(command: string, args: readonly string[], what: string, cwd: string = REPO_ROOT): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${what} завершилась с code=${String(code)} signal=${String(signal)}`));
        });
    });
}
