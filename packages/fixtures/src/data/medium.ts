import type { FileDiff, HostId, LensZone, Thread, ThreadPin } from '@sherpa/protocol';

import { anchor, bot, comment, human, lens, thread } from '../builders.js';
import { lockLines } from '../content.js';
import type { FileSpec } from '../patch.js';
import { makeFileDiff, totalChanges } from '../patch.js';
import { PNG_AFTER_BASE64, PNG_BEFORE_BASE64, PNG_DELETED_BASE64, SVG_BASE64, SVG_LINES } from './images.js';
import type { FixtureDataInput, FixtureInterdiff, FixtureIteration } from './types.js';

/**
 * Основная фикстура: PR из дизайн-хендоффа — «Enforce the 30-minute edit window for scheduled
 * deliveries», 18 файлов, `+806 −56` (`docs/design/README.md §1`) плюс три картинки: добавленная svg
 * приносит 6 строк, поэтому заявлено `+812 −56`. Пропорции экрана держатся ровно на этих числах,
 * поэтому итог сверяется тестом, а лок-файл добирает остаток до цели (см. `lockfile`).
 */

const PR_ID = '4821';
const DIFF_ID = '182734';
const BASE_COMMIT = '4c1f0b7a9d3e5f2b8c6a1d4e7f0b3c5a9d2e6f81';
const HEAD_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';

const REPO_URL = 'https://github.com/quillmart/quillmart';

/**
 * Blame есть не у всех файлов фикстуры: действие «Blame» в шапке карточки обязано прятаться,
 * когда хосту нечего предложить (`blameUrl: null`).
 */
const BLAME_PATHS: ReadonlySet<string> = new Set([
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/domain/order.ts',
]);

/** Заявленный размер PR: числа дизайн-хендоффа плюс три картинки. */
export const MEDIUM_TOTALS = { files: 21, additions: 812, deletions: 56 } as const;

/** Итерация, для которой строится маршрут `route-medium.ts`: якоря и снапшот обязаны ссылаться на неё. */
export { BASE_COMMIT as MEDIUM_BASE_COMMIT, DIFF_ID as MEDIUM_DIFF_ID, HEAD_COMMIT as MEDIUM_HEAD_COMMIT };

/**
 * Вторая итерация — обычный пуш поверх первой (`docs/design/README.md §9`: «the PR is now on a71d4e2»);
 * третья — force-push поверх второй, из-за которого хост перестаёт перечислять вторую.
 * База не двигается: перебазирования в этом сценарии нет.
 */
const DIFF_ID_V2 = '182961';
const HEAD_COMMIT_V2 = 'a71d4e2f83b6c05194ad7e2f6b8c3109d4e5a72b';
const DIFF_ID_V3 = '183044';
const HEAD_COMMIT_V3 = 'c4f9b17e5a2d08361bf4e7c9a05d2836f1b7e409';

export { DIFF_ID_V2 as MEDIUM_DIFF_ID_V2, DIFF_ID_V3 as MEDIUM_DIFF_ID_V3 };
export { HEAD_COMMIT_V2 as MEDIUM_HEAD_COMMIT_V2, HEAD_COMMIT_V3 as MEDIUM_HEAD_COMMIT_V3 };

const CREATED_AT_V1 = '2026-08-19T16:42:00.000Z';
const CREATED_AT_V2 = '2026-08-21T11:05:00.000Z';
const CREATED_AT_V3 = '2026-08-21T15:20:00.000Z';

/** Пин тредов первой итерации: он не переезжает вместе с якорем (`docs/design/SPEC-elements.md §4.5` «pinned to 9f3c1ab»). */
const V1_PIN: ThreadPin = { diffId: DIFF_ID, commit: HEAD_COMMIT };

/** Файл, который ушёл из PR со вторым пушем: платёжную часть автор вынес в отдельный PR. */
const DEPARTED_PATH = 'services/orders/src/payments/card-token.ts';

/** Файл, появившийся во второй итерации. */
const ADDED_PATH_V2 = 'services/orders/src/api/rejection-status.ts';

const REVIEWER = human('alice', 'Alice Ingram');
const AUTHOR = human('avery', 'Avery Vance');
const KAI = human('kai', 'Kai Kennedy');
const IRIS = human('iris', 'Iris Park');
const AI_REVIEW = bot('ai-review-bot', 'AI Review (security)');
const LINT_BOT = bot('lint-bot', 'AI Review (style)');

const ROLLOUT_CHECKS = [
    'contract tests',
    'flag defaults off',
    'internal edit',
    'closed-window 409',
    'express-order 400',
    'dispatch closes early',
    'fresh-food override',
    'pharmacy override',
    'advisory countdown',
    'audit actor',
    'audit retention',
    'cache after write',
    'old config unused',
    'contract job green',
    'metrics baseline',
    'internal error budget',
    '10% error budget',
    '50% error budget',
    '100% error budget',
    'flag cleanup filed',
] as const;

/** 63 строки доводят ownership-часть фикстуры до 570 строк из `docs/design/README.md §6`. */
function rolloutChecklistLines(): string[] {
    return [
        '+',
        '+## Operational checklist',
        '+',
        ...ROLLOUT_CHECKS.flatMap((check) => [`+- [ ] ${check}`, '+  Evidence: #2281.', '+']),
    ];
}

/**
 * Картинки PR: правка png с прозрачностью, добавленная svg (у неё есть и текстовый
 * патч — весь файл добавленными строками) и удалённая png. Растровые стороны — двоичные,
 * поэтому патча у них нет вовсе.
 */
const IMAGES: readonly FileSpec[] = [
    {
        path: 'services/orders/src/ui/assets/edit-window-banner.png',
        changeType: 'modify',
        binary: true,
        image: { mime: 'image/png', before: PNG_BEFORE_BASE64, after: PNG_AFTER_BASE64 },
    },
    {
        path: 'services/orders/src/ui/assets/countdown-icon.svg',
        changeType: 'add',
        image: { mime: 'image/svg+xml', after: SVG_BASE64 },
        hunks: [{ oldStart: 0, newStart: 1, lines: SVG_LINES.map((line) => `+${line}`) }],
    },
    {
        path: 'services/orders/src/ui/assets/legacy-window-badge.png',
        changeType: 'delete',
        binary: true,
        image: { mime: 'image/png', before: PNG_DELETED_BASE64 },
    },
];

