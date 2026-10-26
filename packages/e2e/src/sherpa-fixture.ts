import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';
import { FakeWorker } from '@sherpa/cli/fake-worker';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'packages/server');
const UI_DIST = path.join(REPO_ROOT, 'packages/ui/dist');
/** Бандл CLI собирается в `global-setup`: fake-воркер ходит тем же артефактом, что и прод. */
const CLI_BUNDLE = path.join(REPO_ROOT, 'packages/cli/dist/devflow-diff-explain.mjs');
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

type FixturePrKey = 'fixture-medium' | 'fixture-large' | 'fixture-huge' | 'fixture-empty';

export interface SherpaServerHandle {
    readonly prKey: FixturePrKey;
    readonly sherpaDir: string;
    readonly url: string;
    /** Сессия-агент этого сервера: те же шелл-команды, что зовёт модель в харнесе. */
    readonly worker: FakeWorker;
    readonly stop: () => Promise<void>;
}

export interface LaunchOptions {
    /**
     * Общий корень стейта для нескольких серверов: им проверяется, что глобальные настройки
     * одни на все PR. Каталог создаёт и удаляет тест — фикстура его не трогает.
     */
    readonly sherpaDir?: string;
    /** Каталог дистрибутива (`--install-dir`): от него зависит команда обновления в тосте. */
    readonly installDir?: string;
    /**
     * Тур первого захода стартует у пользователя, который его ещё не проходил, — то есть
     * в любом чистом корне стейта. Спекам про всё остальное он мешал бы, поэтому по умолчанию
     * фикстура помечает тур пройденным; `'pending'` оставляет чистый корень как есть.
     */
    readonly onboarding?: 'done' | 'pending';
}

type LaunchSherpa = (prKey: FixturePrKey, options?: LaunchOptions) => Promise<SherpaServerHandle>;

interface SherpaFixtures {
    readonly launchSherpa: LaunchSherpa;
}

/** Playwright fixture: каждый сервер получает отдельный временный корень и штатный SIGTERM teardown. */
export const test = base.extend<SherpaFixtures>({
    launchSherpa: async ({ browserName: _browserName }, use) => {
        const handles: SherpaServerHandle[] = [];
        await use(async (prKey, options) => {
            const handle = await startSherpaServer(prKey, options);
            handles.push(handle);
            return handle;
        });
        for (const handle of handles.reverse()) {
            await handle.stop();
        }
    },
});

export { expect };

/** Bearer-токен сервера: он лежит во фрагменте ссылки, которую печатает `devflow-diff-explain up`. */
export function sherpaToken(server: SherpaServerHandle): string {
    const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('t');
    if (token === null || token === '') {
        throw new Error(`во фрагменте ${server.url} нет токена`);
    }
    return token;
}

/** Заголовки для прямого обращения к ручкам сервера мимо UI — тем же токеном, что и UI. */
export function sherpaAuth(server: SherpaServerHandle): Record<string, string> {
    return { Authorization: `Bearer ${sherpaToken(server)}` };
}

/**
 * Дев-ручка `POST /api/dev/fixture/advance-iteration` (`UI_DEV_ENDPOINTS`): фикстурный PR
 * «получает пуш» — следующая объявленная итерация становится активной. Вкладку не трогает:
 * новость о смене итерации приезжает в неё по SSE.
 */
export async function advanceIteration(page: Page, server: SherpaServerHandle): Promise<void> {
    const url = new URL('/api/dev/fixture/advance-iteration', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
}

/**
 * Дев-ручка `POST /api/dev/update-available` (`UI_DEV_ENDPOINTS`): фикстурный сервер «узнаёт»
 * о новой версии в trunk. В сеть при этом никто не ходит — проверка на фикстуре выключена.
 */
export async function announceUpdate(
    page: Page,
    server: SherpaServerHandle,
    update: { version: string; whatsNew: string | null; releasedAt: string | null },
): Promise<void> {
    const url = new URL('/api/dev/update-available', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server), data: update });
    expect(response.status(), await response.text()).toBe(200);
}

/** Параметр фрагмента адреса: выбор итерации и фильтры UI держит именно там. */
export function fragmentParam(page: Page, key: string): Promise<string | null> {
    return page.evaluate((name) => new URLSearchParams(location.hash.slice(1)).get(name), key);
}

/** Файл диффа глазами теста: полный ответ ручки описан контрактом, тестам хватает пары полей. */
export interface DiffFileSummary {
    readonly fileId: string;
    readonly path: string;
}

/**
 * Дифф итерации мимо UI. Без `diffId` — активная итерация; с ним — сохранённый патч названной
 * (после force-push только он и остаётся: у хоста этой итерации больше нет).
 */
