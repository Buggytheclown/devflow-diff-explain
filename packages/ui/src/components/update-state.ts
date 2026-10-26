import type { UiUpdate } from '@sherpa/protocol';
import { useEffect, useState } from 'react';

import { updateCheck } from '../api.js';
import { useT } from '../i18n/index.js';
import { useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';

/**
 * Состояние тоста обновления: когда он появляется, что его прячет и команда палитры
 * «Проверить обновления». Всё поведение тоста живёт здесь — компонент только рисует.
 */

/** Пауза после прихода `uiState.update`: тост не должен выпрыгивать на загружающийся экран. */
const TOAST_DELAY_MS = 1500;

export interface UpdateToastState {
    readonly visible: boolean;
    /** «Позже»: до перезагрузки вкладки или до клика по версии в топбаре. */
    readonly later: () => void;
    /** Клик по версии в топбаре снимает «Позже». */
    readonly reopen: () => void;
    /** «Не напоминать про X»: сервер после этого отдаёт `update: null` сам. */
    readonly dismissVersion: () => void;
}

/**
 * `tourActive` — идёт ли тур первого захода. Тур важнее тоста: поверх него тост
 * не показывается никогда, и таймер паузы под ним не заводится.
 */
export function useUpdateToast(update: UiUpdate | null, tourActive = false): UpdateToastState {
    const settings = useUiSettingsStore();
    const latest = update?.latest ?? null;
    /** Версия, для которой пауза уже вышла; null — таймер ещё идёт или обновления нет. */
    const [readyFor, setReadyFor] = useState<string | null>(null);
    /** Версия, отложенная «Позже» в этой вкладке. */
    const [laterFor, setLaterFor] = useState<string | null>(null);

    // `update` пропал (отклонили версию, сервер перепроверился) — таймер снимается вместе
    // с эффектом, а тост исчезает по `latest === null`.
    useEffect(() => {
        if (latest === null || tourActive) {
            return;
        }
        const timer = window.setTimeout(() => {
            setReadyFor(latest);
        }, TOAST_DELAY_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [latest, tourActive]);

    return {
        visible: latest !== null && readyFor === latest && laterFor !== latest && !tourActive,
        later: () => {
            setLaterFor(latest);
        },
        reopen: () => {
            setLaterFor(null);
            setReadyFor(latest);
        },
        dismissVersion: () => {
            if (latest !== null) {
                settings.update({ updates: { dismissedVersion: latest } });
            }
        },
    };
}

/**
 * Команда палитры «Проверить обновления» (группа «Шерпа»): форсирует проверку мимо TTL и
 * отвечает строкой статуса в самой палитре — палитра для этого остаётся открытой.
 */
export function useUpdateCheckCommand(options: {
    readonly token: string;
    /** Зашитая версия этой поставки: она называется, когда обновления нет. */
    readonly current: string;
    readonly onStatus: (status: string) => void;
}): void {
    const t = useT();
    const { token, current, onStatus } = options;

    useShortcut({
        id: 'update.check',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.update.check',
        scope: 'global',
        section: 'navigation',
        consequence: 'shortcut.update.check.consequence',
        keepOpen: true,
        action: () => {
            void updateCheck(token).then(
                (update) => {
                    onStatus(
                        update === null
                            ? t('update.status.none', current)
                            : t('update.status.available', update.latest),
                    );
                },
                () => {
                    onStatus(t('update.status.failed'));
                },
            );
        },
    });
}