/** Файлы, которые пишутся руками; лок-файл добавляется отдельно последним. */
const HAND_WRITTEN: readonly FileSpec[] = [
    {
        // Новый файл — один ханк на всё содержимое: контекстных строк у него взяться неоткуда.
        path: 'services/orders/src/domain/edit-window.ts',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+import { Clock } from "../infra/clock";',
                    '+import { Order, DeliverySlot, OrderItem } from "./order";',
                    '+',
                    '+/** How long after checkout the customer may still edit a scheduled delivery. */',
                    '+export const EDIT_WINDOW_MS = 30 * 60 * 1000;',
                    '+',
                    '+/** Categories that close the window earlier than the default 30 minutes. */',
                    '+const CATEGORY_OVERRIDES_MS: Readonly<Record<string, number>> = {',
                    '+    "fresh-food": 10 * 60 * 1000,',
                    '+    pharmacy: 5 * 60 * 1000,',
                    '+};',
                    '+',
                    '+export type EditWindowCause = "deadline" | "dispatch";',
                    '+',
                    '+export type EditWindowState =',
                    '+    | { readonly kind: "open"; readonly closesAt: Date }',
                    '+    | { readonly kind: "closed"; readonly closedAt: Date; readonly cause: EditWindowCause }',
                    '+    | { readonly kind: "not-applicable" };',
                    '+',
                    '+export interface EditWindowInput {',
                    '+    readonly order: Order;',
                    '+    readonly slot: DeliverySlot | null;',
                    '+}',
                    '+',
                    '+export class EditWindow {',
                    '+    constructor(private readonly clock: Clock) {}',
                    '+',
                    '+    /**',
                    '+     * The window opens at checkout time and closes 30 minutes later, but never after the',
                    '+     * courier has been dispatched — dispatch wins even inside the window.',
                    '+     */',
                    '+    state({ order, slot }: EditWindowInput): EditWindowState {',
                    '+        if (slot === null || !slot.scheduled) {',
                    '+            return { kind: "not-applicable" };',
                    '+        }',
                    '+',
                    '+        const closesAt = new Date(order.checkoutAt.getTime() + this.durationMs(order));',
                    '+        if (slot.dispatchedAt !== null && slot.dispatchedAt < closesAt) {',
                    '+            return { kind: "closed", closedAt: slot.dispatchedAt, cause: "dispatch" };',
                    '+        }',
                    '+',
                    '+        return this.clock.now() < closesAt',
                    '+            ? { kind: "open", closesAt }',
                    '+            : { kind: "closed", closedAt: closesAt, cause: "deadline" };',
                    '+    }',
                    '+',
                    '+    remainingMs(input: EditWindowInput): number {',
                    '+        const state = this.state(input);',
                    '+        if (state.kind !== "open") {',
                    '+            return 0;',
                    '+        }',
                    '+        return state.closesAt.getTime() - this.clock.now().getTime();',
                    '+    }',
                    '+',
                    '+    /**',
                    '+     * The shortest window wins: one fresh-food item closes the whole order in 10 minutes,',
                    '+     * even if the rest of the basket is regular.',
                    '+     */',
                    '+    private durationMs(order: Order): number {',
                    '+        let shortest = EDIT_WINDOW_MS;',
                    '+        for (const item of order.items) {',
                    '+            const override = CATEGORY_OVERRIDES_MS[categoryOf(item)];',
                    '+            if (override !== undefined && override < shortest) {',
                    '+                shortest = override;',
                    '+            }',
                    '+        }',
                    '+        return shortest;',
                    '+    }',
                    '+}',
                    '+',
                    '+/** SKU prefixes are stable enough here; a catalogue lookup would cost a round trip. */',
                    '+function categoryOf(item: OrderItem): string {',
                    '+    if (item.sku.startsWith("FF-")) {',
                    '+        return "fresh-food";',
                    '+    }',
                    '+    if (item.sku.startsWith("PH-")) {',
                    '+        return "pharmacy";',
                    '+    }',
                    '+    return "regular";',
                    '+}',
                    '+',
                    '+/** Wording for the UI; the API answers with the machine-readable rejection instead. */',
                    '+export function describeState(state: EditWindowState): string {',
                    '+    switch (state.kind) {',
                    '+        case "open":',
                    '+            return `You can edit this order until ${state.closesAt.toISOString()}.`;',
                    '+        case "closed":',
                    '+            return state.cause === "dispatch"',
                    '+                ? "The courier has already picked this order up."',
                    '+                : "The editing window has closed.";',
                    '+        case "not-applicable":',
                    '+            return "Express delivery cannot be rescheduled.";',
                    '+    }',
                    '+}',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/domain/policies/edit-policy.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' import { Order } from "../order";',
                    '-import { isWithinHours } from "../../infra/time";',
                    '+import { EditWindow, EditWindowInput, describeState } from "../edit-window";',
                    ' ',
                    ' export interface EditDecision {',
                    '     readonly allowed: boolean;',
                    '-    readonly reason?: string;',
                    '+    readonly reason: EditRejection | null;',
                    ' }',
                    '+',
                    '+export type EditRejection = "edit-window-closed" | "already-dispatched" | "not-scheduled";',
                ],
            },
            {
                oldStart: 24,
                newStart: 26,
                section: 'export class EditPolicy',
                lines: [
                    ' export class EditPolicy {',
                    '-    constructor(private readonly windowHours: number) {}',
                    '+    constructor(private readonly window: EditWindow) {}',
                    ' ',
                    '     decide(order: Order): EditDecision {',
                    '-        if (!order.slot) {',
                    '-            return { allowed: false, reason: "no slot" };',
                    '-        }',
                    '-        if (isWithinHours(order.checkoutAt, this.windowHours)) {',
                    '-            return { allowed: true };',
                    '-        }',
                    '-        return { allowed: false };',
                    '+        const input: EditWindowInput = { order, slot: order.slot };',
                    '+        const state = this.window.state(input);',
                    '+',
                    '+        switch (state.kind) {',
                    '+            case "open":',
                    '+                return { allowed: true, reason: null };',
                    '+            case "closed":',
                    '+                return {',
                    '+                    allowed: false,',
                    '+                    reason: state.cause === "dispatch" ? "already-dispatched" : "edit-window-closed",',
                    '+                };',
                    '+            case "not-applicable":',
                    '+                return { allowed: false, reason: "not-scheduled" };',
                    '+        }',
                    '     }',
                    '+',
                    '+    remainingMs(order: Order): number {',
                    '+        return this.window.remainingMs({ order, slot: order.slot });',
                    '+    }',
                    '+',
                    '+    /**',
                    '+     * Explanation for the customer-facing screen. The API never returns it — it maps the',
                    '+     * rejection code instead, so that the wording can change without an API version bump.',
                    '+     */',
                    '+    explain(order: Order): string {',
                    '+        return describeState(this.window.state({ order, slot: order.slot }));',
                    '+    }',
                    ' }',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/domain/order.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 12,
                newStart: 12,
                section: 'export interface DeliverySlot',
                lines: [
                    ' export interface DeliverySlot {',
                    '     readonly id: string;',
                    '     readonly from: Date;',
                    '     readonly to: Date;',
                    '-    readonly scheduled?: boolean;',
                    '+    readonly scheduled: boolean;',
                    '+    /** null until the courier picks the parcel up. */',
                    '+    readonly dispatchedAt: Date | null;',
                    ' }',
                ],
            },
            {
                oldStart: 34,
                newStart: 36,
                section: 'export interface Order',
                lines: [
                    ' export interface Order {',
                    '     readonly id: string;',
                    '     readonly checkoutAt: Date;',
                    '-    readonly slot?: DeliverySlot;',
                    '-    readonly editable?: boolean;',
                    '+    readonly slot: DeliverySlot | null;',
                    '+    readonly items: readonly OrderItem[];',
                    ' }',
                    '+',
                    '+export interface OrderItem {',
                    '+    readonly sku: string;',
                    '+    readonly quantity: number;',
                    '+}',
                ],
            },
            {
                oldStart: 52,
                newStart: 59,
                section: 'export function withSlot',
                lines: [
                    ' export function withSlot(order: Order, slot: DeliverySlot): Order {',
                    '     return { ...order, slot };',
                    ' }',
                    '+',
                    '+export function withDispatch(order: Order, dispatchedAt: Date): Order {',
                    '+    if (order.slot === null) {',
                    '+        throw new Error(`order ${order.id} has no slot to dispatch`);',
                    '+    }',
                    '+    return { ...order, slot: { ...order.slot, dispatchedAt } };',
                    '+}',
                    '+',
                    '+/**',
                    '+ * The aggregate used to carry an `editable` flag that duplicated the policy. It is gone;',
                    '+ * ask `EditPolicy.decide` instead — it is the only place that knows about the window.',
                    '+ */',
                    '+export function isScheduled(order: Order): boolean {',
                    '+    return order.slot !== null && order.slot.scheduled;',
                    '+}',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/api/handlers.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' import { Request, Response } from "../infra/http";',
                    '-import { EditPolicy } from "../domain/policies/edit-policy";',
                    '+import { EditPolicy, EditRejection } from "../domain/policies/edit-policy";',
                    '+import { recordEdit, recordEditWindow } from "../payments/pci-audit";',
                    '+import { editWindowSchema } from "./schemas";',
                    ' ',
                    ' const REJECTION_STATUS: Record<EditRejection, number> = {',
                    '-    "no slot": 400,',
                    '+    "edit-window-closed": 409,',
                    '+    "already-dispatched": 409,',
                    '+    "not-scheduled": 400,',
                    ' };',
                ],
            },
            {
                oldStart: 41,
                newStart: 45,
                section: 'export async function patchOrder',
                lines: [
                    ' export async function patchOrder(req: Request, res: Response): Promise<void> {',
                    '-    const order = await orders.load(req.params.orderId);',
                    '-    const decision = policy.decide(order);',
                    '-    if (!decision.allowed) {',
                    '-        res.status(400).json({ error: decision.reason });',
                    '+    const body = editWindowSchema.parse(req.body);',
                    '+    const order = await orders.load(req.params.orderId);',
                    '+    const decision = policy.decide(order);',
                    '+',
                    '+    if (!decision.allowed && decision.reason !== null) {',
                    '+        res.status(REJECTION_STATUS[decision.reason]).json({',
                    '+            error: decision.reason,',
                    '+            remainingMs: policy.remainingMs(order),',
                    '+        });',
                    '         return;',
                    '     }',
                    ' ',
                    '-    await orders.apply(order, req.body);',
                    '+    await orders.apply(order, body);',
                    '+    recordEdit(order, req.user.login);',
                    '     res.status(204).end();',
                    ' }',
                ],
            },
            {
                oldStart: 68,
                newStart: 78,
                section: 'export async function getEditWindow',
                lines: [
                    ' export async function getEditWindow(req: Request, res: Response): Promise<void> {',
                    '     const order = await orders.load(req.params.orderId);',
                    '-    res.json({ editable: order.editable === true });',
                    '+    const decision = policy.decide(order);',
                    '+',
                    '+    res.json({',
                    '+        editable: decision.allowed,',
                    '+        reason: decision.reason,',
                    '+        remainingMs: policy.remainingMs(order),',
                    '+        explanation: policy.explain(order),',
                    '+    });',
                    '+',
                    '+    if (!decision.allowed) {',
                    '+        recordEditWindow(order, 0);',
                    '+    }',
                    ' }',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/api/schemas.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 8,
                newStart: 8,
                section: 'export const editWindowSchema',
                lines: [
                    ' export const editWindowSchema = z.object({',
                    '-    slotId: z.string().optional(),',
                    '+    slotId: z.string().min(1),',
                    '+    /** Client-side countdown is advisory; the server recomputes the window anyway. */',
                    '+    clientRemainingMs: z.number().int().nonnegative().optional(),',
                    '     items: z.array(orderItemSchema).min(1),',
                    ' });',
                    '+',
                    '+export type EditWindowRequest = z.infer<typeof editWindowSchema>;',
                ],
            },
            {
                oldStart: 26,
                newStart: 30,
                section: 'export const editWindowResponseSchema',
                lines: [
                    '+export const editWindowResponseSchema = z.object({',
                    '+    editable: z.boolean(),',
                    '+    reason: z.enum(["edit-window-closed", "already-dispatched", "not-scheduled"]).nullable(),',
                    '+    remainingMs: z.number().int().nonnegative(),',
                    '+    explanation: z.string(),',
                    '+});',
                    '+',
                    '+export type EditWindowResponse = z.infer<typeof editWindowResponseSchema>;',
                    '+',
                    ' export const orderItemSchema = z.object({',
                    '     sku: z.string(),',
                    '     quantity: z.number().int().positive(),',
                    ' });',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/api/__tests__/handlers.test.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 18,
                newStart: 18,
                section: 'describe("patchOrder")',
                lines: [
                    ' describe("patchOrder", () => {',
                    '-    it("rejects orders without a slot", async () => {',
                    '-        const res = await call({ orderId: "no-slot" });',
                    '-        expect(res.status).toBe(400);',
                    '+    it("rejects an order whose edit window has closed", async () => {',
                    '+        const res = await call({ orderId: "closed-window" });',
                    '+        expect(res.status).toBe(409);',
                    '+        expect(res.body).toEqual({ error: "edit-window-closed", remainingMs: 0 });',
                    '+    });',
                    '+',
                    '+    it("reports the remaining time while the window is open", async () => {',
                    '+        const res = await call({ orderId: "open-window" });',
                    '+        expect(res.status).toBe(204);',
                    '     });',
                    '+',
                    '+    it("rejects an unscheduled slot with 400", async () => {',
                    '+        const res = await call({ orderId: "express" });',
                    '+        expect(res.status).toBe(400);',
                    '+        expect(res.body.error).toBe("not-scheduled");',
                    '+    });',
                    '+',
                    '+    it("rejects a dispatched order with 409", async () => {',
                    '+        const res = await call({ orderId: "dispatched" });',
                    '+        expect(res.status).toBe(409);',
                    '+        expect(res.body.error).toBe("already-dispatched");',
                    '+    });',
                    '+',
                    '+    it("validates the body before touching the repository", async () => {',
                    '+        const res = await call({ orderId: "open-window" }, { slotId: "" });',
                    '+        expect(res.status).toBe(422);',
                    '+        expect(orders.load).not.toHaveBeenCalled();',
                    '+    });',
                    '+',
                    '+    it("ignores the advisory client countdown", async () => {',
                    '+        const res = await call({ orderId: "closed-window" }, { clientRemainingMs: 900_000 });',
                    '+        expect(res.status).toBe(409);',
                    '+    });',
                    ' });',
                ],
            },
            {
                oldStart: 44,
                newStart: 73,
                section: 'describe("audit")',
                lines: [
                    ' describe("audit", () => {',
                    '     it("records every accepted edit", async () => {',
                    '         await call({ orderId: "open-window" });',
                    '-        expect(audit.records).toHaveLength(1);',
                    '+        expect(audit.records).toEqual([',
                    '+            expect.objectContaining({ kind: "order.edit", orderId: "open-window" }),',
                    '+        ]);',
                    '+    });',
                    '+',
                    '+    it("records the remaining time on every rejection", async () => {',
                    '+        await call({ orderId: "closed-window" });',
                    '+        expect(audit.records).toEqual([',
                    '+            expect.objectContaining({ kind: "order.window", remainingMs: 0 }),',
                    '+        ]);',
                    '     });',
                    ' });',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/domain/__tests__/edit-policy.test.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 5,
                newStart: 5,
                lines: [
                    '-import { EditPolicy } from "../policies/edit-policy";',
                    '+import { EditPolicy } from "../policies/edit-policy";',
                    '+import { EditWindow } from "../edit-window";',
                    '+import { FrozenClock } from "../../infra/clock";',
                    ' ',
                    '-const policy = new EditPolicy(1);',
                    '+const clock = new FrozenClock(new Date("2026-03-04T10:00:00Z"));',
                    '+const policy = new EditPolicy(new EditWindow(clock));',
                ],
            },
            {
                oldStart: 22,
                newStart: 25,
                section: 'describe("EditPolicy")',
                lines: [
                    '     it("allows an edit inside the window", () => {',
                    '         expect(policy.decide(order).allowed).toBe(true);',
                    '     });',
                    '+',
                    '+    it("closes the window exactly 30 minutes after checkout", () => {',
                    '+        clock.set(new Date("2026-03-04T10:30:00Z"));',
                    '+        expect(policy.decide(order)).toEqual({ allowed: false, reason: "edit-window-closed" });',
                    '+    });',
                    '+',
                    '+    it("closes the window early once the parcel is dispatched", () => {',
                    '+        const dispatched = withDispatch(order, new Date("2026-03-04T10:05:00Z"));',
                    '+        expect(policy.decide(dispatched)).toEqual({',
                    '+            allowed: false,',
                    '+            reason: "already-dispatched",',
                    '+        });',
                    '+    });',
                    '+',
                    '+    it("rejects an express order as not scheduled", () => {',
                    '+        expect(policy.decide(express).reason).toBe("not-scheduled");',
                    '+    });',
                    '+',
                    '+    it("reports the remaining time down to the millisecond", () => {',
                    '+        clock.set(new Date("2026-03-04T10:12:34.500Z"));',
                    '+        expect(policy.remainingMs(order)).toBe(17 * 60_000 + 25_500);',
                    '+    });',
                    '+',
                    '+    it("explains a closed window in plain words", () => {',
                    '+        clock.set(new Date("2026-03-04T11:00:00Z"));',
                    '+        expect(policy.explain(order)).toBe("The editing window has closed.");',
                    '+    });',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/domain/__tests__/edit-window.test.ts',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+import { describe, expect, it } from "vitest";',
                    '+',
                    '+import { EditWindow, EDIT_WINDOW_MS } from "../edit-window";',
                    '+import { FrozenClock } from "../../infra/clock";',
                    '+import { makeOrder, makeSlot } from "./factories";',
                    '+',
                    '+const CHECKOUT_AT = new Date("2026-03-04T10:00:00Z");',
                    '+',
                    '+describe("EditWindow", () => {',
                    '+    it("is open right after checkout", () => {',
                    '+        const clock = new FrozenClock(CHECKOUT_AT);',
                    '+        const window = new EditWindow(clock);',
                    '+        const state = window.state({ order: makeOrder({ checkoutAt: CHECKOUT_AT }), slot: makeSlot() });',
                    '+        expect(state.kind).toBe("open");',
                    '+    });',
                    '+',
                    '+    it("is closed one millisecond after the deadline", () => {',
                    '+        const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + EDIT_WINDOW_MS + 1));',
                    '+        const window = new EditWindow(clock);',
                    '+        const state = window.state({ order: makeOrder({ checkoutAt: CHECKOUT_AT }), slot: makeSlot() });',
                    '+        expect(state.kind).toBe("closed");',
                    '+    });',
                    '+',
                    '+    it("is not applicable to express delivery", () => {',
                    '+        const clock = new FrozenClock(CHECKOUT_AT);',
                    '+        const window = new EditWindow(clock);',
                    '+        const slot = makeSlot({ scheduled: false });',
                    '+        expect(window.state({ order: makeOrder(), slot }).kind).toBe("not-applicable");',
                    '+    });',
                    '+',
                    '+    it("reports zero remaining time once closed", () => {',
                    '+        const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + EDIT_WINDOW_MS));',
                    '+        const window = new EditWindow(clock);',
                    '+        expect(window.remainingMs({ order: makeOrder(), slot: makeSlot() })).toBe(0);',
                    '+    });',
                    '+',
                    '+    it("counts down while the window is open", () => {',
                    '+        const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 60_000));',
                    '+        const window = new EditWindow(clock);',
                    '+        const remaining = window.remainingMs({ order: makeOrder(), slot: makeSlot() });',
                    '+        expect(remaining).toBe(EDIT_WINDOW_MS - 60_000);',
                    '+    });',
                    '+',
                    '+    it("closes early when the parcel has been dispatched", () => {',
                    '+        const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 5 * 60_000));',
                    '+        const window = new EditWindow(clock);',
                    '+        const slot = makeSlot({ dispatchedAt: new Date(CHECKOUT_AT.getTime() + 4 * 60_000) });',
                    '+        const state = window.state({ order: makeOrder({ checkoutAt: CHECKOUT_AT }), slot });',
                    '+',
                    '+        expect(state).toEqual({',
                    '+            kind: "closed",',
                    '+            closedAt: slot.dispatchedAt,',
                    '+            cause: "dispatch",',
                    '+        });',
                    '+    });',
                    '+',
                    '+    it("ignores a dispatch that happens after the deadline", () => {',
                    '+        const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 10 * 60_000));',
                    '+        const window = new EditWindow(clock);',
                    '+        const slot = makeSlot({ dispatchedAt: new Date(CHECKOUT_AT.getTime() + 90 * 60_000) });',
                    '+        expect(window.state({ order: makeOrder(), slot }).kind).toBe("open");',
                    '+    });',
                    '+',
                    '+    describe("category overrides", () => {',
                    '+        it("shortens the window to 10 minutes for fresh food", () => {',
                    '+            const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 11 * 60_000));',
                    '+            const window = new EditWindow(clock);',
                    '+            const order = makeOrder({ items: [{ sku: "FF-1042", quantity: 1 }] });',
                    '+            expect(window.state({ order, slot: makeSlot() }).kind).toBe("closed");',
                    '+        });',
                    '+',
                    '+        it("shortens the window to 5 minutes for pharmacy", () => {',
                    '+            const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 6 * 60_000));',
                    '+            const window = new EditWindow(clock);',
                    '+            const order = makeOrder({ items: [{ sku: "PH-77", quantity: 2 }] });',
                    '+            expect(window.state({ order, slot: makeSlot() }).kind).toBe("closed");',
                    '+        });',
                    '+',
                    '+        it("takes the shortest window in a mixed basket", () => {',
                    '+            const clock = new FrozenClock(new Date(CHECKOUT_AT.getTime() + 6 * 60_000));',
                    '+            const window = new EditWindow(clock);',
                    '+            const order = makeOrder({',
                    '+                items: [',
                    '+                    { sku: "RG-1", quantity: 1 },',
                    '+                    { sku: "PH-77", quantity: 1 },',
                    '+                    { sku: "FF-1042", quantity: 1 },',
                    '+                ],',
                    '+            });',
                    '+            expect(window.state({ order, slot: makeSlot() }).kind).toBe("closed");',
                    '+        });',
                    '+    });',
                    '+});',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/infra/logging.ts',
        changeType: 'modify',
        viewed: true,
        hunks: [
            {
                oldStart: 30,
                newStart: 30,
                section: 'export function auditLine',
                lines: [
                    ' export function auditLine(event: AuditEvent): string {',
                    '-    return [event.kind, event.orderId, event.actor].join(" ");',
                    '+    return [event.kind, event.orderId, event.actor, event.remainingMs].join(" ");',
                    ' }',
                    ' ',
                    '-export function debug(message: string): void {',
                    '-    if (process.env.DEBUG) {',
                    '-        console.log(message);',
                    '-    }',
                    '+export function debug(message: string, context: Record<string, unknown> = {}): void {',
                    '+    if (DEBUG_ENABLED) {',
                    '+        logger.debug(message, context);',
                    '+    }',
                    ' }',
                ],
            },
            {
                oldStart: 48,
                newStart: 48,
                section: 'export interface AuditEvent',
                lines: [
                    ' export interface AuditEvent {',
                    '     readonly kind: string;',
                    '     readonly orderId: string;',
                    '     readonly actor: string;',
                    '+    /** Milliseconds left in the edit window at the moment of the event; 0 once it closed. */',
                    '+    readonly remainingMs: number;',
                    ' }',
                    '+',
                    '+/** Read once at import time: this check used to run on every log line. */',
                    '+const DEBUG_ENABLED = process.env.DEBUG !== undefined;',
                    '+',
                    '+export function withOrder(event: Omit<AuditEvent, "orderId">, orderId: string): AuditEvent {',
                    '+    return { ...event, orderId };',
                    '+}',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/infra/clock.ts',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+/** Time source. Injected everywhere so that the edit window is testable. */',
                    '+export interface Clock {',
                    '+    now(): Date;',
                    '+}',
                    '+',
                    '+export class SystemClock implements Clock {',
                    '+    now(): Date {',
                    '+        return new Date();',
                    '+    }',
                    '+}',
                    '+',
                    '+/** Test double. Production code must never construct it — the linter guards the import. */',
                    '+export class FrozenClock implements Clock {',
                    '+    constructor(private current: Date) {}',
                    '+',
                    '+    now(): Date {',
                    '+        return this.current;',
                    '+    }',
                    '+',
                    '+    set(next: Date): void {',
                    '+        this.current = next;',
                    '+    }',
                    '+',
                    '+    advance(ms: number): void {',
                    '+        this.current = new Date(this.current.getTime() + ms);',
                    '+    }',
                    '+}',
                    '+',
                    '+/**',
                    '+ * The single instance the application wires everywhere. Exported as a constant rather than',
                    '+ * a getter so that a test that forgets to inject a clock fails loudly instead of drifting.',
                    '+ */',
                    '+export const systemClock: Clock = new SystemClock();',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/payments/card-token.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 44,
                newStart: 44,
                section: 'export function reauthorize',
                lines: [
                    ' export function reauthorize(order: Order, token: CardToken): Promise<AuthResult> {',
                    '-    log.info(`reauthorize ${order.id} ${token.pan}`);',
                    '+    log.info(`reauthorize ${order.id} ${mask(token.pan)}`);',
                    '+',
                    '+    if (token.expiresAt < order.checkoutAt) {',
                    '+        return Promise.resolve({ ok: false, reason: "token-expired" });',
                    '+    }',
                    ' ',
                    '-    return psp.authorize({ amount: order.total, pan: token.pan });',
                    '+    return psp.authorize({ amount: order.total, token: token.id });',
                    ' }',
                    '+',
                    '+function mask(pan: string): string {',
                    '+    return `**** **** **** ${pan.slice(-4)}`;',
                    '+}',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/payments/pci-audit.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 17,
                newStart: 17,
                section: 'export function recordEdit',
                lines: [
                    ' export function recordEdit(order: Order, actor: string): void {',
                    '-    audit.write({ kind: "order.edit", orderId: order.id, actor });',
                    '+    audit.write({',
                    '+        kind: "order.edit",',
                    '+        orderId: order.id,',
                    '+        actor,',
                    '+        /** Retention is 13 months — PCI DSS 10.5.1. */',
                    '+        recordedAt: clock.now().toISOString(),',
                    '+    });',
                    ' }',
                    ' ',
                    '-export function recordEditWindow(order: Order): void {',
                    '-    audit.write({ kind: "order.window", orderId: order.id });',
                    '+export function recordEditWindow(order: Order, remainingMs: number): void {',
                    '+    audit.write({',
                    '+        kind: "order.window",',
                    '+        orderId: order.id,',
                    '+        remainingMs,',
                    '+        recordedAt: clock.now().toISOString(),',
                    '+    });',
                    ' }',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/payments/generated/psp-schema.ts',
        changeType: 'modify',
        generated: true,
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' /* eslint-disable */',
                    ' // Code generated by psp-codegen. DO NOT EDIT.',
                    '-// source: psp/v3/authorize.proto',
                    '+// source: psp/v4/authorize.proto',
                    ' ',
                    ' export interface AuthorizeRequest {',
                    '     amount: number;',
                    '-    pan: string;',
                    '+    token: string;',
                    '+    idempotencyKey?: string;',
                    ' }',
                ],
            },
            {
                oldStart: 58,
                newStart: 59,
                section: 'export interface AuthResult',
                lines: [
                    ' export interface AuthResult {',
                    '     ok: boolean;',
                    '-    reason?: string;',
                    '+    reason?: AuthFailureReason;',
                    ' }',
                    '+',
                    '+export type AuthFailureReason =',
                    '+    | "token-expired"',
                    '+    | "token-unknown"',
                    '+    | "insufficient-funds"',
                    '+    | "psp-unavailable";',
                    '+',
                    '+export const AUTH_FAILURE_REASONS: readonly AuthFailureReason[] = [',
                    '+    "token-expired",',
                    '+    "token-unknown",',
                    '+    "insufficient-funds",',
                    '+    "psp-unavailable",',
                    '+];',
                ],
            },
        ],
    },
    {
        path: '.github/CODEOWNERS',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 4,
                newStart: 4,
                lines: [
                    ' # services/orders: the last matching pattern takes precedence.',
                    ' /services/orders/                  @alice @avery',
                    ' /services/orders/src/domain/       @quillmart/checkout-domain',
                    '+# API handlers and schemas get their own reviewers.',
                    '+/services/orders/src/api/          @quillmart/checkout-api',
                    ' ',
                    ' # Payments code is reviewed by the payments platform.',
                    '-/services/orders/src/payments/     @quillmart/payments',
                    '+# PCI DSS scope: security signs off as well.',
                    '+/services/orders/src/payments/     @quillmart/payments-platform @quillmart/security',
                ],
            },
        ],
    },
    {
        path: '.github/workflows/ci.yml',
        changeType: 'modify',
        generated: true,
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' # Generated by scripts/gen-ci.ts. DO NOT EDIT.',
                    ' name: orders',
                    ' on: [pull_request]',
                    ' jobs:',
                    '-  test:',
                    '-    name: Unit tests',
                    '+  unit:',
                    '+    name: Unit tests',
                    '+    runs-on: ubuntu-latest',
                    '+    steps: [{ uses: actions/checkout@v4 }, { run: pnpm test }]',
                    '+  edit-window-contract:',
                    '+    name: Edit window contract tests',
                    '+    needs: unit',
                    '+    runs-on: ubuntu-latest',
                    '+    env: { NODE_OPTIONS: --max-old-space-size=4096 }',
                    '+    steps: [{ uses: actions/checkout@v4 }, { run: pnpm test:contract }]',
                ],
            },
        ],
    },
    {
        path: 'services/orders/docs/edit-window.md',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+# The 30-minute edit window',
                    '+',
                    '+A customer may edit a scheduled delivery for 30 minutes after checkout. The window is a',
                    '+domain concept (`EditWindow`), not an HTTP concern: the API layer only maps rejections to',
                    '+status codes.',
                    '+',
                    '+## Rules',
                    '+',
                    '+1. The window opens at `order.checkoutAt` and closes `EDIT_WINDOW_MS` later.',
                    '+2. Dispatch closes the window early, even if the 30 minutes have not passed.',
                    '+3. Express (non-scheduled) delivery has no window at all — edits are rejected with 400.',
                    '+4. The remaining time is always recomputed on the server; the client countdown is advisory.',
                    '+',
                    '+## Rejections',
                    '+',
                    '+| Reason | Status | Meaning |',
                    '+| --- | --- | --- |',
                    '+| `edit-window-closed` | 409 | The 30 minutes have passed |',
                    '+| `already-dispatched` | 409 | The courier already picked the parcel up |',
                    '+| `not-scheduled` | 400 | Express delivery, nothing to reschedule |',
                    '+',
                    '+## Audit',
                    '+',
                    '+Every accepted edit writes a `order.edit` audit record and every rejection writes',
                    '+`order.window` with the remaining milliseconds. Both records are in the PCI DSS scope,',
                    '+so they keep the 13-month retention.',
                    '+',
                    '+## Category overrides',
                    '+',
                    '+Some categories close the window earlier, because the picking starts sooner:',
                    '+',
                    '+| Category | SKU prefix | Window |',
                    '+| --- | --- | --- |',
                    '+| Fresh food | `FF-` | 10 minutes |',
                    '+| Pharmacy | `PH-` | 5 minutes |',
                    '+| Everything else | — | 30 minutes |',
                    '+',
                    '+The shortest window in the basket wins: a single fresh-food item closes the whole order in',
                    '+ten minutes. The prefixes are read from the SKU rather than from the catalogue on purpose —',
                    '+the window is computed on every request and a catalogue round trip would double its latency.',
                    '+',
                    '+## Migration',
                    '+',
                    '+The previous implementation used a configurable number of hours (`EditPolicy(windowHours)`)',
                    '+and silently allowed edits for unscheduled orders. Both behaviours are gone; the config key',
                    '+`checkout.edit_window_hours` is no longer read and will be deleted after the release.',
                    '+',
                    '+Rollout order:',
                    '+',
                    '+1. Deploy with the flag `checkout_edit_window` off — the new code path is dormant.',
                    '+2. Turn the flag on for internal accounts and watch `checkout.edit_window.rejected`.',
                    '+3. Ramp to 100% over three days, then delete the config key and the old tests.',
                    ...rolloutChecklistLines(),
                ],
            },
        ],
    },
    {
        path: 'services/orders/README.md',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 22,
                newStart: 22,
                section: '## Domain',
                lines: [
                    ' ## Domain',
                    ' ',
                    ' - `order.ts` — the aggregate root.',
                    '-- `policies/edit-policy.ts` — whether an order may still be edited (see the config key',
                    '-  `checkout.edit_window_hours`).',
                    '+- `edit-window.ts` — the 30-minute editing window, see [docs](docs/edit-window.md).',
                    '+- `policies/edit-policy.ts` — whether an order may still be edited.',
                    '+- `infra/clock.ts` — the injectable time source used by the window.',
                ],
            },
            {
                oldStart: 40,
                newStart: 41,
                section: '## Testing',
                lines: [
                    ' ## Testing',
                    ' ',
                    '-Unit tests only; the domain layer has no I/O.',
                    '+Unit tests only; the domain layer has no I/O. Anything that needs the current time takes a',
                    '+`Clock` — use `FrozenClock` in tests and never `Date.now()` in `domain/`.',
                    '+',
                    '+```sh',
                    '+pnpm test services/orders',
                    '+pnpm test services/orders -- --grep "edit window"',
                    '+```',
                    '+',
                    '+The edit-window contract tests run as a separate CI job so that a failure points at the',
                    '+window rather than at the whole checkout suite.',
                ],
            },
        ],
    },
    ...IMAGES,
];

