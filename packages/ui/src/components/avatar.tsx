import { useState } from 'react';

import './avatar.css';

export interface AvatarProps {
    /** Класс бокса места вызова: размер, форма, фон и шрифт инициалов живут там. */
    readonly className: string;
    /** Имя, из которого берутся инициалы. */
    readonly name: string;
    readonly url: string | null;
    /** `pair` — правило шапки PR, см. `pairInitials`. */
    readonly initialsRule?: 'words' | 'pair';
}

/**
 * Аватар человека или бота — круглый у всех: фото, когда хост его дал, иначе инициалы. Инициалы
 * лежат под фото всегда — пока фото грузится и после ошибки загрузки бокс не пустеет. Имя всегда
 * стоит рядом или в подписи контрола, поэтому аватар декоративный.
 */
export function Avatar({ className, name, url, initialsRule = 'words' }: AvatarProps) {
    // URL, которые не загрузились: повторно их не просим, пока компонент жив.
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    return (
        <span className={`avatar ${className}`} aria-hidden="true">
            {initialsRule === 'pair' ? pairInitials(name) : initials(name)}
            {url === null || failed.has(url) ? null : (
                <img
                    className="avatar__photo"
                    src={url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => {
                        setFailed((prev) => new Set(prev).add(url));
                    }}
                />
            )}
        </span>
    );
}

/** Одна или две буквы: первые буквы двух первых слов имени или логина. */
export function initials(name: string): string {
    return name
        .split(/[\s._-]+/u)
        .filter((part) => part !== '')
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}

/** Две буквы: первые буквы двух первых слов, а у однословного имени — его первые две буквы. */
export function pairInitials(name: string): string {
    const parts = name.split(/[\s._-]+/u).filter((part) => part !== '');
    if (parts.length >= 2) {
        return initials(name);
    }
    return name.slice(0, 2).toUpperCase();
}
