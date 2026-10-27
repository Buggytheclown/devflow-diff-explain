import type { Thread } from '@sherpa/protocol';

import { anchor, comment, human, lens, singleIteration, thread } from '../builders.js';
import { tsLines } from '../content.js';
import type { FileSpec } from '../patch.js';
import { makeFileDiff } from '../patch.js';
import type { FixtureDataInput } from './types.js';

/**
 * Эдж-кейсы формы PR и краёв дифф-рендера (`docs/architecture.md §2.11, §2.14`): переименование,
 * удаление, binary, whitespace-only, односторонний файл (только добавления), пустой файл,
 * конфликт, смена режима. Всё, что UI обязан показать нотисом, а не пустой карточкой.
 *
 * Стики-шипа нет в режимах публикации (`publishVerdicts`) — единственная фикстура, на которой видно,
 * как UI гасит недоступный на этом PR вердикт.
 */

const PR_ID = '5122';
const DIFF_ID = '196301';
const UPDATED_AT = '2026-08-19T13:20:00.000Z';

/** Число из примера `docs/architecture.md` («2,412 changed lines — open file»). */
const HUGE_FILE_LINES = 2412;

const FILES: readonly FileSpec[] = [
    {
        // Переименование с правкой: старый путь показывается «old → new».
        path: 'services/orders/src/infra/time/clock.ts',
        oldPath: 'services/orders/src/infra/clock.ts',
        changeType: 'move',
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' export interface Clock {',
                    '-    now(): Date;',
                    '+    now(): Date;',
                    '+    timezone(): string;',
                    ' }',
                ],
            },
        ],
    },
    {
        // Удаление целиком: в карточке только −N и зачёркнутое имя.
        path: 'services/orders/src/legacy/edit-window-v1.ts',
        changeType: 'delete',
        hunks: [
            {
                oldStart: 1,
                newStart: 0,
                lines: [
                    '-import { Order } from "../domain/order";',
                    '-',
                    '-/** Superseded by domain/edit-window.ts. */',
                    '-export function canEdit(order: Order, hours: number): boolean {',
                    '-    const deadline = order.checkoutAt.getTime() + hours * 3600_000;',
                    '-    return Date.now() < deadline;',
                    '-}',
                ],
            },
        ],
    },
    {
        // Binary: патча нет вовсе, UI рисует «binary file not shown» + дельту размера.
        path: 'services/orders/assets/edit-window-flow.png',
        changeType: 'modify',
        binary: true,
    },
    {
        // Пробельные правки: однострочный нотис, свёрнут по умолчанию.
        path: 'services/orders/src/api/schemas.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 12,
                newStart: 12,
                section: 'export const orderItemSchema',
                lines: [
                    ' export const orderItemSchema = z.object({',
                    '-    sku: z.string(), ',
                    '-    quantity: z.number().int().positive(),   ',
                    '+    sku: z.string(),',
                    '+    quantity: z.number().int().positive(),',
                    ' });',
                ],
            },
        ],
    },
    {
        // Односторонний файл: только добавления — в split-режиме рисуется во всю ширину.
        path: 'services/orders/docs/rollout.md',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+# Rollout',
                    '+',
                    '+1. Ship behind `checkout_edit_window` (off).',
                    '+2. Enable for internal accounts, watch `checkout.edit_window.rejected`.',
                    '+3. Ramp to 100% over three days.',
                ],
            },
        ],
    },
    {
        // Пустой файл: текстового диффа нет — `patch: null` при нулевых счётчиках.
        path: 'services/orders/src/infra/time/index.ts',
        changeType: 'add',
    },
    {
        // Конфликт: файл исключается из математики покрытия маршрута.
        path: 'services/orders/src/domain/order.ts',
        changeType: 'conflict',
        hunks: [
            {
                oldStart: 34,
                newStart: 34,
                section: 'export interface Order',
                lines: [
                    ' export interface Order {',
                    '+<<<<<<< HEAD',
                    '+    readonly slot: DeliverySlot | null;',
                    '+=======',
                    '+    readonly slot?: DeliverySlot;',
                    '+>>>>>>> main',
                    '     readonly items: readonly OrderItem[];',
                    ' }',
                ],
            },
        ],
    },
    {
        // Файл выше порога свёртки: карточка открывается свёрнутой
        // с «2 412 изменённых строк — открыть файл».
        path: 'services/orders/src/payments/generated/psp-client.ts',
        changeType: 'add',
        generated: true,
        hunks: [{ oldStart: 0, newStart: 1, lines: tsLines('+', HUGE_FILE_LINES) }],
    },
    {
        // Смена режима без изменения содержимого: патч — одна шапка `old mode`/`new mode`,
        // ханков нет, счётчики нулевые. UI показывает это однострочным нотисом.
        path: 'services/orders/scripts/rollout.sh',
        changeType: 'modify',
        oldMode: '100644',
        mode: '100755',
    },
];