/**
 * Лок-файл добирает PR до заявленного размера: реальный `pnpm-lock.yaml` в таком PR и правда
 * состоит из сотен машинных строк, а числа шапки должны совпадать с дизайн-хендоффом.
 */
function lockCounts(rest: readonly FileDiff[]): { additions: number; deletions: number } {
    const written = totalChanges(rest);
    const additions = MEDIUM_TOTALS.additions - written.additions;
    const deletions = MEDIUM_TOTALS.deletions - written.deletions;
    if (additions <= 0 || deletions <= 0) {
        throw new Error(
            `фикстура medium переросла заявленный размер: руками написано +${String(written.additions)} −${String(written.deletions)}`,
        );
    }
    return { additions, deletions };
}

/**
 * Ханк лок-файла: номера строк заданы счётчиками, содержимое — смещением в генераторе.
 * Пересборка лока в следующей итерации меняет смещение и оставляет номера строк на месте.
 */
function lockSpec(counts: { additions: number; deletions: number }, addedOffset: number): FileSpec {
    return {
        path: 'pnpm-lock.yaml',
        changeType: 'modify',
        generated: true,
        hunks: [
            {
                oldStart: 14,
                newStart: 14,
                section: 'packages:',
                lines: [
                    ' packages:',
                    ...lockLines('-', counts.deletions, 3),
                    ...lockLines('+', counts.additions, addedOffset),
                ],
            },
        ],
    };
}

