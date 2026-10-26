import { readFileSync } from 'node:fs';

import {
    CHANGELIST_FIELDS,
    COMMENT_ACK_FIELDS,
    COMMENT_FIELDS,
    DIFF_SETS_FIELDS,
    DRAFT_IDS_FIELDS,
    POLL_FIELDS,
    PR_REF_FIELDS,
    REVIEW_REQUEST_FIELDS,
    REVIEW_RULES_FIELDS,
    issueStatusSchema,
    type IssueStatus,
} from './schemas.js';

/**
 * Транспорт адаптера на синтетических ответах Арканума (`./mocks`). Живые вызовы в тестах
 * запрещены: контрактный набор и юниты гоняются только через него.
 *
 * Формы ответов повторяют контракт API; значения заменены синтетическими примерами:
 * знаковые id, отсутствующие поля вместо null, `members_by_role`
 * у resolve-members, исчезающий `draft` у опубликованного комментария.
 *
 * Мок с состоянием: ручки записи меняют комментарии и viewed-отметки, ручки чтения отдают
 * изменённое, `updated_at` двигается на любой записи — иначе поллинг тредов ничего бы не заметил,
 * а контрактный набор с `writes: true` проверял бы статические файлы вместо адаптера.
 */

export const MOCK_PR_ID = 4242;
export const MOCK_DIFF_SET_ID = 9001;
/** Предыдущая итерация записанного PR: к ней привязан якорь устаревшего треда. */
export const MOCK_PREVIOUS_DIFF_SET_ID = 9000;
/** Итерация, которая появляется после «пуша» мока (`MockArcanumControl.push`). */
export const MOCK_PUSHED_DIFF_SET_ID = 9002;
export const MOCK_USER = 'alice';

/** Запрос к моку целиком: ручкам записи нужны и метод, и тело, и заголовки. */
export interface MockRequest {
    readonly url: URL;
    readonly method: string;
    readonly body: string | undefined;
    readonly headers: Headers;
}

/**
 * Ручки мока, которых нет в API Арканума: тест дёргает их сам. Объект заполняет
 * `makeMockArcanumFetch` — так управление состоянием мока достаётся тесту, не меняя сигнатуру.
 */
export interface MockArcanumControl {
    /** «Пуш» автора: появляется новый опубликованный диффсет, он же становится активным. */
    push?: () => void;
}

/** Тенант Арканума, от лица которого отвечает мок: он же репозиторий PR. */
export type MockTenant = 'arcadia' | 'cloudia';

export interface MockArcanumOptions {
    /** Ответ по пути → статус вместо данных: так проверяется деградация линз и `host_unavailable`. */
    readonly failing?: Readonly<Record<string, number>>;
    /** Подмена тела ответа: тест меняет треды между тиками поллинга или ломает публикацию. */
    readonly bodies?: Readonly<Record<string, (request: MockRequest) => string>>;
    /** Счётчик запросов по ключу маршрута — им проверяется кэш на итерацию и вызовы вердиктов. */
    readonly calls?: Map<string, number>;
    /** Логин в `X-Arcanum-User`; null — заголовка нет (whoami не сработал). */
    readonly user?: string | null;
    /** Объект, в который мок положит свои «ручки» (см. `MockArcanumControl`). */
    readonly control?: MockArcanumControl;
    /** Репозиторий записанного PR; по умолчанию Аркадия. */
    readonly tenant?: MockTenant;
}

export function mockFile(name: string): string {
    return readFileSync(new URL(`./mocks/${name}`, import.meta.url), 'utf8');
}

/** Комментарий Арканума в моке: форма живого ответа, из полей нам структурно важен только `id`. */
type MockComment = Record<string, unknown> & { id: number };

/** Ручки одного комментария: `/v1/review-requests-comments/<знаковый id>`. */
const COMMENT_PATH = /\/review-requests-comments\/(-?\d+)$/;

/** Changelist итерации либо среза: xid `<id>` или `<baseId>-<headId>`. */
const CHANGELIST_PATH = /\/diff-sets\/([^/]+)\/changelist$/;

/** Вердиктные ручки существуют только на конкретной итерации diff-set. */
const VERDICT_PATH = /\/review-requests\/[^/]+\/diff-sets\/[^/]+\/(ship|request-for-changes)$/;

