import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { AnchorPosition, Iteration, ReviewHost, ReviewUser, Verdict } from '@sherpa/protocol';
import {
    ARCANUM_PR_KEY_PREFIX,
    GITHUB_PR_KEY_PREFIX,
    localHostName,
    localVcsOfPrKey,
    parseGithubPrKey,
} from '@sherpa/protocol';

import { DEFAULT_SHERPA_DIR } from '../paths.js';

import { makeArcanumHost } from './arcanum/arcanum-host.js';
import { makeGithubHost } from './github/index.js';
import { makeLocalHost } from './local/index.js';

/**
 * Выбор хост-адаптера по ключу PR (`<host>-<pr>`, `docs/protocol.md §8`):
 * `arcanum-<число>` — живой Арканум, `github-<владелец>--<репозиторий>--<номер>` — PR на
 * github.com, `local-arc-<каталог>-<хеш>` и `local-git-<каталог>-<хеш>` — рабочее дерево
 * локального чекаута (вид VCS называет префикс), `fixture-<имя из FIXTURE_NAMES>` —
 * детерминированные фикстуры (дев UI и e2e), что угодно другое — хоста нет, ревью-ручки
 * отвечают `no_review_host`.
 *
 * Фикстурный хост подключён к серверу осознанно: без него дев-режим и e2e требовали бы живого
 * Арканума.
 */

/** Раунд публикации, который ждёт агента: вердикт и треды с комментариями этой публикации. */
export interface FeedbackRound {
    readonly id: string;
    readonly verdict: Verdict;
    readonly createdAt: string;
    readonly threadIds: readonly string[];
}

/** Комментарий треда деревом, как его читает агент. */
export interface FeedbackComment {
    readonly author: ReviewUser;
    readonly createdAt: string;
    readonly body: string;
    readonly replies: readonly FeedbackComment[];
}

export interface FeedbackThread {
    readonly threadId: string;
    /** Путь файла от каталога проекта; null — обсуждение уровня PR. */
    readonly path: string | null;
    /** Тот же файл абсолютным путём: агент правит его прямо в чекауте. */
    readonly file: string | null;
    /** Сторона и строка якоря; null — якорь на весь файл или обсуждение уровня PR. */
    readonly position: AnchorPosition | null;
    /** Фрагмент патча вокруг якоря; null — фрагмента нет, причина в `note`. */
    readonly excerpt: string | null;
    /** Почему фрагмента нет: тред устарел или файла нет в активном диффе. */
    readonly note: string | null;
    readonly resolved: boolean;
    readonly comments: readonly FeedbackComment[];
}

export interface FeedbackRoundContext {
    readonly roundId: string;
    readonly verdict: Verdict;
    /**
     * Поручение пользователя на исход ревью (`--verdicts`) на момент сборки задачи; null — режим
     * вердиктов выключен.
     */
    readonly instruction: string | null;
    /** Каталог проекта: за его пределы агенту править нечего. */
    readonly projectDir: string;
    readonly threads: readonly FeedbackThread[];
}

/** Ответ агента в тред раунда. */
export interface FeedbackReply {
    readonly threadId: string;
    readonly body: string;
}

/**
 * Раунды локального ревью: публикация комментариев становится задачей агенту, а его ответы —
 * обычными комментариями тредов. Хост-специфика, как и `refresh`: дальше точки регистрации
 * оркестратора этот доступ не уходит.
 */
export interface FeedbackHost {
    /** Раунды `pending` в порядке создания. */
    pendingRounds(): Promise<FeedbackRound[]>;
    roundContext(roundId: string): Promise<FeedbackRoundContext>;
    /**
     * Ответы агента в треды раунда, раунд — `done` с итогом. Ответ в тред не из раунда — ошибка.
     */
    completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void>;
}