/** Смещения генератора лока по итерациям: одинаковые номера строк, целиком разное содержимое. */
const LOCK_OFFSET_V1 = 41;
const LOCK_OFFSET_V2 = 137;

/** Числа лока считаются по первой итерации: следующие пуши его пересобирают, но не удлиняют. */
const LOCK_COUNTS = lockCounts(HAND_WRITTEN.map((spec) => makeFileDiff(DIFF_ID, spec)));

/**
 * Ссылки на файл в вебе хоста на вершине итерации. `hostFileUrl` есть у каждого файла фикстуры:
 * без неё не проверить пункт меню «Скопировать ссылку на файл»; `blameUrl` — только у `BLAME_PATHS`.
 */
function withHostLinks(spec: FileSpec, headCommit: string): FileSpec {
    return {
        ...spec,
        hostFileUrl: `${REPO_URL}/blob/${headCommit}/${spec.path}`,
        ...(BLAME_PATHS.has(spec.path) ? { blameUrl: `${REPO_URL}/blame/${headCommit}/${spec.path}` } : {}),
    };
}

function files(): FileDiff[] {
    const specs = [...HAND_WRITTEN, lockSpec(LOCK_COUNTS, LOCK_OFFSET_V1)];
    return specs.map((spec) => makeFileDiff(DIFF_ID, withHostLinks(spec, HEAD_COMMIT)));
}

