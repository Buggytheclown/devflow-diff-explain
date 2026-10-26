import { describe, expect, it } from 'vitest';

import {
    appliedReviewRules,
    isAppliedReviewRule,
    isSummonedReviewer,
    summoningReviewRules,
} from './review-rules.js';
import type { ReviewRule } from './review-rules.js';
import { MATCH_ALL } from './rules/subpaths.js';
import type { ArcReviewRule } from './schemas.js';

/**
 * Чистая часть сверки preview-правил с `review.rules` PR: критерий призыва и его
 * предохранитель. Сеть и деградация — в `arcanum-host.test.ts`.
 */

const ME = 'alice';

const ANY_REVIEWER: ArcReviewRule = {
    roles: ['example:any_reviewer'],
    configs: [{ path: '/examples/ui/packages/direct-modules/a.yaml' }],
    assign: 0,
    ship: 1,
    reviewers_names: [ME, 'carol'],
};

const NARROW: ArcReviewRule = {
    roles: ['example:checkout_developer'],
    configs: [{ path: '/examples/ui/packages/direct-modules/a.yaml' }],
    assign: 1,
    ship: 1,
    reviewers_names: [ME],
};

const WITHOUT_DUTY: ArcReviewRule = {
    roles: ['example:infra_without_duty'],
    configs: [{ path: '/examples/ui/a.yaml' }],
    assign: 1,
    ship: 0,
    reviewers_names: [ME],
};

const FOREIGN: ArcReviewRule = {
    roles: ['example:docs_owner'],
    configs: [{ path: '/examples/ui/docs/a.yaml' }],
    assign: 1,
    ship: 1,
    reviewers_names: ['carol'],
};

function previewRule(configPath: string, roles: readonly string[]): ReviewRule {
    return {
        configPath,
        baseDir: configPath.replace(/^\/+/, '').replace(/\/[^/]*$/, ''),
        alias: null,
        roles,
        authors: [],
        members: new Set([ME]),
        subpaths: MATCH_ALL,
    };
}

describe('критерий призыва', () => {
    it('оставляет только правила с assign > 0 и моим логином', () => {
        expect(summoningReviewRules([ANY_REVIEWER, NARROW, FOREIGN], ME)).toEqual([NARROW]);
    });

    it('ship: 0 не мешает — группа без дежурства всё равно призывает', () => {
        expect(summoningReviewRules([ANY_REVIEWER, WITHOUT_DUTY], ME)).toEqual([WITHOUT_DUTY]);
    });

    it('предохранитель: меня нет ни в одном reviewers_names — все правила', () => {
        const rules = [ANY_REVIEWER, NARROW, FOREIGN];
        expect(isSummonedReviewer([FOREIGN], ME)).toBe(false);
        expect(summoningReviewRules([FOREIGN], ME)).toEqual([FOREIGN]);
        // Логина нет вовсе — тот же предохранитель.
        expect(summoningReviewRules(rules, null)).toEqual(rules);
    });

    it('предохранитель: полей призыва в ответе нет — все правила', () => {
        const legacy: ArcReviewRule[] = [
            { roles: ['example:any_reviewer'], configs: [{ path: '/a.yaml' }] },
        ];
        expect(summoningReviewRules(legacy, ME)).toEqual(legacy);
    });

    it('я ревьюер, но призвали не меня — ни одного правила, не предохранитель', () => {
        expect(isSummonedReviewer([ANY_REVIEWER], ME)).toBe(true);
        expect(summoningReviewRules([ANY_REVIEWER], ME)).toEqual([]);
    });
});

describe('сверка preview-правила с применёнными', () => {
    it('правило совпадает по паре «путь a.yaml × роль», ведущий слэш не мешает', () => {
        const applied = appliedReviewRules([NARROW], { matchRulesWithoutRoles: false });
        const mine = previewRule('examples/ui/packages/direct-modules/a.yaml', [
            'example:checkout_developer',
        ]);
        const other = previewRule('examples/ui/packages/direct-modules/a.yaml', [
            'example:any_reviewer',
        ]);

        expect(isAppliedReviewRule(mine, applied)).toBe(true);
        expect(isAppliedReviewRule(other, applied)).toBe(false);
    });

    it('правило без ролей: применено в обычном режиме, отброшено в режиме призыва', () => {
        const roleless = previewRule('examples/ui/a.yaml', []);

        const lenient = appliedReviewRules([ANY_REVIEWER], { matchRulesWithoutRoles: true });
        const summoning = appliedReviewRules([], { matchRulesWithoutRoles: false });

        expect(isAppliedReviewRule(roleless, lenient)).toBe(true);
        expect(isAppliedReviewRule(roleless, summoning)).toBe(false);
        // Фильтр недоступен — сверять нечем, правило считается применённым.
        expect(isAppliedReviewRule(roleless, null)).toBe(true);
    });
});