/**
 * Ключ маршрута: чтение — `pr`, `pr-ref`, `poll`, `rules`, `active-diff`, `diffs`, `changelist`,
 * `interdiff-changelist`, `comments-all`, `comments-active`, `resolve-members`, `pci`, `abc`,
 * `preview-a-yaml`; запись — `create-comment`, `create-reply`, `update-comment`, `delete-comment`,
 * `publish-drafts`, `ship`, `request-changes`, `reviewed-files`. Неизвестный запрос — ошибка
 * теста, а не пустой ответ.
 */
export function routeKeyOf(url: URL, method: string): string {
    const path = url.pathname;
    const fields = url.searchParams.get('fields') ?? '';

    if (path.endsWith('/review-requests/draft-comments')) {
        return 'publish-drafts';
    }
    if (path.endsWith('/replies')) {
        return 'create-reply';
    }
    const verdict = method === 'POST' ? VERDICT_PATH.exec(path)?.[1] : undefined;
    if (verdict === 'ship') {
        return 'ship';
    }
    if (verdict === 'request-for-changes') {
        return 'request-changes';
    }
    if (path.endsWith('/reviewed-files')) {
        return 'reviewed-files';
    }
    if (COMMENT_PATH.test(path)) {
        return method === 'DELETE' ? 'delete-comment' : 'update-comment';
    }
    if (method === 'POST' && path.endsWith('/codenavigation/abc/resolve-members')) {
        return 'resolve-members';
    }
    if (method === 'POST' && path.endsWith('/abc')) {
        return 'abc';
    }
    if (path.endsWith('/repos/preview/a-yaml')) {
        return 'preview-a-yaml';
    }
    if (path.endsWith('/active-diff')) {
        return 'active-diff';
    }
    if (path.endsWith('/diffs')) {
        return 'diffs';
    }
    const changelistXid = CHANGELIST_PATH.exec(path)?.[1];
    if (changelistXid !== undefined) {
        // xid вида `a-b` — интердифф, а не итерация.
        return changelistXid.includes('-') ? 'interdiff-changelist' : 'changelist';
    }
    if (path.includes('/pci-dss/commits/')) {
        return 'pci';
    }
    if (path.endsWith('/comments')) {
        if (method === 'POST') {
            return 'create-comment';
        }
        return path.includes('/diff-sets/') ? 'comments-active' : 'comments-all';
    }
    if (path.endsWith(`/review-requests/${String(MOCK_PR_ID)}`)) {
        if (fields === POLL_FIELDS) {
            return 'poll';
        }
        if (fields === REVIEW_RULES_FIELDS) {
            return 'rules';
        }
        if (fields === REVIEW_REQUEST_FIELDS) {
            return 'pr';
        }
        if (fields === PR_REF_FIELDS) {
            return 'pr-ref';
        }
        return `review-request?${fields}`;
    }
    return `${method} ${path}`;
}

/** Диффсет мока: форма элемента `GET /pull-requests/{id}/diffs`. */
interface MockDiffSet {
    id: number;
    created_at: string;
    published: boolean;
    commit_ids: { base: string; merge: string; head: string };
}

/** Состояние записанного PR: комментарии, viewed-отметки и отпечаток `updated_at`. */
class MockArcanumState {
    all: MockComment[] = JSON.parse(mockFile('comments-all.json')) as MockComment[];
    active: MockComment[] = JSON.parse(mockFile('comments-active.json')) as MockComment[];
    /** Перебивка `reviewed` в changelist: `PUT …/reviewed-files` — инкрементальный upsert. */
    private readonly reviewed = new Map<string, boolean>();
    private updatedAt = (JSON.parse(mockFile('pr.json')) as { updated_at: string }).updated_at;
    private diffSets: MockDiffSet[] = JSON.parse(mockFile('diffs.json')) as MockDiffSet[];
    private activeDiffSetId = MOCK_DIFF_SET_ID;
    private mutations = 0;
    /** Знаковое соглашение хоста: инлайновые id положительные, уровня PR — отрицательные. */
    private nextInlineId = 900;
    private nextPrLevelId = -70100;
    /** Повтор создания с тем же `Idempotency-Key` отдаёт тот же комментарий, а не дубль. */
    private readonly byIdempotencyKey = new Map<string, MockComment>();

