import type { Lens } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubControl, MockGithubOptions } from './mock-transport.js';
import { makeMockGithubFetch, MOCK_NUMBER, MOCK_OWNER, MOCK_REPO } from './mock-transport.js';

/**
 * Линза владения GitHub-хоста: CODEOWNERS базовой ветки, последнее совпавшее правило,
 * команды ревьюера отдельным запросом. Транспорт — записанный API, живых вызовов нет.
 */

const TOKEN = 'test-token-must-never-leak-42';

function makeHost(options: MockGithubOptions = {}): GithubHost {
    return new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: makeMockGithubFetch(options),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
}

/** Линза без `null`: у GitHub понятие владения есть всегда, метод его не гасит. */
async function ownership(options: MockGithubOptions = {}): Promise<Lens> {
    const lens = await makeHost(options).ownershipLens();
    if (lens === null) {
        throw new Error('GitHub-хост обязан отдавать линзу владения');
    }
    return lens;
}

describe('адаптер GitHub: линза владения по CODEOWNERS', () => {
    it('зоны PR собираются по правилам файла, мои файлы — по логину', async () => {
        const lens = await ownership();

        expect(lens.id).toBe('mine');
        expect(lens.available).toBe(true);
        expect(lens.note).toBeNull();
        expect(lens.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
        expect(lens.zones).toEqual([
            {
                path: 'assets',
                mine: false,
                owner: 'bob',
                paths: ['assets/logo.png', 'assets/icon.svg', 'assets/huge.png'],
            },
            { path: 'docs', mine: false, owner: 'acme/docs-team', paths: ['docs/readme.md'] },
            {
                path: 'src',
                mine: true,
                owner: 'alice',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
    });

    it('файлы линзы целиком лежат в зонах mine, чужие зоны их не содержат', async () => {
        const lens = await ownership();
        const mine = new Set(lens.paths);
        const zoned = new Set((lens.zones ?? []).filter((zone) => zone.mine).flatMap((zone) => zone.paths));

        expect([...mine].every((path) => zoned.has(path))).toBe(true);
        expect(zoned.size).toBe(mine.size);
        for (const zone of lens.zones ?? []) {
            if (!zone.mine) {
                expect(zone.paths.some((path) => mine.has(path))).toBe(false);
            }
        }
    });

    it('владение по команде: файл команды ревьюера — мой', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '/docs/ @acme/core\n/src/ @acme/docs-team\n' },
            teams: { acme: ['core'] },
        });

        expect(lens.paths).toEqual(['docs/readme.md']);
        expect(lens.zones).toEqual([
            { path: 'docs', mine: true, owner: 'acme/core', paths: ['docs/readme.md'] },
            {
                path: 'src',
                mine: false,
                owner: 'acme/docs-team',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
    });

    it('запрос команд не прошёл — владение считается по логинам, а линза не кэшируется', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({
            calls,
            failing: { SherpaOrgTeams: 403 },
            codeowners: { '.github/CODEOWNERS': '/docs/ @acme/core\n/src/ @alice\n' },
        });

        const lens = await host.ownershipLens();
        expect(lens?.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
        expect(lens?.note).toBe(
            'GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.',
        );
        expect(lens?.zones?.map((zone) => [zone.path, zone.mine])).toEqual([
            ['docs', false],
            ['src', true],
        ]);

        await host.ownershipLens();
        expect(calls.get('SherpaOrgTeams')).toBe(2);
    });

    it('организация не видна токену — её команды моими не считаются', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '* @other-org/core\n' },
            teams: {},
        });

        expect(lens.available).toBe(false);
        expect(lens.note).toBe(
            'No files of this PR are in your CODEOWNERS zones. GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.',
        );
        // Шаблон `*` статического префикса не имеет: зоной становится верхний каталог файла.
        expect(lens.zones?.map((zone) => zone.path)).toEqual(['assets', 'docs', 'src']);
    });

    it('CODEOWNERS нет ни в одном из трёх мест — линза выключена с объяснением', async () => {
        const lens = await ownership({ codeowners: {} });

        expect(lens).toEqual({
            id: 'mine',
            label: 'My files',
            paths: [],
            available: false,
            note: 'This repository has no CODEOWNERS file.',
            zones: null,
        });
    });

    it('файл есть, но ни одного правила в нём нет', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '# только комментарий\n\n' } });

        expect(lens.note).toBe('CODEOWNERS has no rules.');
        expect(lens.zones).toBeNull();
    });

    it('побеждает файл из `.github`, даже когда рядом лежит корневой', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '/src/ @alice\n', CODEOWNERS: '* @bob\n' },
        });

        expect(lens.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
    });

    it('правило без владельцев снимает владение — такие файлы вне зон', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '* @alice\n/src/bundle.js\n' } });

        expect(lens.paths).not.toContain('src/bundle.js');
        expect((lens.zones ?? []).flatMap((zone) => zone.paths)).not.toContain('src/bundle.js');
        expect(lens.zones?.map((zone) => zone.path)).toEqual(['assets', 'docs', 'src']);
    });

    it('ни одного моего файла — линза выключена, но чужие зоны остаются', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '* @bob\n' } });

        expect(lens.available).toBe(false);
        expect(lens.paths).toEqual([]);
        expect(lens.note).toBe('No files of this PR are in your CODEOWNERS zones.');
        expect(lens.zones?.every((zone) => !zone.mine)).toBe(true);
        expect(lens.zones?.flatMap((zone) => zone.paths).length).toBe(9);
    });

    it('CODEOWNERS не прочитался — линза деградирует и в кэше не задерживается', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls, failing: { SherpaCodeowners: 500 } });

        const lens = await host.ownershipLens();
        expect(lens?.available).toBe(false);
        expect(lens?.zones).toBeNull();
        // Ревьюеру — фраза про файл; имя запроса и код ответа остаются в server.log.
        expect(lens?.note).toBe('GitHub could not read the CODEOWNERS file of this repository.');

        await host.ownershipLens();
        expect(calls.get('SherpaCodeowners')).toBe(2);
    });

    it('линза кэшируется на голову ветки и пересчитывается после пуша', async () => {
        const calls = new Map<string, number>();
        const control: MockGithubControl = {};
        const host = makeHost({ calls, control });

        await host.ownershipLens();
        await host.ownershipLens();
        expect(calls.get('rest:files')).toBe(1);
        expect(calls.get('SherpaCodeowners')).toBe(1);

        control.push?.();
        await host.ownershipLens();
        expect(calls.get('rest:files')).toBe(2);
        // Файл владельцев живёт на базе PR: пуш его не трогает.
        expect(calls.get('SherpaCodeowners')).toBe(1);
    });

    it('база ушла вперёд без пуша — владельцы перечитываются с нового коммита базы', async () => {
        const calls = new Map<string, number>();
        const control: MockGithubControl = {};
        const host = makeHost({ calls, control });

        expect((await host.ownershipLens())?.available).toBe(true);

        control.mergeIntoBase?.({ '.github/CODEOWNERS': '/src/ @bob\n' });
        const lens = await host.ownershipLens();

        expect(lens?.available).toBe(false);
        expect(lens?.zones).toEqual([
            {
                path: 'src',
                mine: false,
                owner: 'bob',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
        expect(calls.get('SherpaCodeowners')).toBe(2);
        // Состав диффа держится за голову ветки, а она не двигалась.
        expect(calls.get('rest:files')).toBe(1);
    });
});
