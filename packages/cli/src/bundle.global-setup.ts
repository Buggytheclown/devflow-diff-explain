import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Сборка `dist/devflow-diff-explain.mjs` один раз на весь прогон: файлы тестов идут параллельными форками,
 * а `build.mjs` перезаписывает бандл неатомарно — собирай его каждый файл сам, соседний форк
 * мог бы прочитать усечённый файл.
 */
export function setup(): void {
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}
