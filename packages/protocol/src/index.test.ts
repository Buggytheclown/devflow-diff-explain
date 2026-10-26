import { describe, expect, it } from 'vitest';

import {
    agentNoteSchema,
    chatAnchorSchema,
    chatExchangeSchema,
    commentDraftSchema,
    commentSchema,
    DISTRIBUTION_WHATS_NEW_MAX_CHARS,
    distributionVersionSchema,
    fileDiffSchema,
    generateJsonSchemas,
    hostCapabilitiesSchema,
    imageMimeOf,
    iterationSchema,
    lensZoneSchema,
    prMetaSchema,
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    RESULT_MAX_BYTES,
    reviewUserSchema,
    routeProvenanceSchema,
    routeSectionResultSchema,
    routeSkeletonResultSchema,
    routeSnapshotSchema,
    serverManifestSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskSchema,
    threadSchema,
    uiChatAskRequestSchema,
    uiDevUpdateAvailableRequestSchema,
    uiReviewDiffRequestSchema,
    uiRouteStaleSchema,
    uiSettingsPatchSchema,
    uiSettingsSchema,
    uiSnapshotSummarySchema,
    uiUpdateSchema,
    workerNextResponseSchema,
} from './index.js';

describe('версия и рукопожатие', () => {
    it('экспортирует версию протокола', () => {
        expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('в линии 0.x минор ломающий, с 1.0 — только мажор', () => {
        expect(protocolVersionsCompatible('0.1.0', '0.1.7')).toBe(true);
        expect(protocolVersionsCompatible('0.1.0', '0.2.0')).toBe(false);
        expect(protocolVersionsCompatible('1.2.0', '1.9.3')).toBe(true);
        expect(protocolVersionsCompatible('1.0.0', '2.0.0')).toBe(false);
    });

    it('нераспознанные строки несовместимы', () => {
        expect(protocolVersionsCompatible('мусор', '0.1.0')).toBe(false);
        expect(protocolVersionsCompatible('0.1', '0.1.0')).toBe(false);
    });
});

describe('задача и аренда', () => {
    const validTask = {
        id: 42,
        type: 'echo',
        priority: 'interactive',
        attempt: 1,
        instructions: 'Верни содержимое файла как есть.',
        contextFiles: ['/tmp/sherpa/task-42-context.md'],
    };

    it('валидная echo-задача проходит', () => {
        expect(taskSchema.parse(validTask)).toEqual(validTask);
    });

    it('fail-closed: неизвестный тип, нулевая попытка, пустые instructions отбиваются', () => {
        expect(taskSchema.safeParse({ ...validTask, type: 'regenerate.skeleton' }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, attempt: 0 }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, instructions: '' }).success).toBe(false);
    });

    it('генеративные типы маршрута и chat валидны', () => {
        expect(taskSchema.safeParse({ ...validTask, type: 'route.skeleton' }).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, type: 'route.section' }).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, type: 'chat' }).success).toBe(true);
    });

    it('ответ next различает task/idle/done по kind', () => {
        const parsed = workerNextResponseSchema.parse({
            kind: 'task',
            task: validTask,
            lease: { taskId: 42, ttlSeconds: 600, expiresAt: '2026-08-19T12:00:00.000Z' },
        });
        expect(parsed.kind).toBe('task');
        expect(workerNextResponseSchema.safeParse({ kind: 'idle', message: 'задач нет' }).success).toBe(true);
        expect(workerNextResponseSchema.safeParse({ kind: 'что-то' }).success).toBe(false);
    });
});

describe('complete', () => {
    const base = {
        protocolVersion: '0.1.0',
        cliVersion: '0.1.0',
        workerId: 'w-1',
        taskId: 42,
    };

    it('лимит результата считается в байтах, не в символах', () => {
        // Кириллица — 2 байта на символ: длина строки меньше лимита, байтов — больше.
        const oversized = 'я'.repeat(RESULT_MAX_BYTES / 2 + 1);
        expect(taskCompleteRequestSchema.safeParse({ ...base, result: oversized }).success).toBe(false);
        expect(taskCompleteRequestSchema.safeParse({ ...base, result: 'ok' }).success).toBe(true);
    });

    it('ответ various: accepted / rejected со списком ошибок / noop', () => {
        expect(taskCompleteResponseSchema.safeParse({ kind: 'accepted', message: 'принято' }).success).toBe(true);
        expect(taskCompleteResponseSchema.safeParse({ kind: 'rejected', errors: [] }).success).toBe(false);
        expect(
            taskCompleteResponseSchema.safeParse({ kind: 'rejected', errors: ['поле x отсутствует'] }).success,
        ).toBe(true);
        expect(taskCompleteResponseSchema.safeParse({ kind: 'noop', message: 'уже закрыта' }).success).toBe(true);
    });
});