/*
 * Второй пуш (`docs/design/README.md §9`). Затронуты файлы трёх стопов маршрута v1: `edit-policy.ts` (стоп 02),
 * `handlers.ts` вместе с новым `rejection-status.ts` и ушедшим `card-token.ts` (стоп 03) и
 * пересобранный лок (стоп 06 — от прежнего блока не осталось ни строки, отсюда `new`).
 * Каждая правка отвечает на замечание из тредов первой итерации.
 */

/** `default` в `switch` по замечанию линтера плюс список причин отказа отдельной константой. */
const EDIT_POLICY_V2: FileSpec = {
    path: 'services/orders/src/domain/policies/edit-policy.ts',
    changeType: 'modify',
    hunks: [
        {
            oldStart: 1,
            newStart: 1,
            lines: [
                ' import { Order } from "../order";',
                '-import { isWithinHours } from "../../infra/time";',
                '+import { EditWindow, EditWindowInput, describeState } from "../edit-window";',
                ' ',
                ' export interface EditDecision {',
                '     readonly allowed: boolean;',
                '-    readonly reason?: string;',
                '+    readonly reason: EditRejection | null;',
                ' }',
                '+',
                '+export const EDIT_REJECTIONS = ["edit-window-closed", "already-dispatched", "not-scheduled"] as const;',
                '+',
                '+export type EditRejection = (typeof EDIT_REJECTIONS)[number];',
            ],
        },
        {
            oldStart: 24,
            newStart: 28,
            section: 'export class EditPolicy',
            lines: [
                ' export class EditPolicy {',
                '-    constructor(private readonly windowHours: number) {}',
                '+    constructor(private readonly window: EditWindow) {}',
                ' ',
                '     decide(order: Order): EditDecision {',
                '-        if (!order.slot) {',
                '-            return { allowed: false, reason: "no slot" };',
                '-        }',
                '-        if (isWithinHours(order.checkoutAt, this.windowHours)) {',
                '-            return { allowed: true };',
                '-        }',
                '-        return { allowed: false };',
                '+        const input: EditWindowInput = { order, slot: order.slot };',
                '+        const state = this.window.state(input);',
                '+',
                '+        switch (state.kind) {',
                '+            case "open":',
                '+                return { allowed: true, reason: null };',
                '+            case "closed":',
                '+                return {',
                '+                    allowed: false,',
                '+                    reason: state.cause === "dispatch" ? "already-dispatched" : "edit-window-closed",',
                '+                };',
                '+            case "not-applicable":',
                '+                return { allowed: false, reason: "not-scheduled" };',
                '+            default: {',
                '+                const unreachable: never = state;',
                '+                throw new Error(`unexpected state: ${String(unreachable)}`);',
                '+            }',
                '+        }',
                '     }',
                '+',
                '+    remainingMs(order: Order): number {',
                '+        return this.window.remainingMs({ order, slot: order.slot });',
                '+    }',
                '+',
                '+    /**',
                '+     * Explanation for the customer-facing screen. The API never returns it — it maps the',
                '+     * rejection code instead, so that the wording can change without an API version bump.',
                '+     */',
                '+    explain(order: Order): string {',
                '+        return describeState(this.window.state({ order, slot: order.slot }));',
                '+    }',
                ' }',
            ],
        },
    ],
};

