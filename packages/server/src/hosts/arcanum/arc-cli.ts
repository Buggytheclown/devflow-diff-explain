import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

import { z } from 'zod';

import { RpcFailure } from '../../errors.js';

/**
 * Чтение содержимого репозитория локальным `arc`: дифф между коммитами и байты блобов.
 *
 * Зачем не Арканум: его тяжёлые ручки (`…/patch`, `text-diff`, `/repos/content/file`) не держат
 * нагрузку, а те же данные лежат в общем object-store `arc` и адресуются хэшами из changelist —
 * они не зависят ни от ветки, ни от рабочего дерева чекаута. Так же устроен плагин VS Code:
 * метаданные из Арканума, байты через `arc show`.
 *
 * Репозиторий (тенант Арканума — `arcadia`, `cloudia`) называет вызывающий: у каждого свой
 * object-store, объекты Cloudia в чекауте Аркадии недоступны. Поэтому чекаут ищется и
 * мемоизируется на каждый тенант отдельно.
 *
 * Опорные факты (сняты живьём 2026-09-12):
 * - `arc diff --git <base> <head> -- <пути…>` печатает git-совместимый патч только по названным
 *   путям; без путей вызов по всему дереву может висеть — поэтому пути обязательны всегда;
 * - пути в аргументах считаются от каталога запуска, а не от корня репозитория: путь из чужого
 *   каталога молча даёт пустой вывод — отсюда cwd, равный корню маунта;
 * - заголовок куска приходит **без кавычек** даже с пробелом в пути (`diff --git a/a b.md b/a b.md`),
 *   строки `index` нет вовсе;
 * - `--resolve-moves true` в этой версии `arc` ломает вывод (весь запрошенный подкаталог
 *   показывается удалённым), поэтому не используется: дельту переименований берём как есть;
 * - `arc show <blob>` и `arc show <commit>:<path>` печатают сырые байты; неизвестный хэш — код ≠ 0
 *   и `Error:  NoSuchObject: Can't load object with id …`;
 * - `arc root` печатает корень маунта, внутри которого запущен, и падает с кодом 1 вне маунта;
 * - `arc mount --list --json` работает из любого каталога, JSON в stdout, отладка в stderr;
 *   в актуальном `arc` у записи есть `tenant`, в прежнем формате поля нет вовсе;
 * - `arc info --json` называет репозиторий маунта полем `repository`.
 */

const ARC_BIN = 'arc';

/** Потолок одного вызова: `arc diff` на десятке файлов укладывается в доли секунды. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Потолок вывода: патч одного крупного файла — сотни килобайт, но бывают и генерённые гиганты. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Сколько процессов `arc` крутится одновременно: 75 файлов пофайлово — 1.3 с при таком пуле. */
const DEFAULT_CONCURRENCY = 12;

/** Путей в одном `arc diff`: батч режется обратно по заголовкам `diff --git`. */
const PATHS_PER_DIFF = 24;

/** Сколько символов чужого stderr попадает в текст ошибки. */
const DETAIL_MAX_CHARS = 160;

/** Почему у команды нет кода возврата. */
export type ArcFailure = 'not-found' | 'timeout' | 'failed';

export interface ArcCommand {
    readonly args: readonly string[];
    /** Каталог запуска: `arc show` и `arc diff` работают только внутри смонтированного чекаута. */
    readonly cwd: string;
}

export interface ArcOutcome {
    readonly exitCode: number | null;
    /** Сырые байты stdout: у `arc show` это содержимое файла, в том числе двоичное. */
    readonly stdout: Uint8Array;
    readonly stderr: string;
    readonly failure: ArcFailure | null;
}

/** Исполнитель команд `arc`: инъекция ради тестов — живой `arc` в них не зовётся. */
export type ArcRunner = (command: ArcCommand) => Promise<ArcOutcome>;

export interface ArcCliOptions {
    readonly runner?: ArcRunner;
    /** Откуда начинается поиск чекаута; по умолчанию — каталог запуска сервера. */
    readonly cwd?: string;
    readonly concurrency?: number;
    /** Куда уходит строка про выбранный чекаут; по умолчанию — `server.log` через stderr. */
    readonly log?: (line: string) => void;
}

/**
 * Запись `arc mount --list --json`; `status` протухает — «mounted» бывает и у умершего демона.
 * `tenant` появился не во всех версиях `arc`: без него репозиторий маунта узнаётся из `arc info`.
 */
