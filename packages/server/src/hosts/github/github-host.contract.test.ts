import { describeReviewHostContract } from '../review-host-contract.js';

import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubControl, MockGithubOptions } from './mock-transport.js';
import { makeMockGithubFetch, MOCK_NUMBER, MOCK_OWNER, MOCK_REPO, MOCK_VIEWER } from './mock-transport.js';

/**
 * Контрактный набор `ReviewHost` на записанном API GitHub: чтение и запись целиком.
 * «Пуш» здесь — ручка мока, которая уводит голову ветки на новый коммит.
 */

/** Латиница не случайно: значение едет заголовком, а заголовок обязан быть ISO-8859-1. */
const TOKEN = 'test-token-must-never-leak-42';

const pushes = new WeakMap<GithubHost, MockGithubControl>();

function makeHost(options: MockGithubOptions = {}): GithubHost {
    const control: MockGithubControl = {};
    const host = new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: makeMockGithubFetch({ ...options, control }),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
    pushes.set(host, control);
    return host;
}

function push(host: GithubHost): void {
    const control = pushes.get(host)?.push;
    if (control === undefined) {
        throw new Error('мок GitHub не отдал ручку «пуш»');
    }
    control();
}

describeReviewHostContract('GitHubHost (записанный API)', () => makeHost(), { advance: push });

// Свой PR: GitHub запрещает автору любой вердикт, из режимов публикации остаются только комментарии.
describeReviewHostContract(
    'GitHubHost (свой PR)',
    () => makeHost({ prOverrides: { author: { login: MOCK_VIEWER, __typename: 'User' } } }),
    { advance: push },
);
