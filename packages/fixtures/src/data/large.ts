import type { FileDiff, LensZone, Thread } from '@sherpa/protocol';

import { anchor, bot, comment, human, lens, singleIteration, thread } from '../builders.js';
import type { SyntheticParams } from './synthetic.js';
import { modulePathOf, synthesizeFiles } from './synthetic.js';
import type { FixtureDataInput } from './types.js';

/**
 * Большой PR для виртуализации (`docs/design/SPEC-elements.md §8` п. 8: 60+ файлов при 60fps) и перф-прогона.
 * Собран общим генератором `synthesizeFiles`: содержимое считается из индекса файла —
 * мегабайтов в репозитории нет, но результат байт-в-байт одинаков между запусками.
 */

const PR_ID = '5310';
const DIFF_ID = '201877';
const UPDATED_AT = '2026-08-19T11:02:00.000Z';
const MODULES = 16;
const FILES_PER_MODULE = 4;
export const LARGE_FILE_COUNT = MODULES * FILES_PER_MODULE;

const ROOT = 'services/orders/src/modules';
const FILE_KINDS = ['service.ts', 'repository.ts', 'mapper.ts', 'index.test.ts'] as const;

function modulePath(moduleIndex: number): string {
    return modulePathOf(ROOT, moduleIndex);
}

/** Файл с длинными строками для галереи и браузерных проверок переноса. */
export const LONG_LINE_FILE_PATH = `${modulePath(0)}/repository.ts`;
export { LONG_LINE_MARKER } from './synthetic.js';
const LONG_LINE_FILE_INDEX = 1;

const PARAMS: SyntheticParams = {
    diffId: DIFF_ID,
    root: ROOT,
    modules: MODULES,
    filesPerModule: FILES_PER_MODULE,
    fileKinds: FILE_KINDS,
    // Каждый восьмой файл — машинный: должно быть на чём проверять свёртку generated.
    generatedAt: (index) => index % 8 === 7,
    // Первый файл каждого модуля — новый, остальные правятся: получается смесь add/modify.
    changeTypeAt: (index) => (index % FILES_PER_MODULE === 0 ? 'add' : 'modify'),
    sizeAt: (index) => ({
        additions: 24 + (index % 17),
        deletions: index % FILES_PER_MODULE === 0 ? 0 : 4 + (index % 9),
        hunks: 1,
    }),
    context: 3,
    viewedAt: (index, changeType) => changeType === 'modify' && index % 5 === 0,
    longLinesAt: (index) => index === LONG_LINE_FILE_INDEX,
    sectionAt: (moduleIndex) => `export class Module${String(moduleIndex + 1)}`,
};