describe('манифест discovery', () => {
    it('валидный манифест проходит, кривой порт — нет', () => {
        const manifest = {
            prKey: 'arcanum-12345',
            port: 49152,
            pid: 999,
            token: 'secret',
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: '2026-08-19T12:00:00.000Z',
        };
        expect(serverManifestSchema.parse(manifest)).toEqual(manifest);
        expect(serverManifestSchema.safeParse({ ...manifest, port: 0 }).success).toBe(false);
        expect(serverManifestSchema.safeParse({ ...manifest, port: 70000 }).success).toBe(false);
    });
});

describe('домен ревью', () => {
    const author = { login: 'alice', displayName: null, bot: false, avatarUrl: null };
    const comment = (id: string, replies: unknown[] = []) => ({
        id,
        author,
        body: 'текст',
        draft: false,
        issue: null,
        resolved: null,
        createdAt: '2026-08-20T12:00:00.000Z',
        editedAt: null,
        replies,
    });

    it('тред — дерево: глубокая ветвящаяся цепочка ответов проходит', () => {
        const deep = comment('1', [comment('2', [comment('3', [comment('4')]), comment('5')])]);
        const thread = {
            id: '1',
            anchor: {
                fileId: 'eid:1:abc',
                path: 'src/index.ts',
                position: { side: 'new', line: 20, size: 11 },
            },
            resolved: false,
            resolvedBy: null,
            outdated: false,
            pinnedTo: { diffId: 'iter-2', commit: '9f3c1ab' },
            root: deep,
        };
        expect(threadSchema.parse(thread)).toEqual(thread);
        expect(threadSchema.safeParse({ ...thread, pinnedTo: null }).success).toBe(true);
        expect(threadSchema.safeParse({ ...thread, pinnedTo: { diffId: 'iter-2' } }).success).toBe(false);
    });

    it('итерация: ровно три статуса, gone — тоже валидна (ставит сервер)', () => {
        const iteration = {
            diffId: 'iter-2',
            baseCommit: 'a71d4e2',
            headCommit: '9f3c1ab',
            createdAt: '2026-09-02T10:00:00.000Z',
            status: 'active',
        };
        expect(iterationSchema.parse(iteration)).toEqual(iteration);
        expect(iterationSchema.safeParse({ ...iteration, status: 'gone' }).success).toBe(true);
        expect(iterationSchema.safeParse({ ...iteration, status: 'stale' }).success).toBe(false);
    });

    it('аватар: https-URL или null, поле обязательно', () => {
        const photo = { ...author, avatarUrl: 'https://avatars.githubusercontent.com/alice?s=100' };
        expect(reviewUserSchema.parse(photo)).toEqual(photo);
        expect(reviewUserSchema.safeParse(author).success).toBe(true);
        const broken = ['http://avatars.githubusercontent.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', 'аватар', ''];
        for (const avatarUrl of broken) {
            expect(reviewUserSchema.safeParse({ ...author, avatarUrl }).success).toBe(false);
        }
        expect(reviewUserSchema.safeParse({ login: 'alice', displayName: null, bot: false }).success).toBe(false);
    });

    it('fail-closed: битый ответ в глубине дерева валит весь тред', () => {
        const broken = comment('1', [comment('2', [{ id: '3' }])]);
        expect(commentSchema.safeParse(broken).success).toBe(false);
    });

    it('черновик: PR-level — оба null, инлайн — якорь без позиции допустим (комментарий на файл)', () => {
        expect(commentDraftSchema.safeParse({ body: 'lgtm', parentId: null, anchor: null }).success).toBe(true);
        expect(
            commentDraftSchema.safeParse({
                body: 'вопрос',
                parentId: null,
                anchor: { fileId: 'eid:1:abc', path: 'a.ts', position: null },
            }).success,
        ).toBe(true);
        expect(commentDraftSchema.safeParse({ body: '', parentId: null, anchor: null }).success).toBe(false);
    });

    it('viewer шапки PR: ревьюер или null, но не половина пользователя', () => {
        const meta = {
            id: '4242',
            url: 'https://github.com/quillmart/quillmart/pull/4242',
            title: 'Окно редактирования заказа',
            author,
            fromBranch: 'users/alice/edit-window',
            toBranch: 'trunk',
            state: 'open',
            statusLabel: 'review_in_progress',
            checks: null,
            updatedAt: '2026-08-20T12:00:00.000Z',
            capabilities: {
                publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'],
                fileViewedSync: true,
                fileContent: true,
                commentIssues: true,
                commentResolve: true,
                editPublished: true,
                iterations: true,
                blobs: true,
            },
            verdicts: [],
            viewer: author,
        };
        expect(prMetaSchema.parse(meta)).toEqual(meta);
        expect(prMetaSchema.safeParse({ ...meta, viewer: null }).success).toBe(true);
        expect(prMetaSchema.safeParse({ ...meta, viewer: { login: 'alice' } }).success).toBe(false);
        const { viewer: _viewer, ...withoutViewer } = meta;
        expect(prMetaSchema.safeParse(withoutViewer).success).toBe(false);
    });

    it('режимы публикации: без повторов, состав решает хост', () => {
        const capabilities = {
            publishVerdicts: ['comment'],
            fileViewedSync: false,
            fileContent: false,
            commentIssues: false,
            commentResolve: false,
            editPublished: false,
            iterations: false,
            blobs: false,
        };
        expect(hostCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
        const verdicts = (publishVerdicts: string[]): boolean =>
            hostCapabilitiesSchema.safeParse({ ...capabilities, publishVerdicts }).success;
        expect(verdicts(['comment', 'ship', 'sticky_ship', 'request_changes'])).toBe(true);
        expect(verdicts([])).toBe(true);
        expect(verdicts(['ship', 'request_changes'])).toBe(true);
        expect(verdicts(['comment', 'ship', 'ship'])).toBe(false);
        expect(verdicts(['comment', 'approve'])).toBe(false);
    });

    it('ownership-зона требует границу и хотя бы один путь', () => {
        const zone = {
            path: 'services/orders/src/domain',
            mine: true,
            owner: 'checkout-domain',
            paths: ['services/orders/src/domain/order.ts'],
        };
        expect(lensZoneSchema.parse(zone)).toEqual(zone);
        expect(lensZoneSchema.safeParse({ ...zone, path: '' }).success).toBe(false);
        expect(lensZoneSchema.safeParse({ ...zone, paths: [] }).success).toBe(false);
    });
});

describe('маршрут', () => {
    const skeleton = {
        summary: 'PR переводит кэш сессий на write-through.',
        stops: [
            { title: 'Сердце изменения: политика записи', tier: 'high', intent: 'cache.py, строки записи' },
            { title: 'Обвязка конфигурации', tier: 'low', intent: 'config.yaml' },
        ],
        tourOrder: [2, 1],
    };

    it('валидный скелет проходит; кривой тир и пустой план — нет', () => {
        expect(routeSkeletonResultSchema.parse(skeleton)).toEqual(skeleton);
        expect(
            routeSkeletonResultSchema.safeParse({
                ...skeleton,
                stops: [{ ...skeleton.stops[0], tier: 'other' }],
            }).success,
        ).toBe(false);
        expect(routeSkeletonResultSchema.safeParse({ ...skeleton, stops: [] }).success).toBe(false);
    });

    it('результат секции: якоря обязательны, батч из нескольких стопов допустим', () => {
        const fill = (planIndex: number) => ({
            planIndex,
            paragraph: 'Что изменилось и какие следствия.',
            anchors: [{ path: 'src/cache.py', side: 'new', start: 10, end: 24 }],
        });
        expect(routeSectionResultSchema.safeParse({ stops: [fill(1), fill(2)] }).success).toBe(true);
        expect(
            routeSectionResultSchema.safeParse({ stops: [{ ...fill(1), anchors: [] }] }).success,
        ).toBe(false);
    });

    it('снапшот: заполненный и незаполненный стопы, синтетическое «Прочее»', () => {
        const snapshot = {
            snapshotId: 'snap-1',
            commit: '9f3c1ab',
            baseCommit: 'a71d4e2',
            diffId: 'iter-3',
            createdAt: '2026-08-25T12:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: 'ru' },
            previousSnapshotId: 'snap-0',
            carried: { kept: 3, total: 4, zeroReason: null },
            summary: 'Summary.',
            stops: [
                {
                    id: 'stop-1',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Сердце изменения',
                    status: 'ready',
                    paragraph: 'Абзац.',
                    bridge: 'Дальше — обвязка.',
                    anchors: [
                        { fileId: 'f1', path: 'src/cache.py', side: 'new', start: 10, end: 24, collapsed: false },
                    ],
                    tests: [
                        {
                            kind: 'weakened',
                            text: 'Ослаблен ассерт таймаута',
                            anchor: { fileId: 'f2', path: 'tests/test_cache.py', line: 41 },
                        },
                    ],
                    droppedClaims: 1,
                    validationNotes: [],
                    provenance: null,
                    change: { kind: 'changed', reason: 'Автор ответил в треде и переписал retry.', threadIds: ['1'] },
                },
                {
                    id: 'other',
                    planIndex: 2,
                    tier: 'other',
                    title: 'Прочее',
                    status: 'ready',
                    paragraph: null,
                    bridge: null,
                    anchors: [],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                    change: null,
                },
            ],
            tourOrder: ['stop-1', 'other'],
            contentHash: null,
        };
        expect(routeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
        expect(
            routeSnapshotSchema.safeParse({ ...snapshot, previousSnapshotId: null, carried: null }).success,
        ).toBe(true);
    });

    it('результат секции после пуша: объяснение изменения и треды-причины необязательны', () => {
        const stop = {
            planIndex: 1,
            paragraph: 'Что изменилось.',
            anchors: [{ path: 'src/cache.py', side: 'new', start: 10, end: 24 }],
            changeReason: 'Автор переписал retry после треда.',
            changeThreadIds: ['1', '2'],
        };
        expect(routeSectionResultSchema.safeParse({ stops: [stop] }).success).toBe(true);
        expect(routeSectionResultSchema.safeParse({ stops: [{ ...stop, changeReason: '' }] }).success).toBe(false);
    });
});

describe('чат и заметки', () => {
    const anchor = { diffId: 'iter-3', fileId: 'f1', path: 'src/order_service.py', side: 'new', start: 148, end: 151 };
    const exchange = {
        id: 1,
        question: 'почему тут инвалидация кэша до записи?',
        anchor,
        status: 'done',
        taskId: 42,
        answer: 'Порядок сохранён со старой реализации: …',
        progressText: null,
        error: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:01:00.000Z',
    };

    it('обмен: с якорем и без (Ask AI по PR), все статусы жизненного цикла', () => {
        // В обменах старого формата языка ответа нет: схема подставляет `null`.
        expect(chatExchangeSchema.parse(exchange)).toEqual({ ...exchange, locale: null });
        expect(chatExchangeSchema.parse({ ...exchange, locale: 'en' }).locale).toBe('en');
        expect(chatExchangeSchema.safeParse({ ...exchange, locale: 'de' }).success).toBe(false);
        expect(chatExchangeSchema.safeParse({ ...exchange, anchor: null }).success).toBe(true);
        expect(chatExchangeSchema.safeParse({ ...exchange, taskId: null }).success).toBe(true);
        for (const status of ['queued', 'running', 'done', 'failed', 'cancelled']) {
            expect(chatExchangeSchema.safeParse({ ...exchange, status }).success).toBe(true);
        }
        expect(chatExchangeSchema.safeParse({ ...exchange, status: 'streaming' }).success).toBe(false);
        expect(chatExchangeSchema.safeParse({ ...exchange, question: '' }).success).toBe(false);
    });

    it('заметка: якорь обязателен, исходный якорь хранится отдельно, commit допускает null', () => {
        const note = {
            id: 7,
            exchangeId: 1,
            anchor,
            text: 'Порядок сохранён со старой реализации: …',
            lostAnchor: false,
            origin: { commit: null, anchor },
            createdAt: '2026-09-01T12:01:00.000Z',
        };
        expect(agentNoteSchema.parse(note)).toEqual(note);
        expect(agentNoteSchema.safeParse({ ...note, anchor: null }).success).toBe(false);
        expect(agentNoteSchema.safeParse({ ...note, text: '' }).success).toBe(false);
        expect(agentNoteSchema.safeParse({ ...note, origin: { commit: '9f3c1ab' } }).success).toBe(false);
    });

    it('ask: пустой и сверхдлинный вопрос отбиваются, якорь необязателен, diffId якоря — тоже', () => {
        const { diffId: _diffId, ...anchorWithoutDiff } = anchor;
        expect(uiChatAskRequestSchema.safeParse({ text: 'вопрос' }).success).toBe(true);
        expect(uiChatAskRequestSchema.safeParse({ text: 'вопрос', anchor }).success).toBe(true);
        expect(uiChatAskRequestSchema.safeParse({ text: 'вопрос', anchor: anchorWithoutDiff }).success).toBe(true);
        expect(chatAnchorSchema.safeParse(anchorWithoutDiff).success).toBe(false);
        expect(uiChatAskRequestSchema.safeParse({ text: '' }).success).toBe(false);
        expect(uiChatAskRequestSchema.safeParse({ text: 'я'.repeat(4001) }).success).toBe(false);
    });
});

describe('итерации и снапшоты в UI-контракте', () => {
    it('выбор диффа: без параметров, по итерации или срезом; половина среза и смесь отбиваются', () => {
        expect(uiReviewDiffRequestSchema.safeParse({}).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ diffId: 'iter-2' }).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ base: 'iter-1', head: 'iter-2' }).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ base: 'iter-1' }).success).toBe(false);
        expect(uiReviewDiffRequestSchema.safeParse({ diffId: 'iter-2', base: 'iter-1', head: 'iter-2' }).success).toBe(
            false,
        );
    });

    it('stale маршрута: хотя бы одна новая итерация', () => {
        const stale = {
            routeCommit: '9f3c1ab',
            prCommit: 'c0ffee1',
            prDiffId: 'iter-4',
            newIterations: 1,
            affectedStopIds: ['stop-2', 'stop-3'],
        };
        expect(uiRouteStaleSchema.parse(stale)).toEqual(stale);
        expect(uiRouteStaleSchema.safeParse({ ...stale, newIterations: 0 }).success).toBe(false);
    });

    it('сводка снапшота: три статуса, прочие отбиваются', () => {
        const summary = {
            snapshotId: 'snap-1',
            diffId: 'iter-3',
            commit: '9f3c1ab',
            baseCommit: 'a71d4e2',
            createdAt: '2026-08-25T12:00:00.000Z',
            provenance: { harness: 'claude-code', model: null },
            previousSnapshotId: null,
            status: 'current',
        };
        for (const status of ['current', 'stale', 'gone']) {
            expect(uiSnapshotSummarySchema.safeParse({ ...summary, status }).success).toBe(true);
        }
        expect(uiSnapshotSummarySchema.safeParse({ ...summary, status: 'previous' }).success).toBe(false);
    });
});