    constructor(private readonly tenant: MockTenant) {}

    prBody(): unknown {
        const pr = JSON.parse(mockFile('pr.json')) as Record<string, unknown> & {
            vcs: Record<string, unknown>;
        };
        return {
            ...pr,
            vcs: { ...pr.vcs, arc_repo_name: this.tenant },
            updated_at: this.updatedAt,
            active_diff_set: { id: this.activeDiffSetId },
        };
    }

    /** Узкий запрос адаптера: ссылка на PR и его репозиторий. */
    prRefBody(): unknown {
        const pr = JSON.parse(mockFile('pr.json')) as { url: string };
        return { url: pr.url, vcs: { arc_repo_name: this.tenant } };
    }

    pollBody(): unknown {
        const pr = JSON.parse(mockFile('pr.json')) as { common_status: string };
        return {
            updated_at: this.updatedAt,
            common_status: pr.common_status,
            active_diff_set: { id: this.activeDiffSetId },
        };
    }

    diffsBody(): unknown {
        return this.diffSets;
    }

    /** `…/active-diff`: у записанной итерации — ровно записанный ответ, у появившейся — её коммиты. */
    activeDiffBody(): unknown {
        const recorded = JSON.parse(mockFile('active-diff.json')) as { id: number };
        if (recorded.id === this.activeDiffSetId) {
            return recorded;
        }
        const diffSet = this.diffSets.find((candidate) => candidate.id === this.activeDiffSetId);
        if (diffSet === undefined) {
            throw new Error(`мок Арканума не знает активный диффсет ${String(this.activeDiffSetId)}`);
        }
        return { id: diffSet.id, commit_ids: diffSet.commit_ids };
    }

    /** «Пуш» автора: новый опубликованный диффсет становится активным. */
    push(): void {
        this.diffSets.push({
            id: MOCK_PUSHED_DIFF_SET_ID,
            created_at: this.stamp(),
            published: true,
            commit_ids: {
                base: '001a722674f219d8096bbff02e1240aa9cffba97',
                merge: 'a71d4e29b3c05f8e17d64a920cb3e5f8710d4c63',
                head: 'd0c9b8a7e6f5142330b9c8d7e6f5142330b9c8d7',
            },
        });
        this.activeDiffSetId = MOCK_PUSHED_DIFF_SET_ID;
        this.bump();
    }

    changelist(): unknown[] {
        const entries = JSON.parse(mockFile('changelist.json')) as Record<string, unknown>[];
        return entries.map((entry) => {
            const viewed = this.reviewed.get(String(entry.entry_id));
            return viewed === undefined ? entry : { ...entry, reviewed: viewed };
        });
    }

    /** `POST …/comments`: PR-level — только текст, инлайн — с полным якорем итерации. */
    createComment(request: MockRequest): MockComment {
        return this.idempotent(request, () => {
            const body = jsonBody(request);
            const content = requireString(body.content, 'content');
            // Арканум `not_issue` не хранит: комментарий, который issue не открывает, приезжает
            // обратно вовсе без `issue_status` (проверено на живом PR). Мок обязан врать так же.
            const issueStatus = readIssueStatus(body);
            if (body.draft !== true) {
                throw new Error('мок Арканума: Шерпа создаёт только черновики (draft: true)');
            }

            const entryId = body.entry_id;
            if (entryId === undefined) {
                return this.append(this.nextPrLevelId--, {
                    content,
                    ...(issueStatus === undefined ? {} : { issue_status: issueStatus }),
                    anchor: { review_request: { id: MOCK_PR_ID } },
                });
            }

            const line = body.diff_line;
            return this.append(this.nextInlineId++, {
                content,
                ...(issueStatus === undefined ? {} : { issue_status: issueStatus }),
                anchor: {
                    review_request: {
                        id: MOCK_PR_ID,
                        diff: {
                            diff_set_xid: requireString(body.diff_set_xid, 'diff_set_xid'),
                            file: {
                                entry_id: requireString(entryId, 'entry_id'),
                                path: requireString(body.file_path, 'file_path'),
                                diff_content_id: 'dcid:1:draft',
                                ...(typeof line === 'number'
                                    ? {
                                          position: {
                                              side: body.diff_side,
                                              line,
                                              size: body.diff_size ?? 1,
                                          },
                                      }
                                    : {}),
                            },
                        },
                    },
                },
            });
        });
    }

