import { localIterationsDirOf, localReviewPathFor } from '../../paths.js';

import { arcVcs } from './arc-vcs.js';
import { gitVcs } from './git-vcs.js';
import { fileIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import type { LocalHostState } from './state.js';
import { readLocalHostState, writeLocalHostState } from './state.js';
import { fileThreadsStore } from './threads-store.js';
import type { LocalVcs, LocalVcsKind } from './vcs.js';
import { commandRunnerIn } from './vcs.js';

export { LocalHost } from './local-host.js';
export type { LocalHostOptions } from './local-host.js';
export { readLocalHostState, writeLocalHostState } from './state.js';
export type { LocalHostState } from './state.js';

export interface LocalHostSetup {
    readonly prKey: string;
    /** Какая VCS стоит за ключом: её называет префикс ключа. */
    readonly vcs: LocalVcsKind;
    readonly sherpaDir: string;
    /** Каталог проекта из `--repo`; null — берём сохранённое состояние ключа. */
    readonly repo: string | null;
    /** База из `--base`; учитывается только вместе с `--repo`. */
    readonly base: string | null;
    /** Ветка из `--branch`: на ней CLI построил ключ; null — ветку зафиксирует первый снимок. */
    readonly branch: string | null;
    /** Поручение на исход ревью из `--verdicts`; как и база, учитывается только вместе с `--repo`. */
    readonly verdicts: string | null;
}

/**
 * Хост локального ревью для ключа `local-<vcs>-*`. Каталог проекта приходит либо флагом `--repo`
 * (и тогда же сохраняется), либо из состояния, записанного прошлым запуском; нет ни того,
 * ни другого — хоста нет.
 */
export function makeLocalHost(setup: LocalHostSetup): LocalHost | null {
    const stored = readLocalHostState(setup.sherpaDir, setup.prKey);
    const state = resolveState(setup, stored);
    if (state === null) {
        return null;
    }
    if (setup.repo !== null) {
        writeLocalHostState(setup.sherpaDir, setup.prKey, state);
    }

    // Ветку и поручение дописывают в разное время: каждая запись идёт от последнего записанного
    // состояния, а неудачная запись его не сдвигает.
    let current = state;
    const persist = (patch: Partial<LocalHostState>): void => {
        const next = { ...current, ...patch };
        writeLocalHostState(setup.sherpaDir, setup.prKey, next);
        current = next;
    };

    return new LocalHost({
        prKey: setup.prKey,
        vcs: vcsIn(setup.vcs, state.repo),
        projectDir: state.repo,
        base: state.base,
        branch: state.branch,
        verdicts: state.verdicts,
        threads: fileThreadsStore(localReviewPathFor(setup.sherpaDir, setup.prKey)),
        iterations: fileIterationsStore(localIterationsDirOf(setup.sherpaDir, setup.prKey)),
        onBranchResolved: (branch) => {
            persist({ branch });
        },
        onVerdictsChanged: (verdicts) => {
            persist({ verdicts });
        },
    });
}

/** Бэкенд VCS, разговаривающий с каталогом проекта. */
function vcsIn(kind: LocalVcsKind, repo: string): LocalVcs {
    const run = commandRunnerIn(kind, repo);
    return kind === 'arc' ? arcVcs(run) : gitVcs(run);
}

/**
 * Ветка ключа переживает перезапуск. Обычный ход — её называет CLI (`--branch`): на ней он и
 * построил ключ, а чекаут между `up` и первым снимком могут переключить. Без флага остаётся
 * ветка прошлого запуска, а если и её нет — зафиксирует первый снимок.
 */
function resolveState(setup: LocalHostSetup, stored: LocalHostState | null): LocalHostState | null {
    if (setup.repo === null) {
        return stored;
    }
    return {
        repo: setup.repo,
        branch: setup.branch ?? (stored?.repo === setup.repo ? stored.branch : null),
        base: setup.base,
        // Поручение называет каждый `up --local`: без флага режим снимается, побеждает последний вызов.
        verdicts: setup.verdicts,
    };
}
