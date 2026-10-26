import type { Comment, ReviewUser, Thread } from '@sherpa/protocol';

/**
 * Фото людей для галереи состояний. Галерея работает офлайн, поэтому фото — data-URI маленьких
 * SVG, а не адреса хоста. Схема `ReviewUser` такие URL не пропускает: в фикстуры, которые
 * отдаёт фикстурный хост, они не попадают, их подставляет только галерея.
 */
export const GALLERY_AVATAR_PHOTOS: readonly [string, string, string] = [
    portrait('#3f6fb5', '#f1c7a1', '#1f3557'),
    portrait('#8a5a9e', '#e7b48f', '#3c2346'),
    portrait('#3b8a6e', '#c99572', '#1d4436'),
];

/** Фото, которое не загрузится: битые байты PNG, без сети — `<img>` сразу получает `error`. */
export const GALLERY_AVATAR_BROKEN = 'data:image/png;base64,AAAA';

/** Тот же пользователь с фото. */
export function withAvatar(user: ReviewUser, avatarUrl: string): ReviewUser {
    return { ...user, avatarUrl };
}

/** Треды, где авторам из `photos` подставлено фото по логину; остальные авторы без изменений. */
export function withAvatars(threads: readonly Thread[], photos: ReadonlyMap<string, string>): Thread[] {
    const swap = (comment: Comment): Comment => {
        const photo = photos.get(comment.author.login);
        return {
            ...comment,
            author: photo === undefined ? comment.author : withAvatar(comment.author, photo),
            replies: comment.replies.map(swap),
        };
    };
    return threads.map((thread) => ({ ...thread, root: swap(thread.root) }));
}

/** Силуэт на цветном фоне: голова и плечи, квадрат 100×100 — его обрезает форма бокса аватара. */
function portrait(background: string, skin: string, clothes: string): string {
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">',
        `<rect width="100" height="100" fill="${background}"/>`,
        `<ellipse cx="50" cy="96" rx="34" ry="26" fill="${clothes}"/>`,
        `<circle cx="50" cy="42" r="20" fill="${skin}"/>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