export async function diffOf(
    page: Page,
    server: SherpaServerHandle,
    diffId?: string,
): Promise<readonly DiffFileSummary[]> {
    const url = new URL('/api/ui/review/diff', server.url);
    if (diffId !== undefined) {
        url.searchParams.set('diffId', diffId);
    }
    const response = await page.request.get(url.href, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as {
        readonly diff: { readonly files: readonly DiffFileSummary[] };
    };
    return body.diff.files;
}

/** Прочитанный кусок файла: сторона и границы строк — тем же словарём, что и контракт. */
export interface SeenRange {
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

export interface FileProgress {
    readonly fileId: string;
    readonly viewed: boolean | null;
    readonly seenRanges: readonly SeenRange[];
}

export interface ReviewProgress {
    readonly files: readonly FileProgress[];
    /** Отметки остановок последнего снапшота этой итерации; их нет — снапшота на ней не строили. */
    readonly stops: readonly { readonly stopId: string; readonly viewed: boolean }[];
}

/** Прогресс чтения итерации мимо UI; без `diffId` — активной. */
export async function progressOf(
    page: Page,
    server: SherpaServerHandle,
    diffId?: string,
): Promise<ReviewProgress> {
    const url = new URL('/api/ui/review/progress', server.url);
    if (diffId !== undefined) {
        url.searchParams.set('diffId', diffId);
    }
    const response = await page.request.get(url.href, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as ReviewProgress;
}

/**
 * Прочитанные куски итерации в путях файлов: `fileId` у каждой итерации свой, и сравнивать
 * прогресс разных итераций можно только так.
 */
export async function seenRangeKeys(
    page: Page,
    server: SherpaServerHandle,
    diffId: string,
): Promise<string[]> {
    const paths = new Map((await diffOf(page, server, diffId)).map((file) => [file.fileId, file.path]));
    return (await progressOf(page, server, diffId)).files
        .flatMap((file) =>
            file.seenRanges.map(
                (range) =>
                    `${paths.get(file.fileId) ?? file.fileId}:${range.side}:${String(range.start)}-${String(range.end)}`,
            ),
        )
        .sort();
}

async function startSherpaServer(prKey: FixturePrKey, options?: LaunchOptions): Promise<SherpaServerHandle> {
    const ownsSherpaDir = options?.sherpaDir === undefined;
    const sherpaDir = options?.sherpaDir ?? (await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-')));
    if (options?.onboarding !== 'pending') {
        await seedOnboardingDone(sherpaDir);
    }
    const workDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-work-'));
    // Сервер — прямой ребёнок фикстуры, без обёрток pnpm/tsx: иначе SIGTERM при остановке
    // достаётся обёртке, а node сервера переживает её и держит PR занятым.
    const child = spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            'src/dev.ts',
            '--pr',
            prKey,
            '--sherpa-dir',
            sherpaDir,
            '--ui',
            UI_DIST,
            ...(options?.installDir === undefined ? [] : ['--install-dir', options.installDir]),
        ],
        {
            cwd: SERVER_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    );

    try {
        const url = await readUiUrl(child);
        let stopped = false;
        return {
            prKey,
            sherpaDir,
            url,
            worker: new FakeWorker({ bundlePath: CLI_BUNDLE, sherpaDir, prKey, workDir }),
            stop: async () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    await stopChild(child);
                } finally {
                    if (ownsSherpaDir) {
                        await rm(sherpaDir, { recursive: true, force: true });
                    }
                    await rm(workDir, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        await stopChild(child).catch(() => undefined);
        if (ownsSherpaDir) {
            await rm(sherpaDir, { recursive: true, force: true });
        }
        await rm(workDir, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Помечает тур пройденным в `<sherpaDir>/settings.json`. Файл уже есть — не трогаем: это второй
 * сервер того же «пользователя», и его настройки писал первый.
 */
async function seedOnboardingDone(sherpaDir: string): Promise<void> {
    const settings = { onboarding: { completedAt: '2026-01-01T00:00:00.000Z', step: 0 } };
    try {
        await writeFile(path.join(sherpaDir, 'settings.json'), `${JSON.stringify(settings, null, 4)}\n`, {
            flag: 'wx',
            mode: 0o600,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

function readUiUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            fail(`Сервер не напечатал UI URL за ${String(START_TIMEOUT_MS)} мс`);
        }, START_TIMEOUT_MS);

        const cleanup = (): void => {
            clearTimeout(timer);
            child.stdout.off('data', onStdout);
            child.stderr.off('data', onStderr);
            child.off('error', onError);
            child.off('exit', onExit);
        };
        const succeed = (url: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(url);
        };
        const fail = (message: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        };
        const onStdout = (chunk: Buffer): void => {
            stdout += chunk.toString('utf8');
            const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/#t=[^\s]+)/.exec(stdout);
            if (match?.[1] !== undefined) {
                succeed(match[1]);
            }
        };
        const onStderr = (chunk: Buffer): void => {
            stderr += chunk.toString('utf8');
        };
        const onError = (error: Error): void => {
            fail(`Не удалось запустить сервер: ${error.message}`);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
            fail(`Сервер завершился до готовности: code=${String(code)} signal=${String(signal)}`);
        };

        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.once('error', onError);
        child.once('exit', onExit);
    });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Сервер не завершился за ${String(STOP_TIMEOUT_MS)} мс после SIGTERM`));
        }, STOP_TIMEOUT_MS);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