/** Тело отказа собирается отдельной функцией: `remainingMs` уезжает только с закрытым окном. */
const HANDLERS_V2: FileSpec = {
    path: 'services/orders/src/api/handlers.ts',
    changeType: 'modify',
    hunks: [
        {
            oldStart: 1,
            newStart: 1,
            lines: [
                ' import { Request, Response } from "../infra/http";',
                '-import { EditPolicy } from "../domain/policies/edit-policy";',
                '+import { EditPolicy, EditRejection } from "../domain/policies/edit-policy";',
                '+import { rejectionBody } from "./rejection-status";',
                '+import { recordEdit, recordEditWindow } from "../payments/pci-audit";',
                '+import { editWindowSchema } from "./schemas";',
                ' ',
                ' const REJECTION_STATUS: Record<EditRejection, number> = {',
                '-    "no slot": 400,',
                '+    "edit-window-closed": 409,',
                '+    "already-dispatched": 409,',
                '+    "not-scheduled": 400,',
                ' };',
            ],
        },
        {
            oldStart: 41,
            newStart: 46,
            section: 'export async function patchOrder',
            lines: [
                ' export async function patchOrder(req: Request, res: Response): Promise<void> {',
                '-    const order = await orders.load(req.params.orderId);',
                '-    const decision = policy.decide(order);',
                '-    if (!decision.allowed) {',
                '-        res.status(400).json({ error: decision.reason });',
                '+    const body = editWindowSchema.parse(req.body);',
                '+    const order = await orders.load(req.params.orderId);',
                '+    const decision = policy.decide(order);',
                '+',
                '+    if (!decision.allowed && decision.reason !== null) {',
                '+        res.status(REJECTION_STATUS[decision.reason]).json(rejectionBody(decision.reason, policy, order));',
                '         return;',
                '     }',
                ' ',
                '-    await orders.apply(order, req.body);',
                '+    await orders.apply(order, body);',
                '+    recordEdit(order, req.user.login);',
                '     res.status(204).end();',
                ' }',
            ],
        },
        {
            oldStart: 68,
            newStart: 76,
            section: 'export async function getEditWindow',
            lines: [
                ' export async function getEditWindow(req: Request, res: Response): Promise<void> {',
                '     const order = await orders.load(req.params.orderId);',
                '-    res.json({ editable: order.editable === true });',
                '+    const decision = policy.decide(order);',
                '+',
                '+    res.json({',
                '+        editable: decision.allowed,',
                '+        reason: decision.reason,',
                '+        remainingMs: policy.remainingMs(order),',
                '+        explanation: policy.explain(order),',
                '+    });',
                '+',
                '+    if (!decision.allowed) {',
                '+        recordEditWindow(order, 0);',
                '+    }',
                ' }',
            ],
        },
    ],
};

/** Новый файл второй итерации. */
const REJECTION_STATUS_V2: FileSpec = {
    path: ADDED_PATH_V2,
    changeType: 'add',
    hunks: [
        {
            oldStart: 0,
            newStart: 1,
            lines: [
                '+import { Order } from "../domain/order";',
                '+import { EditPolicy, EditRejection } from "../domain/policies/edit-policy";',
                '+',
                '+/** Body of a rejected edit; `remainingMs` is present only while the window is still counting. */',
                '+export interface RejectionBody {',
                '+    readonly error: EditRejection;',
                '+    readonly remainingMs?: number;',
                '+}',
                '+',
                '+/**',
                '+ * The remaining time is reported for `edit-window-closed` only: for the other two rejections it',
                '+ * is always 0 and reads like a bug on the client.',
                '+ */',
                '+export function rejectionBody(reason: EditRejection, policy: EditPolicy, order: Order): RejectionBody {',
                '+    if (reason !== "edit-window-closed") {',
                '+        return { error: reason };',
                '+    }',
                '+    return { error: reason, remainingMs: policy.remainingMs(order) };',
                '+}',
            ],
        },
    ],
};

/** Force-push третьей итерации: к содержимому второй добавлена одна строка в README. */
const README_V3: FileSpec = {
    path: 'services/orders/README.md',
    changeType: 'modify',
    hunks: [
        {
            oldStart: 22,
            newStart: 22,
            section: '## Domain',
            lines: [
                ' ## Domain',
                ' ',
                ' - `order.ts` — the aggregate root.',
                '-- `policies/edit-policy.ts` — whether an order may still be edited (see the config key',
                '-  `checkout.edit_window_hours`).',
                '+- `edit-window.ts` — the 30-minute editing window, see [docs](docs/edit-window.md).',
                '+- `policies/edit-policy.ts` — whether an order may still be edited.',
                '+- `infra/clock.ts` — the injectable time source used by the window.',
            ],
        },
        {
            oldStart: 40,
            newStart: 41,
            section: '## Testing',
            lines: [
                ' ## Testing',
                ' ',
                '-Unit tests only; the domain layer has no I/O.',
                '+Unit tests only; the domain layer has no I/O. Anything that needs the current time takes a',
                '+`Clock` — use `FrozenClock` in tests and never `Date.now()` in `domain/`.',
                '+',
                '+```sh',
                '+pnpm test services/orders',
                '+pnpm test services/orders -- --grep "edit window"',
                '+pnpm test services/orders -- --grep "rejection"',
                '+```',
                '+',
                '+The edit-window contract tests run as a separate CI job so that a failure points at the',
                '+window rather than at the whole checkout suite.',
            ],
        },
    ],
};

function replaceSpecs(base: readonly FileSpec[], replacements: readonly FileSpec[]): FileSpec[] {
    const byPath = new Map(replacements.map((spec) => [spec.path, spec] as const));
    return base.map((spec) => byPath.get(spec.path) ?? spec);
}

/** Файлы итерации после пуша: правки поверх первой, минус ушедший файл, плюс новый и лок. */
function filesAfterPush(
    diffId: HostId,
    headCommit: string,
    replacements: readonly FileSpec[],
): FileDiff[] {
    const specs = [
        ...replaceSpecs(
            HAND_WRITTEN.filter((spec) => spec.path !== DEPARTED_PATH),
            replacements,
        ),
        REJECTION_STATUS_V2,
        lockSpec(LOCK_COUNTS, LOCK_OFFSET_V2),
    ];
    return specs.map((spec) => makeFileDiff(diffId, withHostLinks(spec, headCommit)));
}

/**
 * Срез между итерациями: `diffId` — head-итерация, `baseCommit` — её base, а `fileId` файлов
 * среза свои (контракт `prDiffSchema`), поэтому они считаются от пары итераций, а не от одной.
 */
function slice(
    base: { diffId: HostId; headCommit: string },
    head: { diffId: HostId; headCommit: string },
    specs: readonly FileSpec[],
): FixtureInterdiff {
    const key = `${base.diffId}..${head.diffId}`;
    return {
        base: base.diffId,
        head: head.diffId,
        diff: {
            diffId: head.diffId,
            baseCommit: base.headCommit,
            headCommit: head.headCommit,
            files: specs.map((spec) => makeFileDiff(key, withHostLinks(spec, head.headCommit))),
        },
    };
}