    /** `POST /review-requests-comments/{id}/replies`: якоря нет — тред принадлежит корню. */
    createReply(request: MockRequest): MockComment {
        return this.idempotent(request, () => {
            const body = jsonBody(request);
            const parentId = commentIdOf(request);
            const parent = this.find(parentId);
            // Ответ живёт в том же знаковом пространстве, что и корень его треда.
            const id = parent.id < 0 ? this.nextPrLevelId-- : this.nextInlineId++;
            const issueStatus = readIssueStatus(body);
            return this.append(id, {
                content: requireString(body.content, 'content'),
                ...(issueStatus === undefined ? {} : { issue_status: issueStatus }),
                reply_to_id: parentId,
            });
        });
    }

    /** `PATCH /review-requests-comments/{id}`: текст черновика либо статус issue. */
    updateComment(request: MockRequest): MockComment {
        const body = jsonBody(request);
        const comment = this.find(commentIdOf(request));
        const patch: Record<string, unknown> = {};

        if (body.content !== undefined) {
            patch.content = requireString(body.content, 'content');
            patch.edited_at = this.stamp();
        }
        if (body.issue_status !== undefined) {
            const next = readIssueStatus(body);
            if (next === undefined) {
                delete comment.issue_status;
            }
            patch.issue_status = next;
            patch.status_updated_by = { name: MOCK_USER };
            patch.status_updated_at = this.stamp();
        }
        if (Object.keys(patch).length === 0) {
            throw new Error('мок Арканума: PATCH без content и issue_status');
        }

        return this.replace(comment.id, patch);
    }

    /**
     * `DELETE /review-requests-comments/{id}`: черновик стирается физически, опубликованный
     * получает `deleted_at` и наружу больше не отдаётся (проверено живьём).
     */
    deleteComment(request: MockRequest): void {
        const comment = this.find(commentIdOf(request));
        if (comment.draft === true) {
            this.all = this.all.filter((candidate) => candidate.id !== comment.id);
            this.active = this.active.filter((candidate) => candidate.id !== comment.id);
            this.bump();
            return;
        }
        this.replace(comment.id, { deleted_at: this.stamp() });
    }

    /**
     * `POST /v1/review-requests/draft-comments`: выборочная публикация. Знаковые пространства
     * разделены — сервер это соглашение валидирует, и мок валидирует тоже.
     */
    publish(request: MockRequest): number[] {
        const body = jsonBody(request);
        const inline = numberList(body.comment_for_diff_ids, 'comment_for_diff_ids');
        const prLevel = numberList(body.comment_for_review_ids, 'comment_for_review_ids');
        if (inline.some((id) => id < 0) || prLevel.some((id) => id > 0)) {
            throw new Error('мок Арканума: черновики разъехались по чужим знаковым пространствам');
        }

        const published: number[] = [];
        for (const id of [...inline, ...prLevel]) {
            const comment = this.all.find((candidate) => candidate.id === id);
            if (comment?.draft !== true) {
                continue;
            }
            // У опубликованного `draft` из ответа исчезает вовсе, а не становится false.
            const { draft: _draft, ...rest } = comment;
            this.replace(id, { ...rest, published_at: this.stamp() }, true);
            published.push(id);
        }
        this.bump();
        return published;
    }

    /** `PUT …/reviewed-files`: инкрементальный upsert отметок «просмотрено». */
    setReviewed(request: MockRequest): void {
        const body = jsonBody(request);
        const viewed = body.reviewed;
        if (typeof viewed !== 'boolean') {
            throw new Error('мок Арканума: reviewed обязан быть булевым');
        }
        for (const entryId of entryIdList(body.entry_ids)) {
            this.reviewed.set(entryId, viewed);
        }
        this.bump();
    }

    /** Вердикт тела не меняет: наблюдаемость — в счётчике запросов теста. */
    applyVerdict(): void {
        this.bump();
    }

    private idempotent(request: MockRequest, create: () => MockComment): MockComment {
        const key = request.headers.get('idempotency-key');
        if (key === null) {
            return create();
        }
        const seen = this.byIdempotencyKey.get(key);
        if (seen !== undefined) {
            return seen;
        }
        const created = create();
        this.byIdempotencyKey.set(key, created);
        return created;
    }

