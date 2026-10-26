import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localHostStatePathFor } from '../../paths.js';
import { selectReviewHost } from '../select.js';

import { makeLocalHost } from './index.js';
import { readLocalHostState, writeLocalHostState } from './state.js';

const PR_KEY = 'local-arc-app-0badc0de';
const ON_SHIP = 'on ship, commit and open a PR';

describe('состояние ключа локального ревью', () => {
    let sherpaDir: string;
    let repo: string;

    beforeEach(() => {
        sherpaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-state-'));
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-repo-'));
    });

    afterEach(() => {
        fs.rmSync(sherpaDir, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    });

    function statePath(): string {
        return localHostStatePathFor(sherpaDir, PR_KEY);
    }

    // Ветку знает CLI: он построил на ней ключ, и чекаут между `up` и первым снимком могут увести.
    it('старт с --repo сохраняет каталог, ветку и базу', () => {
        expect(
            makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: 'trunk~3', branch: 'feature', verdicts: null }),
        ).not.toBeNull();

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: 'feature', base: 'trunk~3', verdicts: null });
        expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    });

    it('старт без --branch оставляет ветку первому снимку', () => {
        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: null, branch: null, verdicts: null })).not.toBeNull();

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: null, base: null, verdicts: null });
    });

    it('старт без --repo поднимается на сохранённом состоянии', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo: null, base: null, branch: null, verdicts: null })).not.toBeNull();
    });

    it('ни --repo, ни сохранённого состояния — хоста нет', () => {
        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo: null, base: null, branch: null, verdicts: null })).toBeNull();
        expect(selectReviewHost(PR_KEY, { sherpaDir })).toBeNull();
    });

    // Ключ держит каталог и ветку вместе: на том же ключе ветка не меняется.
    it('повторный старт с тем же каталогом не теряет ветку', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: null, branch: null, verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)?.branch).toBe('feature');
    });

    it('каталог сменился — ветка прежнего каталога не наследуется', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo: '/elsewhere', branch: 'feature', base: null, verdicts: null });

        makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: null, branch: null, verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: null, base: null, verdicts: null });
    });

    it('поручение переживает перезапуск на сохранённом состоянии', () => {
        makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: null, branch: 'feature', verdicts: ON_SHIP });
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe(ON_SHIP);

        const restarted = selectReviewHost(PR_KEY, { sherpaDir });

        // То же поручение — переключать нечего: перезапуск поднялся с вердиктами.
        expect(restarted?.setLocalVerdicts?.(ON_SHIP)).toBe(false);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe(ON_SHIP);
    });

    it('повторный up --local без флага снимает режим вердиктов', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: ON_SHIP });

        makeLocalHost({ prKey: PR_KEY, vcs: 'arc', sherpaDir, repo, base: null, branch: 'feature', verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBeNull();
    });

    it('смена поручения на живом хосте сохраняется, не теряет ветку и переживает перезапуск', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: 'trunk~1', verdicts: null });
        const selected = selectReviewHost(PR_KEY, { sherpaDir });

        expect(selected?.setLocalVerdicts?.(ON_SHIP)).toBe(true);
        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({
            repo,
            branch: 'feature',
            base: 'trunk~1',
            verdicts: ON_SHIP,
        });

        // Режим уже включён: мету перечитывать незачем, но новое поручение обязано лечь на диск.
        expect(selected?.setLocalVerdicts?.('on ship, merge into trunk')).toBe(false);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe('on ship, merge into trunk');
        expect(selectReviewHost(PR_KEY, { sherpaDir })?.setLocalVerdicts?.('on ship, merge into trunk')).toBe(false);

        expect(selected?.setLocalVerdicts?.(null)).toBe(true);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBeNull();
    });

    it('состояние без поля verdicts читается как режим без вердиктов', () => {
        fs.mkdirSync(path.dirname(statePath()), { recursive: true });
        fs.writeFileSync(statePath(), JSON.stringify({ repo, branch: 'feature', base: null }));

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: 'feature', base: null, verdicts: null });
    });

    it('пустое поручение в файле не проходит схему, как и битое состояние', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: '   ' });

        expect(readLocalHostState(sherpaDir, PR_KEY)).toBeNull();
    });

    it('битое состояние равносильно его отсутствию', () => {
        fs.mkdirSync(path.dirname(statePath()), { recursive: true });
        fs.writeFileSync(statePath(), '{"repo":42}');

        expect(readLocalHostState(sherpaDir, PR_KEY)).toBeNull();
    });

    it('ключ local-arc-* выбирает локальный адаптер с принудительным опросом', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        const selected = selectReviewHost(PR_KEY, { sherpaDir });

        expect(selected?.name).toBe('local-arc');
        expect(typeof selected?.refresh).toBe('function');
        expect(selected?.advanceIteration).toBeUndefined();
    });

    // Вид VCS сервер узнаёт из префикса ключа: отдельного флага у него нет.
    it('ключ local-git-* выбирает тот же адаптер с бэкендом git', () => {
        const gitKey = 'local-git-app-0badc0de';
        writeLocalHostState(sherpaDir, gitKey, { repo, branch: 'feature', base: null, verdicts: null });

        expect(selectReviewHost(gitKey, { sherpaDir })?.name).toBe('local-git');
        // Ключ без вида VCS локальным не считается — хоста у него нет.
        expect(selectReviewHost('local-app-0badc0de', { sherpaDir })).toBeNull();
    });
});