const mountsSchema = z.array(
    z.object({
        status: z.string().optional(),
        mount: z.string().min(1),
        tenant: z.string().optional(),
    }),
);

type ArcMount = z.infer<typeof mountsSchema>[number];

/** `arc info --json`: нужен только репозиторий маунта. */
const infoSchema = z.object({ repository: z.string().min(1) });

export class ArcCli {
    private readonly runner: ArcRunner;
    private readonly pool: Pool;
    private readonly log: (line: string) => void;
    private readonly cwd: string;
    /**
     * Мемоизация поиска чекаута по тенанту; неудача не запоминается — маунт могли поднять
     * после старта.
     */
    private readonly checkouts = new Map<string, Promise<string>>();

    constructor(options: ArcCliOptions = {}) {
        this.runner = options.runner ?? runArcCommand;
        this.pool = new Pool(options.concurrency ?? DEFAULT_CONCURRENCY);
        this.cwd = options.cwd ?? process.cwd();
        this.log =
            options.log ??
            ((line): void => {
                process.stderr.write(`${line}\n`);
            });
    }

    /**
     * Патч между двумя коммитами по названным путям, одним текстом. Пути режутся на батчи и
     * считаются параллельно; куски склеиваются в том же порядке — разбирать их всё равно
     * `splitPatchByFile`.
     */
    async diff(
        tenant: string,
        base: string,
        head: string,
        paths: readonly string[],
    ): Promise<string> {
        if (paths.length === 0) {
            return '';
        }

        const root = await this.root(tenant);
        const batches = chunked(paths, PATHS_PER_DIFF);
        const parts = await Promise.all(
            batches.map(async (batch) => {
                const stdout = await this.run(
                    ['diff', '--git', base, head, '--', ...batch],
                    root,
                    `показать дифф ${base}…${head}`,
                );
                return decodeText(stdout);
            }),
        );
        return parts.join('');
    }

    /** Содержимое блоба текстом; `id` — хэш блоба или `<commit>:<path>`. */
    async showText(tenant: string, id: string): Promise<string> {
        return decodeText(await this.show(tenant, id));
    }

    /** Содержимое блоба байтами: картинку в текст превращать нельзя. */
    async showBytes(tenant: string, id: string): Promise<Uint8Array> {
        return this.show(tenant, id);
    }

    private async show(tenant: string, id: string): Promise<Uint8Array> {
        const root = await this.root(tenant);
        return this.run(['show', id], root, `прочитать объект ${id}`);
    }

    /** Корень живого чекаута этого репозитория; ищется один раз на тенант. */
    private root(tenant: string): Promise<string> {
        const cached = this.checkouts.get(tenant);
        if (cached !== undefined) {
            return cached;
        }

        const pending = this.findCheckout(tenant).catch((error: unknown) => {
            // Неудачу не мемоизируем: чекаут могли смонтировать уже после первой попытки.
            this.checkouts.delete(tenant);
            throw error;
        });
        this.checkouts.set(tenant, pending);
        return pending;
    }

    /**
     * Поиск чекаута без флагов и переменных окружения: сначала тот, внутри которого запущен сервер,
     * потом любой живой из списка маунтов. Первый шаг не зависит от второго: список маунтов может
     * не отвечать или не знать про наш чекаут, а сам чекаут при этом рабочий. Годится только
     * чекаут нужного репозитория: у Аркадии и Cloudia разные object-store.
     */
    private async findCheckout(tenant: string): Promise<string> {
        const own = await this.ownCheckout(tenant);
        if (own !== null) {
            return this.chosen(own, tenant);
        }

        const mounts = await this.listMounts();
        // Запись с чужим тенантом отсеивается по списку; запись без поля (прежний формат `arc`)
        // проверяется вызовом `arc info` — иначе Cloudia не нашлась бы вовсе.
        const candidates = orderedCandidates(
            mounts.filter((mount) => mount.tenant === undefined || mount.tenant === tenant),
            this.cwd,
        );

        let unreachable = false;
        for (const candidate of candidates) {
            // Статус `mounted` протухает (демон умер, запись осталась), поэтому каждый кандидат
            // проверяется вызовом `arc info --json` в нём — он же называет репозиторий маунта.
            const repository = await this.repositoryOf(candidate);
            if (repository === tenant) {
                return this.chosen(candidate, tenant);
            }
            unreachable ||= repository === null;
        }

        throw new RpcFailure('host_unavailable', missingCheckoutMessage(tenant, mounts, unreachable));
    }

