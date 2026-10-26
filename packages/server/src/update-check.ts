import fs from 'node:fs';

import type { DistributionVersion, UiUpdate, UiUpdateInstall } from '@sherpa/protocol';
import { distributionVersionSchema } from '@sherpa/protocol';

import { describeFetchError } from './errors.js';
import { ARCANUM_API_BASE } from './hosts/arcanum/client.js';
import type { TokenSource } from './hosts/arcanum/token.js';
import { resolveArcToken } from './hosts/arcanum/token.js';
import { updateCheckPathFor } from './paths.js';
import type { SettingsStore } from './settings-store.js';
import { SERVER_VERSION } from './version.js';

/**
 * Проверка новой версии в trunk. Только уведомление: Шерпа ничего
 * не скачивает и не ставит — говорит, что вышла версия, и подсказывает команду обновления.
 */

/** Путь дистрибутива в Аркадии: из него собираются и URL `version.json`, и хвост чекаута. */
export const DISTRIBUTION_PATH = 'junk/alice/sherpa';

/** Сколько кэш считается свежим: перезапуски серверов не должны долбить API. */
const CACHE_TTL_MS = 30 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5000;

/** Каталог бандла с таким хвостом — чекаут Аркадии, обновление в нём делается `arc pull`. */
const ARC_CHECKOUT_TAIL = `/${DISTRIBUTION_PATH}/skill`;

/** Версия-заглушка сборки вне релиза: сравнивать её с trunk бессмысленно. */
const DEV_VERSION = '0.0.0';

export interface UpdateCheckOptions {
    /** Realpath каталога дистрибутива из `--install-dir`; undefined — dev-запуск без дистрибутива. */
    readonly installDir?: string;
    /** Транспорт; по умолчанию глобальный fetch. */
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
    /** Файл кэша результата; по умолчанию `<sherpaDir>/update-check.json`. */
    readonly cacheFile?: string;
    /** Путь дистрибутива в trunk; по умолчанию `junk/alice/sherpa`. */
    readonly distributionPath?: string;
    /** Токен Арканума; по умолчанию обычная цепочка arc. Тестам нужен способ не звать `arc`. */
    readonly token?: TokenSource;
    /** Зашитая версия сервера; подменяется только в тестах — в них `SERVER_VERSION` нулевая. */
    readonly currentVersion?: string;
}

export interface UpdateCheckerOptions extends UpdateCheckOptions {
    /** Корень стейта: из него берётся путь кэша, когда `cacheFile` не задан. */
    readonly sherpaDir: string;
    /** Отклонённая версия читается в момент сборки снапшота — настройки живут на диске. */
    readonly settings: SettingsStore;
    /** `false` — проверка выключена вовсе (фикстурный хост): состояние подставляет дев-ручка. */
    readonly enabled?: boolean;
}

/**
 * Итог форсированной проверки: провал нельзя выдать за «обновлений нет» — палитра обязана
 * сказать «не удалось проверить», а не подтвердить актуальность версии.
 */
export interface UpdateForceResult {
    readonly update: UiUpdate | null;
    /** Человекочитаемая причина провала; null — проверка прошла (или была выключена). */
    readonly failure: string | null;
}

type LoadResult =
    | { readonly ok: true; readonly latest: DistributionVersion }
    | { readonly ok: false; readonly reason: string };

/** Содержимое файла кэша; `latest: null` — проверка была и провалилась. */
interface UpdateCheckCache {
    readonly checkedAt: string;
    readonly latest: DistributionVersion | null;
}

/**
 * Читает `skill/version.json` дистрибутива из trunk и держит результат для снапшота UI.
 * `get()` синхронна по той же причине, что и у `PrMetaCache`: снапшот собирается из таймера
 * и микрозадачи, сетевому вызову там места нет.
 *
 * Провал проверки — не поломка: одна строка в stderr, `update` остаётся null, старт сервера
 * не задерживается и не падает.
 */