    /**
     * Новый комментарий в оба списка: комментарии уровня PR ручка итерации не отдаёт (так же,
     * как в записанных `comments-active.json`), инлайновые и ответы — отдаёт.
     */
    private append(id: number, fields: Record<string, unknown>): MockComment {
        const now = this.stamp();
        const created: MockComment = {
            id,
            user: { name: MOCK_USER },
            draft: true,
            created_at: now,
            updated_at: now,
            ...fields,
        };
        this.all.push(created);
        if (id > 0) {
            this.active.push({ ...created });
        }
        this.bump();
        return created;
    }

    private find(id: number): MockComment {
        const comment = this.all.find((candidate) => candidate.id === id);
        if (comment === undefined) {
            throw new Error(`мок Арканума не знает комментарий ${String(id)}`);
        }
        return comment;
    }

    /** Правка комментария в обоих списках; `whole` — поля заменяют объект целиком. */
    private replace(id: number, fields: Record<string, unknown>, whole = false): MockComment {
        const apply = (list: MockComment[]): MockComment | null => {
            const index = list.findIndex((candidate) => candidate.id === id);
            if (index === -1) {
                return null;
            }
            const next = (whole ? { ...fields, id } : { ...list[index], ...fields }) as MockComment;
            list[index] = next;
            return next;
        };

        const updated = apply(this.all);
        apply(this.active);
        if (updated === null) {
            throw new Error(`мок Арканума не знает комментарий ${String(id)}`);
        }
        this.bump();
        return updated;
    }

    /** Отпечаток PR обязан двигаться на любой записи — на нём стоит поллинг тредов. */
    private bump(): void {
        this.updatedAt = this.stamp();
    }

    /** Время растёт монотонно: порядок ответов в треде считается по нему. */
    private stamp(): string {
        this.mutations += 1;
        const time = new Date(Date.UTC(2026, 7, 22, 10, 0, this.mutations));
        return `${time.toISOString().slice(0, -1)}000Z`;
    }
}

/** Байты — ответ ручки содержимого на картинку: живая ручка тоже отдаёт их без обёрток. */
type MockHandler = (request: MockRequest, state: MockArcanumState) => string | Uint8Array;

/** Пустое тело — ответ 204: так отвечают `ship` и `reviewed-files`. */
const NO_CONTENT = '';

const DEFAULT_HANDLERS: Record<string, MockHandler> = {
    pr: (_request, state) => wrap(JSON.stringify(state.prBody())),
    'pr-ref': (_request, state) => wrap(JSON.stringify(state.prRefBody())),
    poll: (_request, state) => wrap(JSON.stringify(state.pollBody())),
    rules: () => wrap(mockFile('rules.json')),
    'active-diff': (_request, state) => wrap(JSON.stringify(state.activeDiffBody())),
    diffs: (_request, state) => wrap(JSON.stringify(state.diffsBody())),
    changelist: (_request, state) => wrap(JSON.stringify(state.changelist())),
    'interdiff-changelist': () => wrap(mockFile('changelist-interdiff.json')),
    'comments-all': (_request, state) => wrap(JSON.stringify(state.all)),
    'comments-active': (_request, state) => wrap(JSON.stringify(state.active)),
    'resolve-members': () => wrap(mockFile('resolve-members.json')),
    pci: () => wrap(mockFile('pci.json')),
    abc: (request) => mockAbcPaths(request),
    // У preview конверта `{data}` нет: тело лежит в корне ответа (проверено живьём).
    'preview-a-yaml': (request) => mockPreviewAYaml(request),
    'create-comment': (request, state) => wrap(JSON.stringify(state.createComment(request))),
    'create-reply': (request, state) => wrap(JSON.stringify(state.createReply(request))),
    'update-comment': (request, state) => wrap(JSON.stringify(state.updateComment(request))),
    'delete-comment': (request, state) => {
        state.deleteComment(request);
        // Удаление черновика отвечает 200 с пустым объектом, а не 204.
        return '{}';
    },
    // Записанная форма — голая, без конверта `{data}` (проверено живьём на write-ручках);
    // конверт у этой ручки живьём не подтверждён, поэтому адаптер принимает и его — см. тест.
    'publish-drafts': (request, state) => JSON.stringify({ published: state.publish(request) }),
    ship: (_request, state) => {
        state.applyVerdict();
        return NO_CONTENT;
    },
    'request-changes': (_request, state) => {
        state.applyVerdict();
        // Единственный вердикт с телом: `common_status` строкой, адаптеру он не нужен.
        return wrap('"waiting_for_changes"');
    },
    'reviewed-files': (request, state) => {
        state.setReviewed(request);
        return NO_CONTENT;
    },
};

