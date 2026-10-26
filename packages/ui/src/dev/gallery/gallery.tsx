import type { Locale, UiSettings } from '@sherpa/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { updateFragment } from '../../fragment.js';
import { LocaleProvider } from '../../i18n/index.js';
import './gallery.css';
import { SettingsProvider } from '../../settings/context.tsx';
import { DocumentSettingsSync } from '../../settings/document-settings.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import type { GalleryState } from './states.tsx';
import { GALLERY_STATES } from './states.tsx';

/**
 * Галерея состояний: слева именованные состояния, справа детерминированный рендер выбранного.
 * Ни сервера, ни токена — только фикстуры и статические пропсы.
 *
 * Локаль выбирается в шапке и живёт в адресе (`#locale=en`): состояние нужно смотреть на обоих
 * языках — провайдер получает язык явным пропсом. Тема и размер текста живут в локальном сторе
 * настроек и в адресе (`#theme=light`, `#arcanum=1`, `#textsize=l`); переключатели — свои, стенда:
 * в продукте их место в меню настроек, а оно само одно из состояний галереи.
 * Умолчание темы тут тёмная, а не `auto` как в продукте: карточки должны рендериться одинаково
 * на любой системной теме, пока `#theme=auto` не попросили явно.
 */
export function Gallery({
    initialId,
    initialLocale = 'ru',
    initialTheme = 'dark',
    initialArcanum = false,
    initialTextSize = 'm',
}: {
    initialId: string | null;
    initialLocale?: Locale;
    initialTheme?: UiSettings['theme'];
    initialArcanum?: boolean;
    initialTextSize?: UiSettings['textSize'];
}) {
    const [settings] = useState(() =>
        createUiSettingsStore({
            loaded: true,
            initial: { theme: initialTheme, arcanum: initialArcanum, textSize: initialTextSize },
        }),
    );
    useEffect(() => {
        const syncFragment = (): void => {
            const snapshot = settings.getSnapshot();
            const fragment = updateFragment(window.location.hash, {
                theme: snapshot.theme,
                arcanum: snapshot.arcanum ? '1' : '0',
                textsize: snapshot.textSize,
            });
            history.replaceState(null, '', fragment);
        };
        syncFragment();
        return settings.subscribe(syncFragment);
    }, [settings]);
    const [selectedId, setSelectedId] = useState(initialId ?? GALLERY_STATES[0]?.id ?? '');
    const [locale, setLocale] = useState<Locale>(initialLocale);
    // Атрибут на `<html>` ставит `DocumentSettingsSync` по стору — как в продукте.
    const textSize = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().textSize);
    const theme = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().theme);
    const arcanum = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().arcanum);
    const selected = GALLERY_STATES.find((state) => state.id === selectedId) ?? GALLERY_STATES[0];

    const select = (id: string): void => {
        setSelectedId(id);
        // Состояние в адресе: ссылку на конкретное состояние можно прислать и переоткрыть.
        history.replaceState(null, '', updateFragment(window.location.hash, { state: id }));
    };

    const selectLocale = (next: Locale): void => {
        setLocale(next);
        history.replaceState(null, '', updateFragment(window.location.hash, { locale: next }));
    };

    const selectTextSize = (next: UiSettings['textSize']): void => {
        // Адрес обновит подписка на стор выше.
        settings.update({ textSize: next });
    };

    const selectTheme = (next: UiSettings['theme']): void => {
        settings.update({ theme: next });
    };

    return (
        <SettingsProvider store={settings}>
            <DocumentSettingsSync />
            <div className="gallery">
                <nav className="gallery__sidebar" aria-label="Состояния">
                    <div className="gallery__brand">Галерея состояний</div>
                    {groupBy(GALLERY_STATES).map(([group, states]) => (
                        <section key={group} className="gallery__group">
                            <h2 className="gallery__group-title">{group}</h2>
                            {states.map((state) => (
                                <button
                                    key={state.id}
                                    type="button"
                                    className="gallery__item"
                                    aria-current={state.id === selected?.id}
                                    onClick={() => {
                                        select(state.id);
                                    }}
                                >
                                    {state.title}
                                </button>
                            ))}
                        </section>
                    ))}
                </nav>

                <div className="gallery__stage">
                    {selected === undefined ? null : (
                        <>
                            <div className="gallery__stage-title">
                                {selected.group} · {selected.title}
                                <code className="gallery__stage-id">{selected.id}</code>
                                <div className="gallery__stage-spacer" />
                                <div className="gallery__themes" role="group" aria-label="Тема">
                                    {THEMES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === theme}
                                            onClick={() => {
                                                selectTheme(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                                <div className="gallery__themes">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-label="Стиль Arcanum"
                                        aria-checked={arcanum}
                                        onClick={() => {
                                            settings.update({ arcanum: !arcanum });
                                        }}
                                    >
                                        Стиль Arcanum
                                    </button>
                                </div>
                                <div className="gallery__locales" role="group" aria-label="Язык интерфейса">
                                    {LOCALES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === locale}
                                            onClick={() => {
                                                selectLocale(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                                <div className="gallery__textsize" role="group" aria-label="Размер текста">
                                    {TEXT_SIZES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === textSize}
                                            onClick={() => {
                                                selectTextSize(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* key: смена состояния, языка и размера текста ремоунтит рендер — начальные пропсы
                                (defaultMenuOpen и т. п.) применяются заново, а замеры вроде рамки тура
                                пересчитываются по новому размеру шрифта. */}
                            <div className="gallery__canvas" key={`${selected.id}:${locale}:${textSize}`}>
                                <LocaleProvider locale={locale}>{selected.render()}</LocaleProvider>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </SettingsProvider>
    );
}

const LOCALES: readonly Locale[] = ['ru', 'en'];

/** Темы стенда: тот же набор, что в меню настроек продукта. */
const THEMES: readonly UiSettings['theme'][] = ['auto', 'dark', 'light'];

/** Размеры текста стенда: `m` — база 16px, `l` — 18px (docs/design/theme.md, «Типографика»). */
const TEXT_SIZES: readonly UiSettings['textSize'][] = ['m', 'l'];

/** `#locale=en` из адреса; всё остальное (включая пустое) — русский. */
export function parseGalleryLocale(value: string | null): Locale {
    return value === 'en' ? 'en' : 'ru';
}

/** Три режима темы; неизвестное или пустое значение оставляет тёмную тему стенда. */
export function parseGalleryTheme(value: string | null): UiSettings['theme'] {
    return value === 'light' || value === 'auto' ? value : 'dark';
}

/** Стиль Arcanum включается только явным `#arcanum=1`. */
export function parseGalleryArcanum(value: string | null): boolean {
    return value === '1';
}

/** `#textsize=l`; всё остальное — обычный размер. */
export function parseGalleryTextSize(value: string | null): UiSettings['textSize'] {
    return value === 'l' ? 'l' : 'm';
}

function groupBy(states: readonly GalleryState[]): [string, GalleryState[]][] {
    const groups = new Map<string, GalleryState[]>();
    for (const state of states) {
        const bucket = groups.get(state.group);
        if (bucket === undefined) {
            groups.set(state.group, [state]);
        } else {
            bucket.push(state);
        }
    }
    return [...groups];
}
