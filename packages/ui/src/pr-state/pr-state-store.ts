import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';

/**
 * Состояние UI одного PR: свёрнутые каталоги дерева и карточки диффа, недавние команды
 * палитры. Живёт в базе PR на сервере, а не в `localStorage`: сервер каждого PR слушает случайный
 * порт, и хранилище браузера у нового порта пустое.
 *
 * Смена применяется оптимистично, запись уезжает следом с задержкой до затишья — свёртка каталога это
 * серия кликов, и каждый не заслуживает своего запроса. Провал записи не откатывает выбор:
 * ревьюер уже видит свёрнутое дерево, дёрнуть его назад хуже, чем потерять персист.
 *
 * Ручка заменяет названное поле целиком, поэтому запрос собирается поверх серверного состояния:
 * пока boot-GET не ответил, записи придерживаются, а если он провалился — выключаются совсем.
 * Иначе первая же свёртка отправила бы карту, выросшую из умолчаний, и стёрла бы всё, что этот
 * PR помнил.
 */

export const DEFAULT_UI_PR_STATE: UiPrState = uiPrStateSchema.parse({});

/** Сколько недавних команд показывает палитра (лимит показа держит UI, сервер только хранит). */
export const PALETTE_RECENT_LIMIT = 5;

/** Пауза перед отправкой: серия кликов по дереву уезжает одним PATCH с последним значением. */
export const PR_STATE_SEND_DEBOUNCE_MS = 300;

/**
 * Поля состояния по одному. Схема патча для этого не годится: `.partial()` над схемой с дефолтами
 * подставляет дефолт вместо отсутствующего ключа, и «не трогай поле» превратилось бы в «сбрось».
 */
const PR_STATE_FIELDS = [
    'treeCollapsed',
    'diffCollapsed',
    'paletteRecent',
] as const satisfies readonly (keyof UiPrState)[];

export interface UiPrStateStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => UiPrState;
    /** Применяет названные поля сразу, отправку откладывает; поле с прежним значением не едет никуда. */
    readonly update: (patch: UiPrStatePatch) => void;
    /**
     * Boot-GET состояния: до его исхода записи придерживаются, потому что патч заменяет поле
     * целиком. Успех — серверное состояние ложится в снапшот и отпускает отложенные записи;
     * провал — состояние остаётся в памяти на умолчаниях, а запись выключается до перезагрузки.
     * Поля, которые ревьюер успел поменять руками, серверный ответ не перебивает (для карт — по
     * ключам: выбор ревьюера ложится поверх серверного, а не выбрасывает его).
     */
    readonly load: (fetchState: () => Promise<UiPrState>) => Promise<void>;
    /** Отправить неподтверждённое немедленно — вкладка уходит (`pagehide`) и второго шанса не будет. */
    readonly flush: () => void;
}

export interface UiPrStateStoreOptions {
    readonly initial?: Partial<UiPrState>;
    /** Транспорт записи; без него состояние живёт только в памяти (тесты, галерея). */
    readonly send?: (patch: UiPrStatePatch, options?: { readonly keepalive?: boolean }) => Promise<UiPrState>;
}

/** Стор без объявленного boot-GET пишет сразу: за ним либо нет сервера, либо нечего затирать. */
type LoadState = 'ready' | 'pending' | 'failed';