/**
 * Ханки среза первой итерации во вторую. Номера левой стороны — строки файла в первой итерации,
 * правой — во второй; каждая затронутая строка правой стороны лежит внутри ханка второй итерации
 * (это проверяет тест-гвардия `iterations.test.ts`).
 */
const SLICE_V1_V2: readonly FileSpec[] = [
    {
        path: 'services/orders/src/domain/policies/edit-policy.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 8,
                newStart: 8,
                lines: [
                    ' ',
                    '-export type EditRejection = "edit-window-closed" | "already-dispatched" | "not-scheduled";',
                    '+export const EDIT_REJECTIONS = ["edit-window-closed", "already-dispatched", "not-scheduled"] as const;',
                    '+',
                    '+export type EditRejection = (typeof EDIT_REJECTIONS)[number];',
                ],
            },
            {
                oldStart: 42,
                newStart: 44,
                section: 'export class EditPolicy',
                lines: [
                    '                 return { allowed: false, reason: "not-scheduled" };',
                    '+            default: {',
                    '+                const unreachable: never = state;',
                    '+                throw new Error(`unexpected state: ${String(unreachable)}`);',
                    '+            }',
                    '         }',
                ],
            },
        ],
    },
    {
        path: 'services/orders/src/api/handlers.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 2,
                newStart: 2,
                lines: [
                    ' import { EditPolicy, EditRejection } from "../domain/policies/edit-policy";',
                    '+import { rejectionBody } from "./rejection-status";',
                    ' import { recordEdit, recordEditWindow } from "../payments/pci-audit";',
                ],
            },
            {
                oldStart: 50,
                newStart: 51,
                section: 'export async function patchOrder',
                lines: [
                    '     if (!decision.allowed && decision.reason !== null) {',
                    '-        res.status(REJECTION_STATUS[decision.reason]).json({',
                    '-            error: decision.reason,',
                    '-            remainingMs: policy.remainingMs(order),',
                    '-        });',
                    '+        res.status(REJECTION_STATUS[decision.reason]).json(rejectionBody(decision.reason, policy, order));',
                    '         return;',
                ],
            },
        ],
    },
    REJECTION_STATUS_V2,
    {
        // Платёжная правка уехала в отдельный PR, поэтому в срезе файл возвращается к состоянию базы.
        path: DEPARTED_PATH,
        changeType: 'modify',
        hunks: [
            {
                oldStart: 44,
                newStart: 44,
                section: 'export function reauthorize',
                lines: [
                    ' export function reauthorize(order: Order, token: CardToken): Promise<AuthResult> {',
                    '-    log.info(`reauthorize ${order.id} ${mask(token.pan)}`);',
                    '-',
                    '-    if (token.expiresAt < order.checkoutAt) {',
                    '-        return Promise.resolve({ ok: false, reason: "token-expired" });',
                    '-    }',
                    '+    log.info(`reauthorize ${order.id} ${token.pan}`);',
                    ' ',
                    '-    return psp.authorize({ amount: order.total, token: token.id });',
                    '+    return psp.authorize({ amount: order.total, pan: token.pan });',
                    ' }',
                    '-',
                    '-function mask(pan: string): string {',
                    '-    return `**** **** **** ${pan.slice(-4)}`;',
                    '-}',
                ],
            },
        ],
    },
    {
        path: 'pnpm-lock.yaml',
        changeType: 'modify',
        generated: true,
        hunks: [
            {
                oldStart: 14,
                newStart: 14,
                section: 'packages:',
                lines: [
                    ' packages:',
                    ...lockLines('-', LOCK_COUNTS.additions, LOCK_OFFSET_V1),
                    ...lockLines('+', LOCK_COUNTS.additions, LOCK_OFFSET_V2),
                ],
            },
        ],
    },
];

/** Force-push поверх второй итерации трогает один README: остальное содержимое то же. */
const SLICE_V2_V3: readonly FileSpec[] = [
    {
        path: 'services/orders/README.md',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 48,
                newStart: 48,
                section: '## Testing',
                lines: [
                    ' pnpm test services/orders -- --grep "edit window"',
                    '+pnpm test services/orders -- --grep "rejection"',
                ],
            },
        ],
    },
];

/** Срез первой итерации в третью: содержимое второго пуша плюс правка force-push. */
const SLICE_V1_V3: readonly FileSpec[] = [...SLICE_V1_V2, ...SLICE_V2_V3];

function iterations(): FixtureIteration[] {
    return [
        {
            iteration: {
                diffId: DIFF_ID,
                baseCommit: BASE_COMMIT,
                headCommit: HEAD_COMMIT,
                createdAt: CREATED_AT_V1,
            },
            diff: { diffId: DIFF_ID, baseCommit: BASE_COMMIT, headCommit: HEAD_COMMIT, files: files() },
            threads: threads(DIFF_ID),
            replaces: null,
        },
        {
            iteration: {
                diffId: DIFF_ID_V2,
                baseCommit: BASE_COMMIT,
                headCommit: HEAD_COMMIT_V2,
                createdAt: CREATED_AT_V2,
            },
            diff: {
                diffId: DIFF_ID_V2,
                baseCommit: BASE_COMMIT,
                headCommit: HEAD_COMMIT_V2,
                files: filesAfterPush(DIFF_ID_V2, HEAD_COMMIT_V2, [EDIT_POLICY_V2, HANDLERS_V2]),
            },
            threads: threads(DIFF_ID_V2, true),
            replaces: null,
        },
        {
            iteration: {
                diffId: DIFF_ID_V3,
                baseCommit: BASE_COMMIT,
                headCommit: HEAD_COMMIT_V3,
                createdAt: CREATED_AT_V3,
            },
            diff: {
                diffId: DIFF_ID_V3,
                baseCommit: BASE_COMMIT,
                headCommit: HEAD_COMMIT_V3,
                files: filesAfterPush(DIFF_ID_V3, HEAD_COMMIT_V3, [EDIT_POLICY_V2, HANDLERS_V2, README_V3]),
            },
            threads: threads(DIFF_ID_V3, true),
            // Force-push: вторая итерация из списка хоста исчезает, сервер пометит её `gone`.
            replaces: DIFF_ID_V2,
        },
    ];
}

function interdiffs(): FixtureInterdiff[] {
    const v1 = { diffId: DIFF_ID, headCommit: HEAD_COMMIT };
    const v2 = { diffId: DIFF_ID_V2, headCommit: HEAD_COMMIT_V2 };
    const v3 = { diffId: DIFF_ID_V3, headCommit: HEAD_COMMIT_V3 };
    return [slice(v1, v2, SLICE_V1_V2), slice(v2, v3, SLICE_V2_V3), slice(v1, v3, SLICE_V1_V3)];
}

/**
 * Треды: 4 людских (включая resolved, outdated и глубокую ветвящуюся цепочку),
 * 2 бот-треда и один уровня PR. Id инлайновых тредов положительные, уровня PR — отрицательные:
 * код не должен предполагать `id > 0`.
 *
 * `second` — те же треды глазами итерации после пуша: якоря перепривязаны к её файлам,
 * `pinnedTo` остаётся на v1, а треды на затронутых диапазонах помечены `outdated`.
 */