    /**
     * Чекаут, внутри которого запущен сервер: `arc root` из каталога запуска даёт его корень
     * (корень нужен целиком — пути в `arc diff` считаются от каталога запуска команды). Годится
     * он, только если это чекаут нужного репозитория.
     *
     * Любой отказ здесь — не повод останавливаться: каталог запуска мог быть удалён вместе с
     * ворктри, а демон Шерпы живёт дальше. Поэтому дальше просто идёт список маунтов.
     */
    private async ownCheckout(tenant: string): Promise<string | null> {
        const outcome = await this.pool
            .run(() => this.runner({ args: ['root'], cwd: this.cwd }))
            .catch(() => null);
        if (outcome?.failure !== null || outcome.exitCode !== 0) {
            return null;
        }

        const root = decodeText(outcome.stdout).trim();
        if (root === '') {
            return null;
        }
        return (await this.repositoryOf(root)) === tenant ? root : null;
    }

    private async listMounts(): Promise<ArcMount[]> {
        // Каталог запуска сервера сюда не годится: его могли удалить (снятый ворктри), и тогда
        // сам запуск процесса падает с ENOENT — не отличить от «arc нет в PATH». Список маунтов
        // от каталога не зависит, так что зовём его из заведомо живого.
        const outcome = await this.pool.run(() =>
            this.runner({ args: ['mount', '--list', '--json'], cwd: stableCwd() }),
        );
        if (outcome.failure !== null || outcome.exitCode !== 0) {
            throw new RpcFailure(
                'host_unavailable',
                failureMessage('перечислить чекауты arc', null, outcome),
            );
        }

        const parsed = mountsSchema.safeParse(parseJson(decodeText(outcome.stdout)));
        if (!parsed.success) {
            throw new RpcFailure(
                'host_unavailable',
                'Шерпа не разобрала вывод `arc mount --list --json` — список чекаутов неизвестен.',
            );
        }
        return parsed.data.filter((mount) => mount.status === 'mounted');
    }

    private chosen(root: string, tenant: string): string {
        this.log(
            `sherpa-server: дифф и содержимое файлов репозитория ${tenant} читаем из чекаута arc ${root}`,
        );
        return root;
    }

    /**
     * Репозиторий живого маунта: `arc info --json` в нём. `null` — маунт не ответил или ответил
     * не той формой, то есть как чекаут он не годится (статус из списка бывает протухшим).
     */
    private async repositoryOf(root: string): Promise<string | null> {
        const outcome = await this.pool
            .run(() => this.runner({ args: ['info', '--json'], cwd: root }))
            .catch(() => null);
        if (outcome?.failure !== null || outcome.exitCode !== 0) {
            return null;
        }

        const parsed = infoSchema.safeParse(parseJson(decodeText(outcome.stdout)));
        return parsed.success ? parsed.data.repository : null;
    }

    private async run(args: readonly string[], cwd: string, what: string): Promise<Uint8Array> {
        const outcome = await this.pool.run(() => this.runner({ args, cwd }));
        if (outcome.failure !== null || outcome.exitCode !== 0) {
            throw new RpcFailure('host_unavailable', failureMessage(what, cwd, outcome));
        }
        return outcome.stdout;
    }
}

/** Ограничитель одновременных процессов: без него дифф большого PR поднимает сотню `arc`. */
class Pool {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => {
                this.waiting.push(resolve);
            });
        }
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            this.waiting.shift()?.();
        }
    }
}

/** Каталог для вызовов, которые от репозитория не зависят: он переживает снятие ворктри. */
function stableCwd(): string {
    const home = homedir();
    return home === '' ? '/' : home;
}

/**
 * Порядок кандидатов: чекаут, внутри которого запущен сервер, идёт первым — он заведомо тот,
 * с которым работает ревьюер. Обычно его находит `arc root` ещё до списка; здесь тот же выбор
 * остаётся верным, когда `root` не ответил. Остальные живые маунты того же репозитория держат
 * общий object-store, и по хэшам коммитов PR читаются из любого из них.
 */
function orderedCandidates(mounts: readonly ArcMount[], cwd: string): string[] {
    const roots = mounts.map((mount) => mount.mount);
    const own = roots.filter((mount) => mount === cwd || cwd.startsWith(`${mount}/`));
    return [...own, ...roots.filter((mount) => !own.includes(mount))];
}