function wrap(data: string): string {
    return `{"data":${data}}`;
}

/**
 * `POST /v1/repos/{repo}/abc`: отдаём только запрошенные пути и в своём порядке — адаптер обязан
 * сопоставлять ответ по `path`. Незнакомый путь — ошибка теста: мок должен знать весь дифф.
 * Экспорт — для тестов, подсматривающих сам запрос: ответ должен остаться записанным.
 */
export function mockAbcPaths(request: MockRequest): string {
    return wrap(JSON.stringify(abcPaths(request)));
}

function abcPaths(request: MockRequest): unknown[] {
    const recorded = JSON.parse(mockFile('abc-paths.json')) as { path: string }[];
    const body = jsonBody(request);
    const asked: unknown[] = Array.isArray(body.paths) ? body.paths : [];
    const wanted = new Set(
        asked.map((item) => {
            const path = (item as { path?: unknown }).path;
            if (typeof path !== 'string' || path === '') {
                throw new Error('мок Арканума: элемент abc-запроса без строкового path');
            }
            return path;
        }),
    );

    for (const path of wanted) {
        if (!recorded.some((item) => item.path === path)) {
            throw new Error(`мок Арканума не знает владельца пути: ${path}`);
        }
    }
    return recorded.filter((item) => wanted.has(item.path));
}

/**
 * `GET /v1/repos/preview/a-yaml`: записанная иерархия того a.yaml, о котором спросили. Экспорт —
 * для тестов, подменяющих ответ одного конфига: остальные должны остаться записанными.
 */
export function mockPreviewAYaml(request: MockRequest): string {
    const configPath = request.url.searchParams.get('path');
    const known: Record<string, string> = {
        'examples/ui/packages/grid/a.yaml': 'preview-grid.json',
        'examples/ui/docs/a.yaml': 'preview-docs.json',
    };
    const file = configPath === null ? undefined : known[configPath];
    if (file === undefined) {
        throw new Error(`мок Арканума не знает иерархию a.yaml: ${String(configPath)}`);
    }
    return mockFile(file);
}

function jsonBody(request: MockRequest): Record<string, unknown> {
    const raw = request.body ?? '';
    if (raw === '') {
        throw new Error(`мок Арканума: ${request.method} ${request.url.pathname} без тела`);
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('мок Арканума: тело запроса не объект');
    }
    return parsed as Record<string, unknown>;
}

function commentIdOf(request: MockRequest): number {
    const found = COMMENT_PATH.exec(request.url.pathname.replace(/\/replies$/, ''));
    if (found === null) {
        throw new Error(`мок Арканума: в пути нет id комментария: ${request.url.pathname}`);
    }
    return Number(found[1]);
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value === '') {
        throw new Error(`мок Арканума: поле ${field} обязано быть непустой строкой`);
    }
    return value;
}

/** `not_issue` Арканум не хранит — статуса у такого комментария нет вовсе. */
function readIssueStatus(body: Record<string, unknown>): IssueStatus | undefined {
    if (body.issue_status === undefined) {
        return undefined;
    }
    const parsed = issueStatusSchema.parse(requireString(body.issue_status, 'issue_status'));
    return parsed === 'not_issue' ? undefined : parsed;
}

function numberList(value: unknown, field: string): number[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) {
        throw new Error(`мок Арканума: поле ${field} обязано быть массивом чисел`);
    }
    return value as number[];
}

function entryIdList(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('мок Арканума: entry_ids обязан быть непустым массивом');
    }
    return value.map((item) => String(item));
}

/**
 * Ручки, за которыми Шерпа больше не ходит: текст диффа и содержимое файлов читаются локальным
 * `arc`. Обращение к любой из них — регрессия, и мок обязан падать громко, а не отвечать 404.
 */