function threads(diffId: HostId, second = false): Thread[] {
    const deepChain = comment({
        id: '4820113',
        author: KAI,
        body: 'Why is the window a class and not a pure function of (order, now)? The clock injection buys us testability, but it also hides the dependency from callers.',
        createdAt: '2026-08-18T09:12:00.000Z',
        replies: [
            comment({
                id: '4820137',
                author: AUTHOR,
                body: 'Because the next step is a per-category window (fresh food gets 10 minutes), and that needs state. A function would grow a fourth argument immediately.',
                createdAt: '2026-08-18T09:41:00.000Z',
                replies: [
                    comment({
                        id: '4820158',
                        author: KAI,
                        body: 'Fair. Then please make the constructor take a config object rather than a bare `Clock` — otherwise we will be rewriting every call site in two weeks.',
                        createdAt: '2026-08-18T10:02:00.000Z',
                        replies: [
                            comment({
                                id: '4820171',
                                author: AUTHOR,
                                body: 'Will do in the follow-up, this PR is already large.',
                                createdAt: '2026-08-18T10:20:00.000Z',
                                replies: [
                                    comment({
                                        id: '4820188',
                                        author: IRIS,
                                        body: 'Please link the follow-up ticket here so it does not get lost.',
                                        createdAt: '2026-08-18T11:05:00.000Z',
                                        replies: [
                                            comment({
                                                id: '4820204',
                                                author: AUTHOR,
                                                body: '#2281.',
                                                createdAt: '2026-08-18T11:31:00.000Z',
                                                editedAt: '2026-08-18T11:33:00.000Z',
                                                replies: [
                                                    comment({
                                                        id: '4820219',
                                                        author: IRIS,
                                                        body: 'Thanks.',
                                                        createdAt: '2026-08-18T11:40:00.000Z',
                                                    }),
                                                ],
                                            }),
                                        ],
                                    }),
                                ],
                            }),
                            comment({
                                id: '4820176',
                                author: IRIS,
                                body: 'Second branch on the same parent: a config object also lets us keep the feature flag out of the domain layer.',
                                createdAt: '2026-08-18T10:24:00.000Z',
                            }),
                        ],
                    }),
                ],
            }),
        ],
    });

    // Ответ автора приезжает вместе с пушем: на замечание Айрис он отвечает готовой правкой.
    const authorFollowUp = comment({
        id: '4820288',
        author: AUTHOR,
        body: 'Done in this push: `remainingMs` is only returned for `edit-window-closed`, the body is built by `api/rejection-status.ts`.',
        createdAt: '2026-08-21T10:58:00.000Z',
    });

    return [
        thread({
            anchor: anchor(diffId, 'services/orders/src/domain/edit-window.ts', { side: 'new', line: 24 }),
            pinnedTo: V1_PIN,
            root: deepChain,
        }),
        thread({
            // Диапазон 48–51 первой итерации пуш задел: якорь перепривязан на ближайшую
            // уцелевшую строку, тред помечен устаревшим.
            anchor: second
                ? anchor(diffId, 'services/orders/src/api/handlers.ts', { side: 'new', line: 49 })
                : anchor(diffId, 'services/orders/src/api/handlers.ts', { side: 'new', line: 48, size: 4 }),
            outdated: second,
            pinnedTo: V1_PIN,
            root: comment({
                id: '4820242',
                author: IRIS,
                body: 'Returning `remainingMs` on a 409 is nice, but it is computed after the decision — for `not-scheduled` it will always be 0 and that reads like a bug to the client.',
                createdAt: '2026-08-18T12:04:00.000Z',
                replies: [
                    comment({
                        id: '4820251',
                        author: AUTHOR,
                        body: 'Right, I will only add the field for `edit-window-closed`.',
                        createdAt: '2026-08-18T12:19:00.000Z',
                        replies: second ? [authorFollowUp] : [],
                    }),
                ],
            }),
        }),
        thread({
            anchor: anchor(diffId, 'services/orders/src/infra/logging.ts', { side: 'new', line: 34 }),
            pinnedTo: V1_PIN,
            resolved: true,
            resolvedBy: AUTHOR.login,
            root: comment({
                id: '4820109',
                author: KAI,
                body: '`process.env.DEBUG` is checked on every call — hoist it into a module constant.',
                createdAt: '2026-08-17T18:22:00.000Z',
                replies: [
                    comment({
                        id: '4820118',
                        author: AUTHOR,
                        body: 'Done, it is read once at import time now.',
                        createdAt: '2026-08-17T18:51:00.000Z',
                    }),
                ],
            }),
        }),
        thread({
            anchor: anchor(diffId, 'services/orders/src/domain/order.ts', { side: 'old', line: 38 }),
            pinnedTo: V1_PIN,
            outdated: true,
            root: comment({
                id: '4820096',
                author: IRIS,
                body: 'This optional `editable` flag duplicates the policy. It was already dead code before the rename.',
                createdAt: '2026-08-17T15:10:00.000Z',
            }),
        }),
        thread({
            // Файл ушёл из PR со вторым пушем, поэтому якорь остаётся на файле первой итерации:
            // такие треды UI собирает в группу «на файлах, которых больше нет» (`docs/design/SPEC-elements.md §2.17`).
            anchor: anchor(DIFF_ID, 'services/orders/src/payments/card-token.ts', { side: 'new', line: 45 }),
            outdated: second,
            pinnedTo: V1_PIN,
            root: comment({
                id: '4820260',
                author: AI_REVIEW,
                // Бот пишет markdown-ом: заголовок, список, ссылка с длинным адресом и блок кода.
                body: [
                    '##### PCI: unmasked PAN in retained logs',
                    '',
                    'The PAN was logged unmasked before this change and the log retention is 30 days — consider filing a PCI incident for the historical records, not just fixing the line.',
                    '',
                    '- **Severity:** high — the data is already on disk in `logs/checkout-*.jsonl`.',
                    '- Scrubbing the archive is a separate ticket; this PR only fixes new writes.',
                    '- Runbook: https://wiki.example.internal/checkout/security/incident-response/historical-records-scrubbing/',
                    '',
                    '```ts',
                    'logger.info(\'reauthorize\', { pan: maskPan(card.pan) });',
                    '```',
                ].join('\n'),
                createdAt: '2026-08-19T08:02:00.000Z',
            }),
        }),
        thread({
            // Неизменённая строка: второй пуш добавил объявления выше, и якорь просто съехал на две
            // строки — `pinnedTo` при этом продолжает показывать коммит первой итерации.
            anchor: anchor(diffId, 'services/orders/src/domain/policies/edit-policy.ts', {
                side: 'new',
                line: second ? 35 : 33,
            }),
            pinnedTo: V1_PIN,
            root: comment({
                id: '4820263',
                author: LINT_BOT,
                body: [
                    '##### no-fallthrough',
                    '',
                    'The `switch` has no `default` branch. It is exhaustive today, but a new `EditWindowState` member would fall through silently.',
                    'Either add a `default` that throws, or annotate the never-case:',
                    '',
                    '```ts',
                    'default: {',
                    '    const unreachable: never = state;',
                    '    throw new Error(`unexpected state: ${String(unreachable)}`);',
                    '}',
                    '```',
                    '',
                    'Rule docs: [no-fallthrough](https://eslint.org/docs/latest/rules/no-fallthrough).',
                ].join('\n'),
                createdAt: '2026-08-19T08:03:00.000Z',
            }),
        }),
        thread({
            anchor: null,
            root: comment({
                id: '-38211',
                author: KAI,
                body: 'Overall this is the right shape. Before shipping: please describe the config key removal in the release notes — `checkout.edit_window_hours` is still set in two environments.',
                createdAt: '2026-08-19T09:15:00.000Z',
                replies: [
                    comment({
                        id: '-38214',
                        author: AUTHOR,
                        body: 'Added to the migration section of the doc.',
                        createdAt: '2026-08-19T09:44:00.000Z',
                    }),
                ],
            }),
        }),
    ];
}

/** Ownership: 12 «моих» файлов из 21; зоны разной глубины повторяют правила `.github/CODEOWNERS`. */
const MY_FILES = [
    'services/orders/src/domain/edit-window.ts',
    'services/orders/src/domain/order.ts',
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/domain/__tests__/edit-policy.test.ts',
    'services/orders/src/domain/__tests__/edit-window.test.ts',
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/schemas.ts',
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/infra/clock.ts',
    'services/orders/src/infra/logging.ts',
    'services/orders/docs/edit-window.md',
    'services/orders/README.md',
];

const OWNERSHIP_ZONES: readonly LensZone[] = [
    {
        path: 'services/orders/src/domain',
        mine: true,
        owner: 'checkout-domain',
        paths: MY_FILES.filter((path) => path.startsWith('services/orders/src/domain/')),
    },
    {
        path: 'services/orders/src/api',
        mine: true,
        owner: 'checkout-api',
        paths: MY_FILES.filter((path) => path.startsWith('services/orders/src/api/')),
    },
    {
        path: 'services/orders',
        mine: true,
        owner: null,
        paths: MY_FILES.filter(
            (path) => !path.startsWith('services/orders/src/domain/') && !path.startsWith('services/orders/src/api/'),
        ),
    },
    {
        path: 'services/orders/src/payments',
        mine: false,
        owner: 'payments-platform',
        paths: [
            'services/orders/src/payments/card-token.ts',
            'services/orders/src/payments/pci-audit.ts',
        ],
    },
];

/** PCI-скоуп пересекается с generated (`psp-schema.ts`) — реальный кейс из живых PR. */
const PCI_FILES = [
    'services/orders/src/payments/card-token.ts',
    'services/orders/src/payments/pci-audit.ts',
    'services/orders/src/payments/generated/psp-schema.ts',
];

export function makeMediumFixture(): FixtureDataInput {
    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Enforce the 30-minute edit window for scheduled deliveries',
            author: AUTHOR,
            fromBranch: 'avery/checkout-edit-window',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'review_in_progress',
            checks: 'passed',
            updatedAt: CREATED_AT_V1,
            capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: true, blobs: true },
            verdicts: [],
        },
        iterations: iterations(),
        interdiffs: interdiffs(),
        // Линзы описывают первую итерацию: ownership и PCI после пуша пересчитал бы хост.
        ownership: lens({ id: 'mine', label: 'My files', paths: MY_FILES, zones: OWNERSHIP_ZONES }),
        extraLenses: [lens({ id: 'pci', label: 'PCI DSS', paths: PCI_FILES })],
        currentUser: REVIEWER,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