/** Как репозиторий зовут в тексте для ревьюера: тенанты Арканума нам известны поимённо. */
function repositoryTitle(tenant: string): string {
    switch (tenant) {
        case 'arcadia':
            return 'Аркадии';
        case 'cloudia':
            return 'Cloudia';
        default:
            return tenant;
    }
}

/** Команда, которой этот чекаут монтируют: у Аркадии репозиторий по умолчанию. */
function mountCommand(tenant: string): string {
    return tenant === 'arcadia' ? 'arc mount <путь>' : `arc mount -r ${tenant} <путь>`;
}

/**
 * Почему чекаут не нашёлся: маунтов нет вовсе, есть, но чужого репозитория, или нужные есть,
 * да не отвечают. Ревьюеру нужны репозиторий и команда — угадывать их он не обязан.
 */
function missingCheckoutMessage(
    tenant: string,
    mounts: readonly ArcMount[],
    unreachable: boolean,
): string {
    const need = `Шерпе нужен смонтированный чекаут ${repositoryTitle(tenant)} (\`${mountCommand(tenant)}\`)`;
    if (mounts.length === 0) {
        return `${need}: \`arc mount --list\` не показал ни одного.`;
    }
    if (unreachable) {
        return `${need}: ни один подходящий маунт arc не отвечает — перемонтируйте его.`;
    }
    return `${need}: среди маунтов arc его нет.`;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        batches.push(items.slice(index, index + size));
    }
    return batches;
}

function decodeText(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Текст отказа для ревьюера: что именно не вышло, в каком чекауте и что с этим делать.
 * `NoSuchObject` — единственный случай, у которого есть внятный рецепт: коммита PR нет локально.
 */
function failureMessage(what: string, cwd: string | null, outcome: ArcOutcome): string {
    const where = cwd === null ? '' : ` (чекаут ${cwd})`;
    switch (outcome.failure) {
        case 'not-found':
            return 'arc не найден в PATH: дифф и содержимое файлов Шерпа читает локальным arc.';
        case 'timeout':
            return `arc не успел ${what} за ${String(Math.round(COMMAND_TIMEOUT_MS / 1000))} с${where}.`;
        case 'failed':
        case null:
            break;
    }

    const detail = detailOf(outcome.stderr);
    if (detail.includes('NoSuchObject')) {
        return (
            `В чекауте arc нет объекта, который просит Арканум${where}: ${detail}. ` +
            'Подтяните коммиты PR — `arc pull`.'
        );
    }
    return `arc не смог ${what}${where}${detail === '' ? '.' : `: ${detail}`}`;
}

/** Первая содержательная строка чужого stderr — она объясняет отказ точнее наших догадок. */
function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        // Отладочные строки `arc` в stderr есть всегда; причина отказа — не они.
        .find((candidate) => candidate !== '' && !candidate.includes('[DEBUG]'));
    if (line === undefined) {
        return '';
    }
    return line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS)}…` : line;
}

/**
 * Живой исполнитель. stdout читается байтами: `arc show` отдаёт и картинки; stderr — текстом,
 * он идёт только в сообщение об ошибке.
 */
export const runArcCommand: ArcRunner = async (command) =>
    new Promise<ArcOutcome>((resolve) => {
        execFile(
            ARC_BIN,
            [...command.args],
            {
                cwd: command.cwd,
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'buffer',
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                const text = stderr.toString('utf8');
                resolve(
                    error === null
                        ? { exitCode: 0, stdout, stderr: text, failure: null }
                        : { ...outcomeOfError(error), stdout, stderr: text },
                );
            },
        );
    });

/** Разбор ошибки execFile: код возврата, отсутствие бинаря, таймаут и всё остальное. */
function outcomeOfError(error: Error): Pick<ArcOutcome, 'exitCode' | 'failure'> {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'number') {
        return { exitCode: code, failure: null };
    }
    if (code === 'ENOENT') {
        return { exitCode: null, failure: 'not-found' };
    }
    // Переполнение maxBuffer тоже прибивает процесс, но таймаутом это называть нельзя.
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { exitCode: null, failure: 'failed' };
    }
    return { exitCode: null, failure: 'killed' in error && error.killed === true ? 'timeout' : 'failed' };
}
