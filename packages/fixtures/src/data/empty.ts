import type { PrDiff } from '@sherpa/protocol';

import { human, lens, singleIteration } from '../builders.js';
import type { FixtureDataInput } from './types.js';

/**
 * PR без единого изменения относительно базы (`docs/architecture.md`): дифф пуст — весь коммит уже в базе
 * (ветку смёржили мимо PR, откатили или пересобрали). Оба вью показывают «Нечего ревьюить»,
 * шип при этом остаётся доступен: одобрять пустоту — законный ход ревьюера.
 *
 * Итерация тут одна и обязана быть: хосту без итераций отдавать нечего (`validate` в index.ts).
 */

const PR_ID = '5120';
const DIFF_ID = '204118';

const UPDATED_AT = '2026-09-02T11:40:00.000Z';

export function makeEmptyFixture(): FixtureDataInput {
    const author = human('dana', 'Dana Stone');
    const reviewer = human('alice', 'Alice Ingram');

    const diff: PrDiff = {
        diffId: DIFF_ID,
        baseCommit: '7c1f4a2b9e0d5386f2a4b8c1d7e930465b8a2f13',
        headCommit: '7c1f4a2b9e0d5386f2a4b8c1d7e930465b8a2f13',
        files: [],
    };

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Revert the checkout slot rollout',
            author,
            fromBranch: 'dana/checkout-slot-revert',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'waiting_for_review',
            checks: 'pending',
            updatedAt: UPDATED_AT,
            capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
            verdicts: [],
        },
        iterations: singleIteration(diff, [], UPDATED_AT),
        interdiffs: [],
        // Зон ответственности без файлов не бывает: линза есть, но пуста.
        ownership: lens({ id: 'mine', label: 'My files', paths: [], zones: [] }),
        extraLenses: [
            lens({
                id: 'pci',
                label: 'PCI DSS',
                available: false,
                note: 'The PCI DSS scope is not published for this commit yet.',
            }),
        ],
        currentUser: reviewer,
        mutationEpoch: '2026-09-02T12:00:00.000Z',
    };
}