const ABANDONED_PATHS = [/\/patch$/, /\/repos\/content\/text-diff$/, /\/repos\/content\/file$/];

/**
 * Ручки, которые обязаны знать репозиторий PR: правила ревью считаются в своём тенанте, а скоуп
 * PCI DSS есть только у Аркадии. Промах — регрессия адаптера; мок такой запрос не обслуживает и
 * отвечает 500. Бросок здесь был бы бесполезен: `ArcanumClient` ловит любую ошибку `fetch` и
 * превращает её в отказ, который хост глотает деградацией линзы. Ловить регрессию должен тест —
 * по счётчику `calls` (он растёт и на промахе) или по `bodies`, куда промах не дойдёт.
 */
function tenantMismatch(key: string, url: URL, tenant: MockTenant): string | null {
    if (key === 'abc' && !url.pathname.endsWith(`/repos/${tenant}/abc`)) {
        return `мок Арканума: abc спрошен не у репозитория ${tenant}: ${url.pathname}`;
    }
    if (key === 'preview-a-yaml' && url.searchParams.get('repo_name') !== tenant) {
        return `мок Арканума: preview a.yaml спрошен не у репозитория ${tenant}: ${String(url.searchParams.get('repo_name'))}`;
    }
    if (key === 'pci' && tenant !== 'arcadia') {
        return 'мок Арканума: скоуп PCI DSS есть только у Аркадии';
    }
    return null;
}

function assertNotAbandoned(url: URL): void {
    if (ABANDONED_PATHS.some((pattern) => pattern.test(url.pathname))) {
        throw new Error(`мок Арканума: Шерпа больше не ходит в ${url.pathname} — дифф и содержимое читает arc`);
    }
}

export function makeMockArcanumFetch(
    options: MockArcanumOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
    const tenant = options.tenant ?? 'arcadia';
    const state = new MockArcanumState(tenant);
    if (options.control !== undefined) {
        options.control.push = (): void => {
            state.push();
        };
    }

    return (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';
        assertNotAbandoned(url);
        const key = routeKeyOf(url, method);
        options.calls?.set(key, (options.calls.get(key) ?? 0) + 1);

        const headers = new Headers({ 'content-type': 'application/json' });
        const user = options.user === undefined ? MOCK_USER : options.user;
        if (user !== null) {
            headers.set('x-arcanum-user', user);
        }

        const mismatch = tenantMismatch(key, url, tenant);
        if (mismatch !== null) {
            return Promise.resolve(
                new Response(JSON.stringify({ errors: [{ status: '500', message: mismatch }] }), {
                    status: 500,
                    headers,
                }),
            );
        }

        const failure = options.failing?.[key];
        if (failure !== undefined) {
            return Promise.resolve(
                new Response(`{"errors":[{"status":"${String(failure)}","message":"mock failure"}]}`, {
                    status: failure,
                    headers,
                }),
            );
        }

        const request: MockRequest = {
            url,
            method,
            body: typeof init?.body === 'string' ? init.body : undefined,
            headers: new Headers(init?.headers),
        };
        const override = options.bodies?.[key];
        const body = override === undefined ? DEFAULT_HANDLERS[key]?.(request, state) : override(request);
        if (body === undefined) {
            return Promise.resolve(
                new Response(
                    JSON.stringify({ errors: [{ status: '404', message: `мок Арканума не знает маршрут: ${key}` }] }),
                    { status: 404, headers },
                ),
            );
        }
        if (typeof body === 'string' && body === NO_CONTENT) {
            return Promise.resolve(new Response(null, { status: 204, headers }));
        }
        return Promise.resolve(new Response(body, { status: 200, headers }));
    };
}

/** Строгие проекции, которые адаптер обязан слать: тест сверяет их с записанными. */
export const EXPECTED_FIELDS = {
    pr: REVIEW_REQUEST_FIELDS,
    poll: POLL_FIELDS,
    rules: REVIEW_RULES_FIELDS,
    changelist: CHANGELIST_FIELDS,
    comments: COMMENT_FIELDS,
    commentAck: COMMENT_ACK_FIELDS,
    draftIds: DRAFT_IDS_FIELDS,
    diffSets: DIFF_SETS_FIELDS,
} as const;
