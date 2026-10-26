import fs from 'node:fs';
import path from 'node:path';

import type { DistributionVersion, UiUpdate } from '@sherpa/protocol';
import { rpcErrorSchema, UI_DEV_ENDPOINTS, UI_ENDPOINTS, uiUpdateCheckResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { SettingsStore } from './settings-store.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';
import type { UpdateCheckOptions, UpdateCheckerOptions } from './update-check.js';
import { classifyInstall, UpdateChecker } from './update-check.js';

/**
 * Проверка новой версии в trunk. Сеть в тестах запрещена (docs/testing.md):
 * транспорт, часы, токен и файл кэша инжектируются.
 */

const CURRENT = '0.4.0';
const NOW = new Date('2026-09-03T12:00:00.000Z');

const LATEST: DistributionVersion = {
    version: '0.5.0',
    builtFrom: 'a71d4e2',
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: 'Тост обновления и читшит.',
};

describe('проверка версии в trunk', () => {
    let sherpaDir: string;
    let cacheFile: string;
    /** Строки, которые проверка написала в stderr: провал обязан стоить ровно одной. */
    let lines: string[];
    let restoreStderr: () => void;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        cacheFile = path.join(sherpaDir, 'update-check.json');
        lines = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        });
        restoreStderr = () => {
            spy.mockRestore();
        };
    });

    afterEach(async () => {
        restoreStderr();
        await removeTempSherpaDir(sherpaDir);
    });

    /** Ответ ручки `tree/blob`: сырой JSON файла, без конверта `{data}`. */
    function respondWith(payload: unknown, status = 200) {
        return vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status })));
    }

    function makeChecker(overrides: Partial<UpdateCheckerOptions> = {}): UpdateChecker {
        return new UpdateChecker({
            sherpaDir,
            settings: new SettingsStore(sherpaDir),
            currentVersion: CURRENT,
            cacheFile,
            now: () => NOW,
            token: () => Promise.resolve('token'),
            fetch: respondWith(LATEST),
            ...overrides,
        });
    }

    describe('сравнение версий', () => {
        it('версия выше текущей приезжает в состояние целиком', async () => {
            const checker = makeChecker({ installDir: '/opt/sherpa/skill' });

            await checker.force();

            expect(checker.get()).toEqual({
                current: CURRENT,
                latest: '0.5.0',
                releasedAt: LATEST.releasedAt,
                whatsNew: LATEST.whatsNew,
                install: { kind: 'copy', dir: '/opt/sherpa/skill', command: null },
            });
        });

        it('версия ниже текущей — не обновление', async () => {
            const checker = makeChecker({ fetch: respondWith({ ...LATEST, version: '0.3.9' }) });

            expect(await forced(checker)).toBeNull();
        });

        it('та же версия — не обновление', async () => {
            const checker = makeChecker({ fetch: respondWith({ ...LATEST, version: CURRENT }) });

            expect(await forced(checker)).toBeNull();
        });

        it('минор сравнивается числом, а не строкой', async () => {
            const checker = makeChecker({
                currentVersion: '0.9.0',
                fetch: respondWith({ ...LATEST, version: '0.10.0' }),
            });

            expect((await forced(checker))?.latest).toBe('0.10.0');
        });
    });

    describe('провалы проверки', () => {
        it('401 гасится строкой в stderr', async () => {
            const checker = makeChecker({ fetch: respondWith({ error: 'no' }, 401) });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
            expect(stderrLines()[0]).toContain('401');
        });

        it('таймаут запроса гасится так же', async () => {
            const timedOut = vi.fn(() =>
                Promise.reject(new DOMException('The operation was aborted.', 'TimeoutError')),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: timedOut });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('битый JSON гасится так же', async () => {
            const broken = vi.fn(() =>
                Promise.resolve(new Response('{ не json', { status: 200 })),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: broken });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('ответ не по схеме гасится так же', async () => {
            const checker = makeChecker({ fetch: respondWith({ version: 'позавчерашняя' }) });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('провалившаяся перепроверка не стирает уже известную версию', async () => {
            const transport = vi
                .fn()
                .mockResolvedValueOnce(new Response(JSON.stringify(LATEST)))
                .mockResolvedValueOnce(new Response('{}', { status: 401 })) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: transport });
            await checker.force();

            const second = await checker.force();

            expect(second.failure).toContain('401');
            expect(second.update?.latest).toBe('0.5.0');
            // Провал не должен ещё и залечь в кэш: иначе полчаса молчали бы и перезапуски.
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('без токена в сеть не ходим', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({
                token: () => Promise.reject(new Error('токена arc нет')),
                fetch: transport,
            });

            expect(await forced(checker)).toBeNull();
            expect(transport).not.toHaveBeenCalled();
            expect(stderrLines()).toHaveLength(1);
        });
    });

    describe('кэш', () => {
        it('свежий кэш берётся с диска, в сеть не ходим', async () => {
            writeCache({ checkedAt: '2026-09-03T11:45:00.000Z', latest: LATEST });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await Promise.resolve();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(transport).not.toHaveBeenCalled();
        });

        it('протухший кэш — повод сходить в trunk', async () => {
            writeCache({ checkedAt: '2026-09-03T11:00:00.000Z', latest: null });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            // Именно `start()`, а не `force()`: форс игнорирует TTL всегда и протухание не проверяет.
            checker.start();
            await vi.waitFor(() => {
                expect(checker.get()?.latest).toBe('0.5.0');
            });

            expect(transport).toHaveBeenCalledTimes(1);
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('битый кэш равносилен отсутствующему', async () => {
            fs.writeFileSync(cacheFile, '{ обрывок');
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await Promise.resolve();
            await Promise.resolve();

            expect(transport).toHaveBeenCalledTimes(1);
        });

        it('форс игнорирует свежий кэш', async () => {
            writeCache({ checkedAt: NOW.toISOString(), latest: null });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            expect((await forced(checker))?.latest).toBe('0.5.0');
            expect(transport).toHaveBeenCalledTimes(1);
        });

        it('dev-сборка 0.0.0 не проверяется вовсе', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({ currentVersion: '0.0.0', fetch: transport });

            checker.start();
            expect(await forced(checker)).toBeNull();
            expect(transport).not.toHaveBeenCalled();
        });

        it('выключенная проверка (фикстурный хост) в сеть не ходит', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({ enabled: false, fetch: transport });

            checker.start();
            await checker.force();

            expect(transport).not.toHaveBeenCalled();
        });
    });

    describe('параллельные проверки', () => {
        it('опоздавший ответ не затирает результат более свежей проверки', async () => {
            const pending: ((payload: unknown) => void)[] = [];
            const transport = vi.fn(
                () =>
                    new Promise((resolve) => {
                        pending.push((payload) => {
                            resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
                        });
                    }),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await vi.waitFor(() => {
                expect(pending).toHaveLength(1);
            });
            const forcing = checker.force();
            await vi.waitFor(() => {
                expect(pending).toHaveLength(2);
            });
            pending[1]?.(LATEST);
            expect((await forcing).update?.latest).toBe('0.5.0');
            // Запрос из `start()` отвечает последним и версией постарше.
            pending[0]?.({ ...LATEST, version: '0.4.5' });
            await flush();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });
    });

    describe('отклонённая версия', () => {
        it('«не напоминать про эту» прячет обновление', async () => {
            const settings = new SettingsStore(sherpaDir);
            const checker = makeChecker({ settings });
            await checker.force();

            settings.patch({ updates: { dismissedVersion: '0.5.0' } });

            expect(checker.get()).toBeNull();
        });

        it('отклонена другая версия — эта показывается', async () => {
            const settings = new SettingsStore(sherpaDir);
            settings.patch({ updates: { dismissedVersion: '0.4.5' } });
            const checker = makeChecker({ settings });

            expect((await forced(checker))?.latest).toBe('0.5.0');
        });
    });

    describe('классификация установки', () => {
        it('каталог в чекауте Аркадии даёт arc pull в корне маунта', () => {
            expect(classifyInstall('/Users/x/arcadia/junk/alice/sherpa/skill')).toEqual({
                kind: 'arc-checkout',
                dir: '/Users/x/arcadia',
                command: "cd '/Users/x/arcadia' && arc pull",
            });
        });

        it('пробел в пути не разваливает команду для терминала', () => {
            expect(classifyInstall('/Users/x/My Work/junk/alice/sherpa/skill').command).toBe(
                "cd '/Users/x/My Work' && arc pull",
            );
        });

        it('каталог где угодно ещё — копия без команды', () => {
            expect(classifyInstall('/opt/sherpa')).toEqual({ kind: 'copy', dir: '/opt/sherpa', command: null });
        });

        it('каталог не задан — копия в cwd сервера', () => {
            expect(classifyInstall()).toEqual({ kind: 'copy', dir: process.cwd(), command: null });
        });
    });

    /** Форс отдаёт ещё и признак провала; большинству проверок нужен только сам `update`. */
    async function forced(checker: UpdateChecker): Promise<UiUpdate | null> {
        return (await checker.force()).update;
    }

    /** Даёт доработать цепочке промисов проверки, которую никто не ожидает. */
    async function flush(): Promise<void> {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }

    function stderrLines(): readonly string[] {
        return lines;
    }

    function writeCache(cache: unknown): void {
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
    }

    function readCache(): unknown {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
});

describe('ручки проверки версии', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey: string, updateCheck?: UpdateCheckOptions): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            ...(updateCheck === undefined ? {} : { updateCheck }),
        });
        servers.push(server);
        return server;
    }

    it('форс на фикстурном хосте отвечает контрактом и не ходит в сеть', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(200);
        expect(uiUpdateCheckResponseSchema.parse(await response.json())).toEqual({ update: null });
    });

    it('провал проверки отвечает ошибкой, а не «обновлений нет»', async () => {
        const server = await start('arcanum-4821', {
            currentVersion: CURRENT,
            cacheFile: path.join(sherpaDir, 'update-check.json'),
            token: () => Promise.resolve('token'),
            fetch: (() => Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch,
        });

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(502);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('host_unavailable');
    });

    it('дев-ручка подставляет версию фикстурному серверу', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: LATEST.releasedAt, whatsNew: LATEST.whatsNew },
            server.token,
        );

        expect(response.status).toBe(200);
        const { update } = uiUpdateCheckResponseSchema.parse(await response.json());
        expect(update?.latest).toBe('9.9.9');
        expect(update?.whatsNew).toBe(LATEST.whatsNew);
    });

    it('дев-ручки нет у арканумного prKey', async () => {
        const server = await start('arcanum-4821');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: null, whatsNew: null },
            server.token,
        );

        expect(response.status).toBe(404);
    });
});
