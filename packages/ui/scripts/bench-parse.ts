/**
 * Замер `parseFileDiff` на файлах фикстуры `huge` — цена подсветки в самом тяжёлом диффе.
 * Запуск: `pnpm --filter @sherpa/server exec tsx ../ui/scripts/bench-parse.ts`.
 */
import { fixtureIteration } from '@sherpa/fixtures';

import { toParseRequest } from '../src/diff/model.js';
import { parseFileDiff } from '../src/diff/parse.js';

const files = fixtureIteration('huge').diff.files;
const requests = files.map(toParseRequest);

const WARMUP = 2;
const RUNS = 5;

for (let i = 0; i < WARMUP; i += 1) {
    for (const request of requests) {
        parseFileDiff(request);
    }
}

/** Минимум по прогонам на каждый файл: шум GC и планировщика режется, цена парсинга остаётся. */
const best = new Array<number>(requests.length).fill(Number.POSITIVE_INFINITY);
for (let run = 0; run < RUNS; run += 1) {
    for (const [i, request] of requests.entries()) {
        const started = performance.now();
        parseFileDiff(request);
        best[i] = Math.min(best[i] ?? Number.POSITIVE_INFINITY, performance.now() - started);
    }
}

const sorted = [...best].sort((a, b) => a - b);
const sum = best.reduce((total, ms) => total + ms, 0);
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
const ms = (value: number): string => value.toFixed(2);

console.log(`files: ${String(requests.length)}`);
console.log(`sum:   ${ms(sum)} ms`);
console.log(`avg:   ${ms(sum / requests.length)} ms`);
console.log(`p95:   ${ms(p95)} ms`);
console.log(`max:   ${ms(sorted.at(-1) ?? 0)} ms`);
