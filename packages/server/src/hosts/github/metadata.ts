import type { ReviewUser } from '@sherpa/protocol';


import type { GithubActor } from './schemas.js';

export function userOf(actor: GithubActor | null): ReviewUser {
    if (actor === null) {
        // Удалённый аккаунт: GitHub отдаёт `author: null`, а комментарий показывает как ghost.
        return { login: 'ghost', displayName: null, bot: false, avatarUrl: null };
    }
    return {
        login: actor.login,
        displayName: actor.name ?? null,
        bot: actor.__typename === 'Bot' || actor.login.endsWith('[bot]'),
        avatarUrl: avatarOf(actor.avatarUrl),
    };
}

export function avatarOf(url: string | undefined): string | null {
    return url?.startsWith('https://') === true ? url : null;
}

export function isoTime(raw: string): string {
    const time = new Date(raw);
    if (Number.isNaN(time.getTime())) {
        throw new Error(`GitHub прислал нечитаемое время: ${JSON.stringify(raw)}`);
    }
    return time.toISOString();
}