export function createUiPrStateStore(options: UiPrStateStoreOptions = {}): UiPrStateStore {
    const listeners = new Set<() => void>();
    const changedHere = new Set<keyof UiPrState>();
    /**
     * Поля, чьё текущее значение сервер ещё не подтвердил. Каждый запрос собирается из них по
     * снапшоту, а не из накопленного патча: провалившаяся и оборванная запись остаются здесь и
     * уезжают со следующей отправкой или с `flush()`.
     */
    const unconfirmed = new Set<keyof UiPrState>();
    let snapshot: UiPrState = { ...DEFAULT_UI_PR_STATE, ...options.initial };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Записи выстроены в цепочку: два PATCH подряд не должны примениться в обратном порядке.
    let queue: Promise<unknown> = Promise.resolve();
    // Растёт на flush: дожидающиеся своей очереди записи прошлой эпохи уже не нужны — flush
    // отправил их поля с актуальными значениями и обгонять его им незачем.
    let epoch = 0;
    let loadState: LoadState = 'ready';

    const notify = (): void => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    /** Применяет только те поля, что названы и отличаются; возвращает их же для отправки. */
    const applyLocally = (patch: UiPrStatePatch): UiPrStatePatch => {
        const changes: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            const value = patch[field];
            if (value !== undefined && !sameFieldValue(value, snapshot[field])) {
                Object.assign(changes, { [field]: value });
            }
        }
        if (Object.keys(changes).length === 0) {
            return changes;
        }
        // Снапшот всегда проходит схему: чужое значение в него не попадёт.
        snapshot = uiPrStateSchema.parse({ ...snapshot, ...changes });
        notify();
        return changes;
    };

    /** Запрос собирается из снапшота: в полёт уходит то, что ревьюер видит сейчас. */
    const unconfirmedPatch = (): UiPrStatePatch => {
        const patch: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            if (unconfirmed.has(field)) {
                Object.assign(patch, { [field]: snapshot[field] });
            }
        }
        return patch;
    };

    /** Поле подтверждено, только если с момента отправки оно не поменялось снова. */
    const confirm = (patch: UiPrStatePatch): void => {
        for (const field of PR_STATE_FIELDS) {
            const sent = patch[field];
            if (sent !== undefined && sameFieldValue(sent, snapshot[field])) {
                unconfirmed.delete(field);
            }
        }
    };

    const dispatch = (keepalive: boolean): void => {
        const transport = options.send;
        if (transport === undefined || loadState !== 'ready' || unconfirmed.size === 0) {
            return;
        }
        const patch = unconfirmedPatch();
        const fire = (): Promise<void> =>
            transport(patch, keepalive ? { keepalive: true } : {}).then(
                () => {
                    confirm(patch);
                },
                (error: unknown) => {
                    console.warn('UI state was not saved on the server:', error);
                },
            );
        if (keepalive) {
            // Вкладка уходит: запрос ставится прямо в обработчике события, мимо очереди. Дождись
            // он предыдущей записи — браузер успел бы разобрать страницу, и запроса бы не было.
            epoch += 1;
            void fire();
            return;
        }
        const sendEpoch = epoch;
        queue = queue.then(
            () => (sendEpoch === epoch ? fire() : undefined),
            () => undefined,
        );
    };

    /**
     * Серверное состояние старта. Поле, которое ревьюер уже трогал, оно не перебивает; но и
     * выбросить его для карт нельзя — иначе следующая запись, заменяющая поле целиком, стёрла бы
     * серверные ключи. Выбор ревьюера ложится поверх них.
     */
    const applyLoaded = (loaded: UiPrState): void => {
        const fresh: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            if (!changedHere.has(field)) {
                Object.assign(fresh, { [field]: loaded[field] });
                continue;
            }
            const merged = localOverLoaded(loaded[field], snapshot[field]);
            if (merged !== undefined) {
                Object.assign(fresh, { [field]: merged });
            }
        }
        applyLocally(fresh);
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,

        update: (patch) => {
            const changes = applyLocally(patch);
            for (const field of PR_STATE_FIELDS) {
                if (changes[field] !== undefined) {
                    changedHere.add(field);
                    unconfirmed.add(field);
                }
            }
            if (Object.keys(changes).length === 0) {
                return;
            }
            // Окно открывает первая смена: серия кликов уезжает одним запросом и не голодает,
            // пока ревьюер щёлкает по дереву.
            timer ??= setTimeout(() => {
                timer = null;
                dispatch(false);
            }, PR_STATE_SEND_DEBOUNCE_MS);
        },

        load: (fetchState) => {
            loadState = 'pending';
            return fetchState().then(
                (loaded) => {
                    applyLoaded(loaded);
                    loadState = 'ready';
                    // Смены, сделанные пока ответ был в пути, уезжают поверх серверного состояния.
                    dispatch(false);
                },
                (error: unknown) => {
                    loadState = 'failed';
                    unconfirmed.clear();
                    console.warn(
                        'UI state of this PR failed to load — falling back to defaults; writes are off until' +
                            ' reload: the request replaces the whole field and would wipe what is stored.',
                        error,
                    );
                },
            );
        },

        flush: () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            dispatch(true);
        },
    };
}

/** MRU-список недавних команд палитры: последняя впереди, дубликатов нет, длина под лимитом показа. */
export function addRecentCommand(recent: readonly string[], commandId: string): string[] {
    return [commandId, ...recent.filter((candidate) => candidate !== commandId)].slice(0, PALETTE_RECENT_LIMIT);
}

/** Карты свёрнутости в контракте — объекты, в сторе диффа и дереве — `Map`; конверсия на границе. */
export function collapsedToMap(collapsed: Readonly<Record<string, boolean>>): Map<string, boolean> {
    return new Map(Object.entries(collapsed));
}

export function collapsedFromMap(collapsed: ReadonlyMap<string, boolean>): Record<string, boolean> {
    return Object.fromEntries(collapsed);
}

/**
 * Слияние серверного значения с локальным для полей-карт: ключи ревьюера побеждают, остальные
 * серверные остаются. `undefined` — сливать нечего (список недавних команд MRU, у него порядок,
 * а не набор ключей): побеждает локальное целиком.
 */
function localOverLoaded(loaded: unknown, local: unknown): Record<string, unknown> | undefined {
    if (isPlainRecord(loaded) && isPlainRecord(local)) {
        return { ...loaded, ...local };
    }
    return undefined;
}

/** Поверхностное сравнение значений полей: карты свёрток и список команд — плоские структуры. */
function sameFieldValue(next: unknown, current: unknown): boolean {
    if (Array.isArray(next) && Array.isArray(current)) {
        return next.length === current.length && next.every((item, index) => item === current[index]);
    }
    if (isPlainRecord(next) && isPlainRecord(current)) {
        const keys = Object.keys(next);
        return (
            keys.length === Object.keys(current).length &&
            keys.every((key) => Object.hasOwn(current, key) && next[key] === current[key])
        );
    }
    return next === current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
