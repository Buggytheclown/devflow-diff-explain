import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.resolve(packageRoot, '../ui');

/**
 * Сборка `dist/devflow-diff-explain-server.mjs` один раз на весь прогон: файлы тестов идут параллельными форками,
 * а esbuild перезаписывает бандл неатомарно — собирай его каждый файл сам, соседний форк
 * мог бы прочитать усечённый файл.
 *
 * Сборка UI в цепочку сборок не входит (модуль сервера только зашивает готовый `ui/dist`), но
 * `dist` не хранится в git — на чистом чекауте собираем UI здесь, иначе бандлу нечего зашивать.
 */
export function setup(): void {
    if (!existsSync(path.join(uiRoot, 'dist', 'index.html'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build-server.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}
