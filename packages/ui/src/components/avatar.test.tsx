// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import type { AvatarProps } from './avatar.tsx';
import { Avatar, initials, pairInitials } from './avatar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO = 'https://avatars.githubusercontent.com/alice?s=100';
const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    url: string | null,
    props: Partial<AvatarProps> = {},
): { host: HTMLElement; rerender: (next: string | null) => void } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: string | null) => {
        act(() => {
            root.render(<Avatar className="thread__avatar" name="Alice Ingram" {...props} url={next} />);
        });
    };
    render(url);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, rerender: render };
}

function fail(host: HTMLElement): void {
    const img = host.querySelector('img');
    if (img === null) {
        throw new Error('фото не нарисовано');
    }
    act(() => {
        img.dispatchEvent(new Event('error'));
    });
}

describe('аватар', () => {
    it('без URL — только инициалы в боксе места вызова', () => {
        const html = renderToStaticMarkup(<Avatar className="thread__avatar" name="Alice Ingram" url={null} />);

        expect(html).toBe('<span class="avatar thread__avatar" aria-hidden="true">AI</span>');
    });

    it('с URL — фото поверх инициалов, декоративное и ленивое', () => {
        const { host } = mount(PHOTO);
        const img = host.querySelector('img');

        expect(host.textContent).toBe('AI');
        expect(img?.getAttribute('src')).toBe(PHOTO);
        expect(img?.getAttribute('alt')).toBe('');
        expect(img?.getAttribute('loading')).toBe('lazy');
        expect(img?.getAttribute('decoding')).toBe('async');
        expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('фото не загрузилось — остаются инициалы, тот же URL повторно не просим', () => {
        const { host, rerender } = mount(PHOTO);
        fail(host);

        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toBe('AI');

        rerender(PHOTO);
        expect(host.querySelector('img')).toBeNull();

        const other = 'https://avatars.githubusercontent.com/bob?s=100';
        rerender(other);
        expect(host.querySelector('img')?.getAttribute('src')).toBe(other);

        fail(host);
        rerender(PHOTO);
        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toBe('AI');
    });

    it('шапка PR: однословный логин даёт две буквы и без фото, и после ошибки', () => {
        expect(
            renderToStaticMarkup(
                <Avatar className="pr-header__avatar" name="nolan" url={null} initialsRule="pair" />,
            ),
        ).toBe('<span class="avatar pr-header__avatar" aria-hidden="true">NO</span>');

        const { host } = mount(PHOTO, { name: 'nolan', initialsRule: 'pair' });
        fail(host);
        expect(host.textContent).toBe('NO');

        const thread = mount(null, { name: 'nolan' });
        expect(thread.host.textContent).toBe('N');
    });

    it('инициалы: два первых слова имени или логина', () => {
        expect(initials('Alice Ingram')).toBe('AI');
        expect(initials('lint-bot')).toBe('LB');
        expect(initials('a.vance')).toBe('AV');
        expect(initials('nolan')).toBe('N');
    });

    it('инициалы шапки: одно слово — две первые буквы', () => {
        expect(pairInitials('nolan')).toBe('NO');
        expect(pairInitials('Alice Ingram')).toBe('AI');
        expect(pairInitials('a.vance')).toBe('AV');
    });
});