export function makeEdgeFixture(): FixtureDataInput {
    const reviewer = human('alice', 'Alice Ingram');
    const author = human('avery', 'Avery Vance');

    const threads: Thread[] = [
        thread({
            // Комментарий на весь файл: якорь есть, позиции нет.
            anchor: anchor(DIFF_ID, 'services/orders/assets/edit-window-flow.png'),
            root: comment({
                id: '5120018',
                author: reviewer,
                body: 'The diagram still shows the old two-hour window.',
                createdAt: '2026-08-19T13:05:00.000Z',
            }),
        }),
        thread({
            // Тред на удалённый файл: якорь на старой стороне.
            anchor: anchor(DIFF_ID, 'services/orders/src/legacy/edit-window-v1.ts', {
                side: 'old',
                line: 5,
                size: 2,
            }),
            outdated: true,
            root: comment({
                id: '5120024',
                author: author,
                body: 'Deleting this also removes the last caller of `Date.now()` in the domain layer.',
                createdAt: '2026-08-19T13:12:00.000Z',
            }),
        }),
    ];

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Move the clock into infra/time and drop the legacy edit window',
            author,
            fromBranch: 'avery/clock-move',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'needs_work',
            checks: null,
            updatedAt: UPDATED_AT,
            capabilities: { publishVerdicts: ['comment', 'ship', 'request_changes'], fileViewedSync: true, fileContent: false, commentIssues: false, commentResolve: false, editPublished: true, iterations: false, blobs: false },
            verdicts: [],
        },
        iterations: singleIteration(
            {
                diffId: DIFF_ID,
                baseCommit: '1d9f4b60c3a785e2f4b8d016c9a3e57b2048df61',
                headCommit: 'ab3e7c015d924f6b8e0a1c73d5628f409b1ec7a2',
                files: FILES.map((spec) => makeFileDiff(DIFF_ID, spec)),
            },
            threads,
            UPDATED_AT,
        ),
        interdiffs: [],
        // Ревьюер без зоны: линза «мои файлы» выключена с объяснением (`docs/architecture.md`).
        ownership: lens({
            id: 'mine',
            label: 'My files',
            available: false,
            note: 'You do not own any CODEOWNERS zone touched by this PR.',
            zones: [
                {
                    path: 'services/orders/src/infra/time',
                    mine: false,
                    owner: 'checkout-infra',
                    paths: [
                        'services/orders/src/infra/time/clock.ts',
                        'services/orders/src/infra/time/index.ts',
                    ],
                },
                {
                    path: 'services/orders/src/domain',
                    mine: false,
                    owner: 'checkout-domain',
                    paths: ['services/orders/src/domain/order.ts'],
                },
                {
                    path: 'services/orders/src/api',
                    mine: false,
                    owner: null,
                    paths: ['services/orders/src/api/schemas.ts'],
                },
            ],
        }),
        extraLenses: [],
        currentUser: reviewer,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
