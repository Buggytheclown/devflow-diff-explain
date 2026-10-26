import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';

/**
 * Глобальные настройки UI: режим диффа, режим шипа, разметка композера, язык, тема, размер
 * текста. Живут на
 * сервере в `~/.sherpa/settings.json`, а не в `localStorage`: сервер каждого PR слушает
 * случайный порт, и хранилище браузера у каждого PR своё.
 *
 * Смена применяется оптимистично и уезжает на сервер следом. Провал записи не откатывает выбор —
 * ревьюер уже видит новый режим, и дёргать его назад хуже, чем потерять персист.
 */

export const DEFAULT_UI_SETTINGS: UiSettings = uiSettingsSchema.parse({});

/**
 * Поля настроек по одному. Схема патча для этого не годится: `.partial()` над схемой с дефолтами
 * подставляет дефолт вместо отсутствующего ключа, и «не трогай поле» превратилось бы в «сбрось».
 */
const SETTINGS_FIELDS = [
    'diffMode',
    'shipMode',
    'composerLayout',
    'locale',
    'theme',
    'arcanum',
    'textSize',
    // Вложенные объекты: сравнение «то же значение» тут по ссылке, и патч уезжает всегда.
    // Пишет каждый из них одно место — тур первого захода и «не напоминать про эту версию».
    'onboarding',
    'updates',
] as const satisfies readonly (keyof UiSettings)[];

export interface UiSettingsStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => UiSettings;
    /**
     * Ответ сервера уже применён. Первый рендер идёт по таймауту и может застать умолчания —
     * решения, которые нельзя принимать по чужому значению (показывать ли тур первого захода),
     * ждут этого флага.
     */
    readonly isLoaded: () => boolean;
    /** Применяет названные поля сразу и шлёт PATCH; повторы уже известного выбора не отправляет. */
    readonly update: (patch: UiSettingsPatch) => void;
    /**
     * Настройки, приехавшие с сервера на старте. Поля, которые ревьюер успел поменять руками,
     * серверный ответ не перебивает: он старше этого выбора.
     */
    readonly applyLoaded: (settings: UiSettings) => void;
}

export interface UiSettingsStoreOptions {
    readonly initial?: Partial<UiSettings>;
    /** Считать настройки уже загруженными: галерее и тестам компонентов ждать нечего. */
    readonly loaded?: boolean;
    /** Транспорт записи; без него настройки живут только в памяти (тесты, галерея). */
    readonly send?: (patch: UiSettingsPatch) => Promise<UiSettings>;
}

export function createUiSettingsStore(options: UiSettingsStoreOptions = {}): UiSettingsStore {
    const listeners = new Set<() => void>();
    const changedHere = new Set<keyof UiSettings>();
    let snapshot: UiSettings = { ...DEFAULT_UI_SETTINGS, ...options.initial };
    let loaded = options.loaded ?? false;
    // Записи выстроены в цепочку: два PATCH подряд не должны примениться в обратном порядке.
    let queue: Promise<unknown> = Promise.resolve();

    const notify = (): void => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    /** Применяет только те поля, что названы и отличаются; возвращает их же для отправки. */
    const applyLocally = (patch: UiSettingsPatch): UiSettingsPatch => {
        const changes: UiSettingsPatch = {};
        for (const field of SETTINGS_FIELDS) {
            const value = patch[field];
            if (value !== undefined && value !== snapshot[field]) {
                Object.assign(changes, { [field]: value });
            }
        }
        if (Object.keys(changes).length === 0) {
            return changes;
        }
        // Снапшот всегда проходит схему: чужое значение в него не попадёт.
        snapshot = uiSettingsSchema.parse({ ...snapshot, ...changes });
        notify();
        return changes;
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        isLoaded: () => loaded,

        update: (patch) => {
            const changes = applyLocally(patch);
            for (const field of SETTINGS_FIELDS) {
                const value = patch[field];
                // До GET значение может быть лишь оформлением первого HTML (light при Auto).
                // Первый явный выбор сохраняем даже при совпадении; последующие повторы — no-op.
                if (!loaded && value !== undefined && !changedHere.has(field)) {
                    Object.assign(changes, { [field]: value });
                }
                if (changes[field] !== undefined) {
                    changedHere.add(field);
                }
            }
            const send = options.send;
            if (send === undefined || Object.keys(changes).length === 0) {
                return;
            }
            queue = queue.then(
                () =>
                    send(changes).catch((error: unknown) => {
                        console.warn('Sherpa: failed to persist a UI setting:', error);
                    }),
                () => undefined,
            );
        },

        applyLoaded: (settings) => {
            const fresh: UiSettingsPatch = {};
            for (const field of SETTINGS_FIELDS) {
                if (!changedHere.has(field)) {
                    Object.assign(fresh, { [field]: settings[field] });
                }
            }
            const wasLoaded = loaded;
            loaded = true;
            // Сам флаг — тоже повод перерисоваться: ответ мог совпасть с умолчаниями до поля.
            if (Object.keys(applyLocally(fresh)).length === 0 && !wasLoaded) {
                notify();
            }
        },
    };
}

/**
 * Boot-GET настроек: результат применяется к стору, провал оставляет начальные значения.
 * В основном UI оформление уже взято из первого HTML, остальные поля — из умолчаний.
 */
export function loadUiSettings(store: UiSettingsStore, load: () => Promise<UiSettings>): Promise<void> {
    return load().then(
        (settings) => {
            store.applyLoaded(settings);
        },
        (error: unknown) => {
            console.warn('Sherpa: UI settings failed to load, keeping initial values:', error);
        },
    );
}