describe('локаль, онбординг, обновление', () => {
    it('оформление Arcanum независимо от темы, в патче отсутствующие поля не сбрасываются', () => {
        expect(uiSettingsSchema.parse({ theme: 'light', arcanum: true, textSize: 'l' })).toMatchObject({
            theme: 'light',
            arcanum: true,
            textSize: 'l',
        });
        expect(uiSettingsPatchSchema.parse({ arcanum: true })).toEqual({ arcanum: true });
        expect(uiSettingsPatchSchema.parse({ arcanum: false })).toEqual({ arcanum: false });
        expect(uiSettingsPatchSchema.parse({ theme: 'auto' })).toEqual({ theme: 'auto' });
        expect(uiSettingsSchema.safeParse({ arcanum: 'true' }).success).toBe(false);
        expect(uiSettingsPatchSchema.safeParse({ arcanum: 'false' }).success).toBe(false);
        expect(uiSettingsSchema.safeParse({ theme: 'arcanum-dark' }).success).toBe(false);
        expect(uiSettingsPatchSchema.safeParse({ theme: 'arcanum-dark' }).success).toBe(false);
    });

    it('настройки: новые поля получают дефолты, в патче — без дефолтов и заменяются целиком', () => {
        expect(uiSettingsSchema.parse({})).toMatchObject({
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(uiSettingsSchema.safeParse({ locale: 'de' }).success).toBe(false);
        // Старый файл настроек с явной темой читается как есть, размер текста в нём отсутствует.
        expect(uiSettingsSchema.parse({ theme: 'dark' })).toMatchObject({ theme: 'dark', textSize: 'm' });
        expect(uiSettingsSchema.safeParse({ theme: 'sepia' }).success).toBe(false);
        expect(uiSettingsSchema.safeParse({ textSize: 'xl' }).success).toBe(false);
        expect(uiSettingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
        expect(uiSettingsPatchSchema.parse({ textSize: 'l' })).toEqual({ textSize: 'l' });
        expect(uiSettingsPatchSchema.safeParse({ textSize: 'm', theme: 'auto' }).success).toBe(true);
        expect(uiSettingsSchema.safeParse({ onboarding: { completedAt: null, step: -1 } }).success).toBe(false);
        expect(uiSettingsSchema.safeParse({ updates: { dismissedVersion: 'latest' } }).success).toBe(false);

        // Патч одного поля не подставляет дефолты остальных — иначе «не трогай» стало бы «сбрось».
        expect(uiSettingsPatchSchema.parse({ locale: 'en' })).toEqual({ locale: 'en' });
        expect(uiSettingsPatchSchema.safeParse({ onboarding: { step: 3 } }).success).toBe(false);
    });

    it('провенанс: locale необязателен на входе (старые снапшоты) и null на выходе', () => {
        expect(routeProvenanceSchema.parse({ harness: 'claude-code', model: null })).toEqual({
            harness: 'claude-code',
            model: null,
            locale: null,
        });
        expect(routeProvenanceSchema.safeParse({ harness: null, model: null, locale: 'fr' }).success).toBe(false);
    });

    it('файл диффа: image необязателен на входе (старые сохранённые диффы) и null на выходе', () => {
        const file = {
            fileId: 'f1',
            path: 'src/index.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1,2 @@\n a\n+b\n',
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
        };
        expect(fileDiffSchema.parse(file)).toEqual({ ...file, image: null });
        expect(fileDiffSchema.safeParse({ ...file, image: { mime: 'image/tiff', before: null, after: null } }).success).toBe(
            false,
        );
    });

    it('version.json: поля релиза nullable, whatsNew ограничен', () => {
        const built = { version: '0.5.0', builtFrom: 'b1e4515-dirty', releasedAt: null, whatsNew: null };
        expect(distributionVersionSchema.parse(built)).toEqual(built);
        expect(
            distributionVersionSchema.safeParse({ ...built, whatsNew: 'x'.repeat(DISTRIBUTION_WHATS_NEW_MAX_CHARS + 1) })
                .success,
        ).toBe(false);
        expect(distributionVersionSchema.safeParse({ ...built, version: '0.5' }).success).toBe(false);
    });

    it('обновление в снапшоте: установка из чекаута с командой, из копии — без', () => {
        const update = {
            current: '0.4.0',
            latest: '0.5.0',
            releasedAt: '2026-09-10T10:00:00.000Z',
            whatsNew: 'Онбординг и английский интерфейс',
            install: { kind: 'arc-checkout', dir: '/home/me/arc/arcadia/junk/alice/sherpa/skill', command: 'arc pull' },
        };
        expect(uiUpdateSchema.parse(update)).toEqual(update);
        expect(
            uiUpdateSchema.safeParse({ ...update, install: { kind: 'copy', dir: '/opt/sherpa', command: null } }).success,
        ).toBe(true);
        expect(uiUpdateSchema.safeParse({ ...update, install: { kind: 'zip', dir: '/opt', command: null } }).success).toBe(
            false,
        );
        expect(
            uiDevUpdateAvailableRequestSchema.safeParse({ version: '0.5.0', releasedAt: null, whatsNew: null }).success,
        ).toBe(true);
    });
});

describe('JSON-схемы', () => {
    it('генерятся из zod для всех сущностей контракта', () => {
        const schemas = generateJsonSchemas();
        for (const name of [
            'task',
            'lease',
            'workerNextResponse',
            'taskCompleteRequest',
            'serverManifest',
            'routeSkeletonResult',
            'routeSectionResult',
            'routeSnapshot',
        ]) {
            const schema = schemas[name] as Record<string, unknown> | undefined;
            expect(schema, name).toBeDefined();
            expect(schema?.$schema, name).toContain('json-schema.org');
        }
    });
});

describe('imageMimeOf', () => {
    it('узнаёт картинку по расширению без оглядки на регистр', () => {
        expect(imageMimeOf('assets/logo.PNG')).toBe('image/png');
        expect(imageMimeOf('a/b/c.jpg')).toBe('image/jpeg');
        expect(imageMimeOf('a/b/c.jpeg')).toBe('image/jpeg');
        expect(imageMimeOf('icon.svg')).toBe('image/svg+xml');
        expect(imageMimeOf('favicon.ico')).toBe('image/x-icon');
    });

    it('всё остальное картинкой не считает', () => {
        expect(imageMimeOf('src/index.ts')).toBeNull();
        expect(imageMimeOf('README')).toBeNull();
        // Точка в имени каталога расширением файла не становится.
        expect(imageMimeOf('assets.png/readme')).toBeNull();
        // Файл, начинающийся с точки, — не расширение, а имя.
        expect(imageMimeOf('.png')).toBeNull();
    });
});