export class UpdateChecker {
    private readonly settings: SettingsStore;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => Date;
    private readonly cacheFile: string;
    private readonly distributionPath: string;
    private readonly token: TokenSource;
    private readonly currentVersion: string;
    private readonly install: UiUpdateInstall;
    private readonly enabled: boolean;
    private readonly listeners = new Set<() => void>();
    /** Последняя известная версия дистрибутива в trunk; null — проверки не было или она провалилась. */
    private latest: DistributionVersion | null = null;
    private closed = false;
    /** Номер последней выданной проверки; растёт в порядке старта запросов. */
    private started = 0;
    /** Номер проверки, чей ответ сейчас в `latest`. */
    private applied = 0;

    constructor(options: UpdateCheckerOptions) {
        this.settings = options.settings;
        this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.now = options.now ?? (() => new Date());
        this.cacheFile = options.cacheFile ?? updateCheckPathFor(options.sherpaDir);
        this.distributionPath = options.distributionPath ?? DISTRIBUTION_PATH;
        this.token = options.token ?? (() => resolveArcToken());
        this.currentVersion = options.currentVersion ?? SERVER_VERSION;
        this.install = classifyInstall(options.installDir);
        this.enabled = options.enabled ?? true;
    }

    /** Синхронный источник для `buildState`. */
    get(): UiUpdate | null {
        const latest = this.latest;
        if (latest === null || compareVersions(latest.version, this.currentVersion) <= 0) {
            return null;
        }
        if (this.settings.read().updates.dismissedVersion === latest.version) {
            return null;
        }
        return {
            current: this.currentVersion,
            latest: latest.version,
            releasedAt: latest.releasedAt,
            whatsNew: latest.whatsNew,
            install: this.install,
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Первая проверка после `listen`: свежий кэш берётся с диска, протухший — поводом сходить
     * в trunk. Старт сервера её не ждёт.
     */
    start(): void {
        if (!this.checkable()) {
            return;
        }
        void this.check(false);
    }

    /**
     * Перепроверка по команде палитры: TTL игнорируется. Выключенная проверка (фикстура,
     * dev-сборка) отвечает тем, что уже есть, — сеть не трогает.
     */
    async force(): Promise<UpdateForceResult> {
        const failure = this.checkable() ? await this.check(true) : null;
        return { update: this.get(), failure };
    }

    /**
     * Дев-ручка: фикстурный сервер «узнаёт» о новой версии. Кэш на диске не трогается —
     * подставленная версия не должна пережить перезапуск.
     */
    setLatest(latest: DistributionVersion): UiUpdate | null {
        this.latest = latest;
        this.notify();
        return this.get();
    }

    /**
     * Настройки поменялись: `dismissedVersion` читается в `get()`, но подписчики снапшота
     * об этом не узнают — про смену настроек им говорит эта ручка.
     */
    settingsChanged(): void {
        this.notify();
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    /** Есть ли смысл ходить в сеть: фикстура и dev-сборка сравнивать себя с trunk не должны. */
    private checkable(): boolean {
        return this.enabled && !this.closed && this.currentVersion !== DEV_VERSION;
    }

    /** Возвращает причину провала или null; вызывающему это нужно только у `force()`. */
    private async check(force: boolean): Promise<string | null> {
        // Проверки завершаются не в том порядке, в каком стартовали: запрос из `start()` легко
        // доживает до ответа на форс из палитры и своим таймаутом затёр бы свежий результат.
        const generation = ++this.started;
        const cached = force ? null : this.readCache();
        if (cached !== null) {
            this.applied = generation;
            this.apply(cached.latest);
            return null;
        }

        const loaded = await this.load();
        const failure = loaded.ok ? null : loaded.reason;
        if (this.closed || generation < this.applied) {
            return failure;
        }
        this.applied = generation;
        if (this.apply(loaded.ok ? loaded.latest : null)) {
            this.writeCache({ checkedAt: this.now().toISOString(), latest: this.latest });
        }
        return failure;
    }

    /**
     * Кладёт результат проверки в состояние. Провал (`null`) не стирает уже известную версию:
     * неудачная перепроверка не должна убирать с экрана тост и точку в топбаре — и попадать
     * в кэш, из которого следующие полчаса читались бы перезапуски. `false` — писать нечего.
     */
    private apply(latest: DistributionVersion | null): boolean {
        if (latest === null && this.latest !== null) {
            return false;
        }
        this.latest = latest;
        this.notify();
        return true;
    }

    /** Причина провала уже в stderr; наружу она уходит только ответом на форс из палитры. */
    private async load(): Promise<LoadResult> {
        const url = `${ARCANUM_API_BASE}/tree/blob/trunk/arcadia/${this.distributionPath}/skill/version.json`;
        try {
            const token = await this.token();
            const response = await this.fetchImpl(url, {
                headers: { authorization: `OAuth ${token}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`ответ ${String(response.status)}`);
            }
            // Ручка `tree/blob` отдаёт сам файл, а не конверт `{data}` — `ArcanumClient` тут не подходит.
            return { ok: true, latest: distributionVersionSchema.parse(await response.json()) };
        } catch (error) {
            const reason = describeFetchError(error);
            process.stderr.write(`sherpa-server: проверка обновления не удалась: ${reason}\n`);
            return { ok: false, reason };
        }
    }

    /** `null` — кэша нет, он битый или протух: нужен запрос. */
    private readCache(): UpdateCheckCache | null {
        let raw: string;
        try {
            raw = fs.readFileSync(this.cacheFile, 'utf8');
        } catch {
            return null;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        const cache = parseCache(parsed);
        if (cache === null) {
            return null;
        }
        const checkedAt = Date.parse(cache.checkedAt);
        const age = this.now().getTime() - checkedAt;
        // Кэш из будущего (переведённые часы) считаем протухшим — иначе он залипнет навсегда.
        return age >= 0 && age < CACHE_TTL_MS ? cache : null;
    }

    /** Атомарная запись: файл общий для серверов всех PR, читателя нельзя застать на середине. */
    private writeCache(cache: UpdateCheckCache): void {
        const temp = `${this.cacheFile}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
        try {
            fs.writeFileSync(temp, `${JSON.stringify(cache, null, 4)}\n`, { mode: 0o600 });
            fs.chmodSync(temp, 0o600);
            fs.renameSync(temp, this.cacheFile);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            process.stderr.write(`sherpa-server: кэш проверки обновления не записался: ${describeFetchError(error)}\n`);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

/**
 * Откуда установлен дистрибутив. Хвост `/junk/alice/sherpa/skill` — чекаут Аркадии: обновление
 * в нём делается `arc pull` в корне маунта. Всё остальное — копия каталога, команды нет.
 */
export function classifyInstall(installDir?: string): UiUpdateInstall {
    if (installDir === undefined) {
        return { kind: 'copy', dir: process.cwd(), command: null };
    }

    const normalized = installDir.replaceAll('\\', '/').replace(/\/+$/u, '');
    if (normalized.endsWith(ARC_CHECKOUT_TAIL)) {
        const root = normalized.slice(0, normalized.length - ARC_CHECKOUT_TAIL.length);
        const dir = root === '' ? '/' : root;
        return { kind: 'arc-checkout', dir, command: `cd ${shellQuote(dir)} && arc pull` };
    }
    return { kind: 'copy', dir: installDir, command: null };
}

/** Команду копируют в терминал: путь с пробелом без кавычек развалился бы на два аргумента. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** `>0` — `a` новее `b`. Пре-релизов у нас не бывает, сравнения тройки чисел достаточно. */
export function compareVersions(a: string, b: string): number {
    const left = parseTriple(a);
    const right = parseTriple(b);
    for (let index = 0; index < 3; index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

function parseTriple(version: string): readonly number[] {
    return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function parseCache(payload: unknown): UpdateCheckCache | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const { checkedAt, latest } = payload as { checkedAt?: unknown; latest?: unknown };
    if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) {
        return null;
    }
    if (latest === null) {
        return { checkedAt, latest: null };
    }
    const parsed = distributionVersionSchema.safeParse(latest);
    return parsed.success ? { checkedAt, latest: parsed.data } : null;
}

