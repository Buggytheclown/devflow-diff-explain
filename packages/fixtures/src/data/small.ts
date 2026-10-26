import type { PrDiff, Thread } from '@sherpa/protocol';

import { anchor, comment, human, lens, singleIteration, thread } from '../builders.js';
import { makeFileDiff } from '../patch.js';
import type { FixtureDataInput } from './types.js';

/**
 * PR ниже порога маршрута (`docs/architecture.md §7.6`: изменённых строк по всем файлам ≤ 40) —
 * UI открывается на полном диффе с пометкой «small PR — no route needed».
 *
 * Заодно это единственная фикстура без синхронизации viewed (`fileViewedSync: false`):
 * `viewed` у файла null, метода `setFileViewed` у хоста нет — деградацию должно быть где щупать.
 */

const PR_ID = '4907';
const DIFF_ID = '190244';

const UPDATED_AT = '2026-08-20T07:18:00.000Z';

export function makeSmallFixture(): FixtureDataInput {
    const author = human('dana', 'Dana Stone');
    const reviewer = human('alice', 'Alice Ingram');
    const path = 'services/orders/src/infra/retry.ts';

    const diff: PrDiff = {
        diffId: DIFF_ID,
        baseCommit: '2b7d419e0c5a836f1d4b9e2c7a0f5386d1b4e9c2',
        headCommit: 'c04e17b95d386a2f7c1b8e4d0a396527f8c1d3b6',
        files: [
            makeFileDiff(DIFF_ID, {
                path,
                changeType: 'modify',
                viewed: null,
                hunks: [
                    {
                        oldStart: 9,
                        newStart: 9,
                        section: 'export async function withRetry',
                        lines: [
                            ' export async function withRetry<T>(call: () => Promise<T>): Promise<T> {',
                            '     for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {',
                            '         try {',
                            '             return await call();',
                            '         } catch (error) {',
                            '             if (!isTimeout(error) || attempt === MAX_ATTEMPTS - 1) {',
                            '                 throw error;',
                            '             }',
                            '-            await sleep(BASE_DELAY_MS * 2 ** attempt);',
                            '+            await sleep(backoffWithJitter(attempt));',
                            '         }',
                            '     }',
                            ' ',
                            '     throw new Error("unreachable");',
                            ' }',
                            '+',
                            '+/** Full jitter: without it every client retries in the same millisecond. */',
                            '+function backoffWithJitter(attempt: number): number {',
                            '+    const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);',
                            '+    return Math.round(random() * ceiling);',
                            '+}',
                        ],
                    },
                ],
            }),
        ],
    };

    const threads: Thread[] = [
        thread({
            anchor: anchor(DIFF_ID, path, { side: 'new', line: 17 }),
            root: comment({
                id: '4901022',
                author: reviewer,
                body: 'Full jitter can return 0 — is an immediate retry acceptable for the PSP?',
                createdAt: '2026-08-20T07:31:00.000Z',
            }),
        }),
    ];

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Retry PSP timeouts with jitter',
            author,
            fromBranch: 'dana/psp-retry-jitter',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'waiting_for_review',
            checks: 'pending',
            updatedAt: UPDATED_AT,
            capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: false, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
            verdicts: [],
        },
        iterations: singleIteration(diff, threads, UPDATED_AT),
        interdiffs: [],
        ownership: lens({
            id: 'mine',
            label: 'My files',
            paths: [path],
            zones: [{ path: 'services/orders/src/infra', mine: true, owner: 'checkout-infra', paths: [path] }],
        }),
        extraLenses: [
            lens({
                id: 'pci',
                label: 'PCI DSS',
                available: false,
                note: 'The PCI DSS scope is not published for this commit yet.',
            }),
        ],
        currentUser: reviewer,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