function threads(): Thread[] {
    const reviewer = human('alice', 'Alice Ingram');
    const author = human('victor', 'Victor Tran');

    return [
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(0)}/service.ts`, { side: 'new', line: 7 }),
            root: comment({
                id: '5300140',
                author: reviewer,
                body: 'Sixty-four files of the same refactoring — could the mechanical part have been a codemod?',
                createdAt: '2026-08-19T10:00:00.000Z',
                replies: [
                    comment({
                        id: '5300158',
                        author,
                        body: 'It was; the codemod output is everything except the four `mapper.ts` files.',
                        createdAt: '2026-08-19T10:22:00.000Z',
                    }),
                ],
            }),
        }),
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(9)}/repository.ts`, { side: 'new', line: 15 }),
            resolved: true,
            resolvedBy: author.login,
            root: comment({
                id: '5300171',
                author: reviewer,
                body: 'This module still returns the old DTO shape.',
                createdAt: '2026-08-19T10:40:00.000Z',
                issue: true,
                resolved: true,
            }),
        }),
        thread({
            anchor: null,
            root: comment({
                id: '-41903',
                author: reviewer,
                body: 'Please split the generated files into a separate PR next time — they double the review surface.',
                createdAt: '2026-08-19T11:02:00.000Z',
            }),
        }),
        // Дальше — набор состояний резолва по комментарию: на нём будут собираться карточки
        // галереи и UI кнопки Resolve у каждого issue-комментария.
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(1)}/service.ts`, { side: 'new', line: 11 }),
            root: comment({
                id: '5300180',
                author: reviewer,
                body: 'The mapper swallows a null id here — is that intentional?',
                createdAt: '2026-08-19T10:45:00.000Z',
                issue: true,
            }),
        }),
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(2)}/mapper.ts`, { side: 'new', line: 18 }),
            resolved: true,
            resolvedBy: author.login,
            root: comment({
                id: '5300184',
                author: reviewer,
                body: 'Two mappers do the same thing now.',
                createdAt: '2026-08-19T10:47:00.000Z',
                issue: true,
                resolved: true,
                replies: [
                    comment({
                        id: '5300185',
                        author,
                        body: 'Merged them in the last push.',
                        createdAt: '2026-08-19T10:52:00.000Z',
                    }),
                ],
            }),
        }),
        // Корень закрыт, а issue ответа открыт: по правилу тред остаётся открытым.
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(3)}/repository.ts`, { side: 'new', line: 21 }),
            root: comment({
                id: '5300190',
                author: reviewer,
                body: 'The retry loop has no ceiling.',
                createdAt: '2026-08-19T10:50:00.000Z',
                issue: true,
                resolved: true,
                replies: [
                    comment({
                        id: '5300191',
                        author: reviewer,
                        body: 'And the new ceiling is not covered by a test.',
                        createdAt: '2026-08-19T10:58:00.000Z',
                        issue: true,
                    }),
                ],
            }),
        }),
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(4)}/index.test.ts`, { side: 'new', line: 16 }),
            root: comment({
                id: '5300194',
                author: reviewer,
                body: 'Nice, this test reads well.',
                createdAt: '2026-08-19T10:55:00.000Z',
            }),
        }),
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(5)}/service.ts`, { side: 'new', line: 13 }),
            root: comment({
                id: '5300198',
                author: bot('ai-review-bot-canary', 'AI Review (canary)'),
                body: 'The error branch of `loadOrder` is not covered by tests.',
                createdAt: '2026-08-19T10:57:00.000Z',
                issue: true,
            }),
        }),
        // Закрытый тред, в котором я отвечал: на нём галерея заводит черновик-ответ мутацией —
        // черновиков в исходных данных фикстур не бывает (инвариант `fixtures.test.ts`).
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(6)}/mapper.ts`, { side: 'new', line: 17 }),
            resolved: true,
            resolvedBy: reviewer.login,
            root: comment({
                id: '5300202',
                author,
                body: 'Renamed the field to match the new contract.',
                createdAt: '2026-08-19T10:59:00.000Z',
                issue: true,
                resolved: true,
                replies: [
                    comment({
                        id: '5300203',
                        author: reviewer,
                        body: 'Then the changelog line about the old name is stale — fixed in the last push.',
                        createdAt: '2026-08-19T11:01:00.000Z',
                    }),
                ],
            }),
        }),
    ];
}

export function makeLargeFixture(): FixtureDataInput {
    const files: FileDiff[] = synthesizeFiles(PARAMS).map((entry) => entry.file);

    const reviewer = human('alice', 'Alice Ingram');
    const zones: LensZone[] = Array.from({ length: MODULES }, (_, moduleIndex) => {
        const path = modulePath(moduleIndex);
        const mine = moduleIndex % 2 === 0;
        return {
            path,
            mine,
            owner: mine ? 'checkout-platform' : 'checkout-runtime',
            paths: files.filter((file) => !file.generated && file.path.startsWith(`${path}/`)).map((file) => file.path),
        };
    });
    const minePaths = zones.filter((zone) => zone.mine).flatMap((zone) => zone.paths);

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Migrate checkout modules to the new repository interface',
            author: human('victor', 'Victor Tran'),
            fromBranch: 'victor/repository-migration',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'review_in_progress',
            checks: 'failed',
            updatedAt: UPDATED_AT,
            capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
            verdicts: [],
        },
        iterations: singleIteration(
            {
                diffId: DIFF_ID,
                baseCommit: '77a1c4e8b0d3529f6e1a8c4b2d70f3915ae6c8d4',
                headCommit: 'e51b3d7092c4a6f8b1d05e37c9a24608bd173902',
                files,
            },
            threads(),
            UPDATED_AT,
        ),
        interdiffs: [],
        ownership: lens({
            id: 'mine',
            label: 'My files',
            paths: minePaths,
            zones,
        }),
        extraLenses: [
            lens({
                id: 'pci',
                label: 'PCI DSS',
                available: false,
                note: 'No files of this PR are in the PCI DSS scope.',
            }),
        ],
        currentUser: reviewer,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
