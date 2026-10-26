import { describe, expect, it } from 'vitest';

import {
    githubPrKey,
    LOCAL_VCS_KINDS,
    localPrKeyPrefix,
    localVcsOfPrKey,
    parseGithubPrKey,
    parseGithubPrUrl,
} from './pr-key.js';
import { prKeySchema } from './manifest.js';

describe('ключ GitHub-PR', () => {
    it('склеивается удвоенным дефисом и проходит схему ключа', () => {
        const key = githubPrKey({ owner: 'yandex', repo: 'sherpa.js', number: 17 });

        expect(key).toBe('github-yandex--sherpa.js--17');
        expect(prKeySchema.safeParse(key).success).toBe(true);
    });

    it('разбирается обратно, включая репозиторий с удвоенным дефисом', () => {
        expect(parseGithubPrKey('github-o--r--1')).toEqual({ owner: 'o', repo: 'r', number: 1 });
        expect(parseGithubPrKey('github-acme-corp--ui--kit--42')).toEqual({
            owner: 'acme-corp',
            repo: 'ui--kit',
            number: 42,
        });
        // Репозиторий, кончающийся дефисом: номер отрезается по последнему `--`, дефис остаётся имени.
        expect(parseGithubPrKey('github-o--repo---7')).toEqual({ owner: 'o', repo: 'repo-', number: 7 });
    });

    it('туда и обратно для имён с точками, подчёркиваниями и цифрами', () => {
        for (const ref of [
            { owner: 'a', repo: 'b', number: 1 },
            { owner: 'Yandex-Team', repo: 'sherpa_ui.v2', number: 123456 },
            { owner: 'user2', repo: 'a--b--c', number: 9 },
        ]) {
            expect(parseGithubPrKey(githubPrKey(ref))).toEqual(ref);
        }
    });

    it('чужие и кривые ключи не разбираются', () => {
        for (const key of [
            'arcanum-4242',
            'fixture-medium',
            'local-arc-app-0badc0de',
            'github-o--r',
            'github-o--r--0',
            'github-o--r--x',
            'github---r--1',
            'github-o--r--',
            'github-o-r--1',
        ]) {
            expect(parseGithubPrKey(key), key).toBeNull();
        }
    });

    it('владелец с удвоенным дефисом ключом не притворяется', () => {
        // `o--x` как владелец неразличим с `o` + репозиторием `x`: такого логина у GitHub нет.
        expect(parseGithubPrKey('github-o--x--r--3')).toEqual({ owner: 'o', repo: 'x--r', number: 3 });
    });
});

describe('ссылка на PR github.com', () => {
    it('разбирается с любым хвостом и без схемы', () => {
        const expected = { owner: 'yandex', repo: 'sherpa', number: 42 };

        expect(parseGithubPrUrl('https://github.com/yandex/sherpa/pull/42')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/yandex/sherpa/pull/42/files')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/yandex/sherpa/pull/42#discussion_r1')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/yandex/sherpa/pull/42?w=1')).toEqual(expected);
        expect(parseGithubPrUrl('http://www.github.com/yandex/sherpa/pull/42')).toEqual(expected);
        expect(parseGithubPrUrl('  github.com/yandex/sherpa/pull/42  ')).toEqual(expected);
    });

    it('ключ из ссылки — тот же, что из частей', () => {
        const ref = parseGithubPrUrl('https://github.com/acme-corp/ui--kit/pull/7');
        expect(ref).not.toBeNull();
        expect(githubPrKey(ref ?? { owner: '', repo: '', number: 0 })).toBe('github-acme-corp--ui--kit--7');
    });

    it('не ссылка на PR github.com — null', () => {
        for (const url of [
            'https://github.com/yandex/sherpa',
            'https://github.com/yandex/sherpa/issues/42',
            'https://gitlab.com/yandex/sherpa/pull/42',
            'https://github.example.com/yandex/sherpa/pull/42',
            'https://a.yandex-team.ru/review/12345',
            'github-yandex--sherpa--42',
        ]) {
            expect(parseGithubPrUrl(url), url).toBeNull();
        }
    });
});

describe('ключ локального ревью', () => {
    it('вид VCS читается из префикса ключа', () => {
        expect(localVcsOfPrKey('local-arc-sherpa-0badc0de')).toBe('arc');
        expect(localVcsOfPrKey('local-git-app-0badc0de')).toBe('git');
    });

    it('чужие и неполные ключи локальными не считаются', () => {
        expect(localVcsOfPrKey('arcanum-1')).toBeNull();
        expect(localVcsOfPrKey('fixture-medium')).toBeNull();
        expect(localVcsOfPrKey('local-app-0badc0de')).toBeNull();
        expect(localVcsOfPrKey('local-svn-app-0badc0de')).toBeNull();
    });

    it('префикс собирается из вида VCS', () => {
        expect(LOCAL_VCS_KINDS.map((kind) => localPrKeyPrefix(kind))).toEqual(['local-arc-', 'local-git-']);
    });
});
