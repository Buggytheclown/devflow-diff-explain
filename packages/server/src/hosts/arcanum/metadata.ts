import type { ReviewUser } from '@sherpa/protocol';


const BOT_LOGIN_PREFIX = 'robot-';

export function isBotLogin(login: string): boolean {
    return login.startsWith(BOT_LOGIN_PREFIX);
}

const STAFF_AVATAR_BASE = 'https://center.yandex-team.ru/api/v1/user/';

export function arcanumUser(login: string, displayName: string | null, bot: boolean): ReviewUser {
    return {
        login,
        displayName,
        bot,
        avatarUrl: `${STAFF_AVATAR_BASE}${encodeURIComponent(login)}/avatar/100.jpg`,
    };
}

export function isoTime(raw: string): string {
    const time = new Date(raw);
    if (Number.isNaN(time.getTime())) {
        throw new Error(`Арканум прислал нечитаемое время: ${JSON.stringify(raw)}`);
    }
    return time.toISOString();
}
