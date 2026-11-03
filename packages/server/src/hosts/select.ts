import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { Iteration, ReviewSource } from '@sherpa/protocol';
import { ARCANUM_PR_KEY_PREFIX, GITHUB_PR_KEY_PREFIX, localHostName, localVcsOfPrKey, parseGithubPrKey } from '@sherpa/protocol';
import { DEFAULT_SHERPA_DIR } from '../paths.js';
import { makeArcanumHost } from './arcanum/arcanum-host.js';
import { makeGithubHost } from './github/index.js';
import { makeLocalHost } from './local/index.js';

export interface SelectHostOptions { sherpaDir?: string; repo?: string | null; base?: string | null; branch?: string | null }
export interface SelectedSource { readonly name: string; readonly host: ReviewSource; readonly advanceIteration?: () => Iteration; readonly refresh?: () => Promise<void> }
export type ReviewSourceFactory = (prKey: string, options: SelectHostOptions) => SelectedSource | null;
/** Фабрика создаёт только источники чтения, без полного review-адаптера под фасадом. */
export function selectReviewSource(prKey: string, options: SelectHostOptions = {}): SelectedSource | null {
    if (prKey.startsWith(ARCANUM_PR_KEY_PREFIX)) {
        const id = prKey.slice(ARCANUM_PR_KEY_PREFIX.length);
        return /^[1-9]\d*$/.test(id) ? { name: 'arcanum', host: makeArcanumHost({ prId: Number(id) }) } : null;
    }
    if (prKey.startsWith(GITHUB_PR_KEY_PREFIX)) {
        const ref = parseGithubPrKey(prKey);
        return ref === null ? null : { name: 'github', host: makeGithubHost({ ...ref, sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR }) };
    }
    const vcs = localVcsOfPrKey(prKey);
    if (vcs !== null) {
        const host = makeLocalHost({ prKey, vcs, sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR,
            repo: options.repo ?? null, base: options.base ?? null, branch: options.branch ?? null });
        return host === null ? null : { name: localHostName(vcs), host, refresh: () => host.refresh() };
    }
    const name = prKey.startsWith('fixture-') ? prKey.slice(8) : '';
    if (!(FIXTURE_NAMES as readonly string[]).includes(name)) return null;
    const host = makeFixtureHost(name as FixtureName);
    return { name: 'fixture', host, advanceIteration: () => host.advanceIteration() };
}