export interface SelectedHost {
    /** Имя адаптера для `uiState.reviewHost`. */
    readonly name: string;
    readonly host: ReviewHost;
    /** Необязательный host-specific whoami для автоконтекста фидбека. */
    readonly currentUser?: () => string | null | Promise<string | null>;
    /**
     * Только у фикстурного хоста: дев-«пуш» (`UI_DEV_ENDPOINTS.fixtureAdvanceIteration`).
     * Дальше точки регистрации дев-маршрута этот доступ не уходит — общий код сервера
     * о фикстурах не знает.
     */
    readonly advanceIteration?: () => Iteration;
    /**
     * Хост-специфичная подписка на смену статуса ревью (Арканум: `common_status` в дешёвом
     * полле). Есть — сервер по ней перечитывает мету PR и замечает чужой шип.
     */
    readonly watchStatus?: (onChange: () => void) => () => void;
    /** Только у фикстурного хоста: дев-переключатель отказа записи черновиков (e2e буфера). */
    readonly setFailDraftWrites?: (fail: boolean) => void;
    /**
     * Только у локального хоста: принудительный опрос рабочего дерева мимо интервала.
     * Как и остальное хост-специфичное, дальше точки регистрации этот доступ не уходит.
     */
    readonly refresh?: () => Promise<void>;
    /**
     * Только у локального хоста: поручение на исход ревью (`--verdicts`) у живого сервера, null —
     * режим снят. true — режим включился или выключился и мету PR пора перечитать.
     */
    readonly setLocalVerdicts?: (instruction: string | null) => boolean;
    /**
     * Только у локального хоста: раунды публикации, которые сервер превращает в задачи агенту.
     * Нет его — нет и оркестратора фидбека.
     */
    readonly feedback?: FeedbackHost;
}

/** Что фабрике нужно знать помимо ключа: локальному хосту — какой каталог и где его состояние. */
export interface SelectHostOptions {
    /** Каталог проекта локального ревью (`--repo`); null — берётся сохранённое состояние ключа. */
    readonly repo?: string | null;
    /** База локального ревью (`--base`); null — merge-base с базовой веткой по умолчанию. */
    readonly base?: string | null;
    /** Ветка, на которой CLI построил ключ (`--branch`); null — её зафиксирует первый снимок. */
    readonly branch?: string | null;
    /** Поручение на исход локального ревью (`--verdicts`); учитывается только вместе с `repo`. */
    readonly verdicts?: string | null;
    /** Корень стейта: в нём лежит состояние ключа. */
    readonly sherpaDir?: string;
}

export type ReviewHostFactory = (prKey: string, options: SelectHostOptions) => SelectedHost | null;

const FIXTURE_PREFIX = 'fixture-';

export function selectReviewHost(prKey: string, options: SelectHostOptions = {}): SelectedHost | null {
    if (prKey.startsWith(ARCANUM_PR_KEY_PREFIX)) {
        const raw = prKey.slice(ARCANUM_PR_KEY_PREFIX.length);
        // Только целое число: id PR у Арканума числовой, всё прочее — не его ключ.
        if (!/^[1-9]\d*$/.test(raw)) {
            return null;
        }
        const host = makeArcanumHost({ prId: Number(raw) });
        return {
            name: 'arcanum',
            host,
            currentUser: () => host.currentUser(),
            watchStatus: (onChange) => host.watchStatus(onChange),
        };
    }

    if (prKey.startsWith(GITHUB_PR_KEY_PREFIX)) {
        const ref = parseGithubPrKey(prKey);
        if (ref === null) {
            return null;
        }
        const host = makeGithubHost({ ...ref, sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR });
        return {
            name: 'github',
            host,
            currentUser: () => host.currentUser(),
            watchStatus: (onChange) => host.watchStatus(onChange),
        };
    }

    const vcs = localVcsOfPrKey(prKey);
    if (vcs !== null) {
        const host = makeLocalHost({
            prKey,
            vcs,
            sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR,
            repo: options.repo ?? null,
            base: options.base ?? null,
            branch: options.branch ?? null,
            verdicts: options.verdicts ?? null,
        });
        if (host === null) {
            return null;
        }
        return {
            name: localHostName(vcs),
            host,
            currentUser: () => host.currentUser(),
            refresh: () => host.refresh(),
            setLocalVerdicts: (instruction) => host.setVerdicts(instruction),
            feedback: host,
        };
    }

    if (prKey.startsWith(FIXTURE_PREFIX)) {
        const raw = prKey.slice(FIXTURE_PREFIX.length);
        if (!isFixtureName(raw)) {
            return null;
        }
        const host = makeFixtureHost(raw);
        return {
            name: 'fixture',
            host,
            advanceIteration: () => host.advanceIteration(),
            setFailDraftWrites: (fail) => {
                host.setFailDraftWrites(fail);
            },
        };
    }

    return null;
}

function isFixtureName(value: string): value is FixtureName {
    return (FIXTURE_NAMES as readonly string[]).includes(value);
}
