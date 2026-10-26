import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { useT } from '../i18n/index.js';
import { tourStepCount, useTourReplay } from '../onboarding/index.js';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import './settings-menu.css';

/**
 * Меню настроек в шапке (docs/design/SPEC-theming-2026-09-12.md §7): тема, язык, размер текста
 * и два действия — повтор онбординга и палитра команд. Заменило кнопку темы: аккаунта у скилла
 * нет, а трёх настроек в шапке по кнопке не разложить.
 *
 * Закрытие — как у меню Ship и селекта фильтра: слой `popover` в лестнице Esc плюс mousedown
 * мимо. Оттуда же берётся взаимное закрытие: нажатие на триггер долетает до document, и чужие
 * меню видят его как клик снаружи. Прозрачной подложки из §7 спеки у меню нет — она перекрыла бы
 * чужие триггеры и съедала бы первое нажатие по ним (подробности в `settings-menu.css`).
 */

export interface SettingsMenuProps {
    /** Агент подключён: без него в проходе тура нет шага про чат, и шагов семь, а не восемь. */
    readonly agentConnected: boolean;
    /** Открыть палитру команд. */
    readonly onOpenCommands: () => void;
    /** Перезапуск идущего прохода тура — то же, что делает команда палитры `tour.replay`. */
    readonly onReplayTour: () => void;
    /** Меню открыто сразу: карточки галереи состояний. */
    readonly defaultOpen?: boolean;
}

export function SettingsMenu({ agentConnected, onOpenCommands, onReplayTour, defaultOpen = false }: SettingsMenuProps) {
    const t = useT();
    const settings = useUiSettingsStore();
    const { theme, arcanum, locale, textSize } = useUiSettings();
    const replayTour = useTourReplay(onReplayTour);
    const [open, setOpen] = useState(defaultOpen);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        if (returnFocus) {
            triggerRef.current?.focus();
        }
    }, []);

    // Клик мимо закрывает меню с возвратом фокуса на триггер — как у селекта фильтра.
    useEffect(() => {
        if (!open) {
            return;
        }
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) {
                close(true);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [close, open]);

    useEscapeLayer('popover', () => {
        close(true);
    }, open);

    return (
        <div className="settings-menu" ref={rootRef}>
            <button
                type="button"
                ref={triggerRef}
                className="ctl ctl--icon settings-menu__trigger"
                title={t('settings.title')}
                aria-label={t('settings.title')}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        setOpen(true);
                    }
                }}
            >
                <Icon name="sliders" size={15} />
            </button>

            {open ? (
                <div className="settings-menu__panel" role="dialog" aria-label={t('settings.title')}>
                    <div className="settings-menu__kicker">{t('settings.kicker')}</div>

                    <SettingsRow label={t('settings.theme')}>
                        <Segments
                            label={t('settings.theme')}
                            value={theme}
                            options={[
                                { value: 'auto', label: t('settings.auto') },
                                { value: 'dark', label: t('settings.theme.dark') },
                                { value: 'light', label: t('settings.theme.light') },
                            ]}
                            onSelect={(value) => {
                                settings.update({ theme: value });
                            }}
                        />
                    </SettingsRow>

                    <SettingsRow label={t('settings.arcanum')}>
                        <button
                            type="button"
                            role="switch"
                            aria-label={t('settings.arcanum')}
                            aria-checked={arcanum}
                            className={`ctl-switch settings-menu__switch${arcanum ? ' is-on' : ''}`}
                            onClick={() => {
                                settings.update({ arcanum: !arcanum });
                            }}
                        >
                            <span className="ctl-switch__track" aria-hidden="true">
                                <span className="ctl-switch__knob" />
                            </span>
                        </button>
                    </SettingsRow>

                    <SettingsRow label={t('settings.language')}>
                        <Segments
                            label={t('settings.language')}
                            value={locale}
                            options={[
                                { value: 'auto', label: t('settings.auto') },
                                // Коды языков и буквы размеров одинаковы на обоих языках — в словаре им делать нечего.
                                { value: 'en', label: 'EN' },
                                { value: 'ru', label: 'RU' },
                            ]}
                            onSelect={(value) => {
                                settings.update({ locale: value });
                            }}
                        />
                    </SettingsRow>

                    <SettingsRow label={t('settings.textSize')}>
                        <Segments
                            label={t('settings.textSize')}
                            value={textSize}
                            options={[
                                { value: 'm', label: 'M' },
                                { value: 'l', label: 'L' },
                            ]}
                            onSelect={(value) => {
                                settings.update({ textSize: value });
                            }}
                        />
                    </SettingsRow>

                    <div className="settings-menu__divider" />

                    <button
                        type="button"
                        className="settings-menu__action"
                        onClick={() => {
                            close(false);
                            replayTour();
                        }}
                    >
                        <span className="settings-menu__action-label">{t('settings.replay')}</span>
                        <span className="settings-menu__meta">
                            {t('settings.steps', tourStepCount(agentConnected))}
                        </span>
                    </button>

                    <button
                        type="button"
                        className="settings-menu__action"
                        onClick={() => {
                            close(false);
                            onOpenCommands();
                        }}
                    >
                        <span className="settings-menu__action-label">{t('settings.commands')}</span>
                        <span className="settings-menu__key">⌘K</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="settings-menu__row">
            <span className="settings-menu__label">{label}</span>
            {children}
        </div>
    );
}

/** Мини-сегмент строки настройки: выбор применяется сразу, меню при этом остаётся открытым. */
function Segments<T extends string>({
    className = '',
    label,
    value,
    options,
    onSelect,
}: {
    className?: string;
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onSelect: (value: T) => void;
}) {
    return (
        <div className={`settings-menu__segments ctl-tabs ctl-tabs--small ${className}`} role="group" aria-label={label}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    className={`settings-menu__segment ctl ctl--tab${option.value === value ? ' is-active' : ''}`}
                    aria-pressed={option.value === value}
                    onClick={() => {
                        onSelect(option.value);
                    }}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
