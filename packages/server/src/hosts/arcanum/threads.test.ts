import type { Comment } from '@sherpa/protocol';
import { reviewUserSchema, threadSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { ArcComment } from './schemas.js';
import { arcanumUser, buildThreads } from './threads.js';

/**
 * Сборка дерева из плоского списка — на данных, найденных разведкой в живых PR:
 * глубина до 14, ветвление, знаковые id, комментарии уровня PR без якоря.
 */

function comment(id: number, extra: Partial<ArcComment> = {}): ArcComment {
    return {
        id,
        user: { name: 'alice' },
        content: `комментарий ${String(id)}`,
        created_at: `2026-08-20T10:00:${String(Math.abs(id) % 60).padStart(2, '0')}.000000Z`,
        published_at: '2026-08-20T10:00:00.000000Z',
        ...extra,
    };
}

function anchored(id: number, line: number, extra: Partial<ArcComment> = {}): ArcComment {
    return comment(id, {
        anchor: {
            review_request: {
                diff: {
                    diff_set_xid: '1',
                    file: { entry_id: 'eid:a', path: 'src/a.ts', position: { side: 'new', line, size: 1 } },
                },
            },
        },
        ...extra,
    });
}

function depthOf(root: Comment): number {
    return root.replies.length === 0 ? 1 : 1 + Math.max(...root.replies.map(depthOf));
}

describe('дерево тредов', () => {
    it('цепочка глубиной 14 собирается целиком', () => {
        const chain = [anchored(1, 10)];
        for (let id = 2; id <= 14; id += 1) {
            chain.push(comment(id, { reply_to_id: id - 1 }));
        }

        const threads = buildThreads({ all: chain, active: chain });
        const root = threads[0]?.root;
        if (root === undefined) {
            throw new Error('тред не собрался');
        }

        expect(threads).toHaveLength(1);
        expect(depthOf(root)).toBe(14);
        expect(() => threadSchema.parse(threads[0])).not.toThrow();
    });

    it('ветвление: дети одного родителя идут по времени создания', () => {
        const root = anchored(10, 5);
        const first = comment(11, { reply_to_id: 10, created_at: '2026-08-20T12:00:00.000000Z' });
        const second = comment(12, { reply_to_id: 10, created_at: '2026-08-20T11:00:00.000000Z' });
        const third = comment(13, { reply_to_id: 12, created_at: '2026-08-20T13:00:00.000000Z' });

        const threads = buildThreads({ all: [root, first, second, third], active: [root, first, second, third] });

        expect(threads[0]?.root.replies.map((reply) => reply.id)).toEqual(['12', '11']);
        expect(threads[0]?.root.replies[0]?.replies.map((reply) => reply.id)).toEqual(['13']);
    });

    it('отрицательный id уровня PR доезжает как есть, якоря у треда нет', () => {
        const threads = buildThreads({ all: [comment(-15509458)], active: [] });

        expect(threads[0]?.id).toBe('-15509458');
        expect(threads[0]?.anchor).toBeNull();
        expect(threads[0]?.outdated).toBe(false);
    });

    it('outdated — инлайновый тред, не доехавший до активной итерации', () => {
        const stale = anchored(21, 7);
        const fresh = anchored(22, 9);

        const threads = buildThreads({ all: [stale, fresh], active: [fresh] });
        const byId = new Map(threads.map((thread) => [thread.id, thread]));

        expect(byId.get('21')?.outdated).toBe(true);
        expect(byId.get('22')?.outdated).toBe(false);
    });

    it.each(['open', 'not_issue'] as const)('%s не делает тред resolved', (issueStatus) => {
        const root = anchored(30, 5, { issue_status: issueStatus });

        const threads = buildThreads({ all: [root], active: [root] });

        expect(threads[0]?.resolved).toBe(false);
    });

    it.each([
        ['open', true],
        ['resolved', true],
        ['dropped', true],
        ['not_issue', false],
        // Арканум не хранит статус у комментариев, которые issue никогда не были.
        [undefined, false],
    ] as const)('issue_status=%s даёт issue=%s', (issueStatus, issue) => {
        const root = anchored(35, 5, issueStatus === undefined ? {} : { issue_status: issueStatus });

        const threads = buildThreads({ all: [root], active: [root] });

        expect(threads[0]?.root.issue).toBe(issue);
    });

    it.each([
        ['resolved', true],
        ['dropped', true],
        ['open', false],
        ['not_issue', false],
        [undefined, false],
    ] as const)('issue_status=%s даёт resolved=%s у комментария', (issueStatus, resolved) => {
        const root = anchored(36, 5, issueStatus === undefined ? {} : { issue_status: issueStatus });

        const threads = buildThreads({ all: [root], active: [root] });

        expect(threads[0]?.root.resolved).toBe(resolved);
    });

    it('тред закрыт, когда закрыты все его issue', () => {
        const root = anchored(37, 5, {
            issue_status: 'resolved',
            updated_at: '2026-08-20T12:00:00.000000Z',
            status_updated_by: { name: 'carol' },
        });
        const reply = comment(38, {
            reply_to_id: 37,
            issue_status: 'dropped',
            updated_at: '2026-08-20T13:00:00.000000Z',
            status_updated_by: { name: 'bob' },
        });

        const threads = buildThreads({ all: [root, reply], active: [root, reply] });

        expect(threads[0]?.resolved).toBe(true);
        // Подпись — последнего закрывшего, а не корня треда.
        expect(threads[0]?.resolvedBy).toBe('bob');
    });

    it('открытый issue в ответе держит тред открытым', () => {
        const root = anchored(39, 5, { issue_status: 'resolved', status_updated_by: { name: 'carol' } });
        const reply = comment(40, { reply_to_id: 39, issue_status: 'open' });

        const threads = buildThreads({ all: [root, reply], active: [root, reply] });

        expect(threads[0]?.resolved).toBe(false);
        expect(threads[0]?.resolvedBy).toBeNull();
    });

    it('тред без issue открыт, сколько бы комментариев в нём ни было', () => {
        const root = anchored(42, 5, { issue_status: 'not_issue' });
        const reply = comment(43, { reply_to_id: 42 });

        const threads = buildThreads({ all: [root, reply], active: [root, reply] });

        expect(threads[0]?.resolved).toBe(false);
        expect(threads[0]?.root.resolved).toBe(false);
    });

    it('черновик — комментарий без published_at', () => {
        const draft = comment(31, { published_at: undefined, draft: true });
        const published = comment(32);

        const threads = buildThreads({ all: [draft, published], active: [draft, published] });

        expect(threads.map((thread) => thread.root.draft)).toEqual([true, false]);
    });

    it('нулевая строка якоря — комментарий на файл целиком', () => {
        const broken = anchored(41, 0);

        const threads = buildThreads({ all: [broken], active: [broken] });

        expect(threads[0]?.anchor).toMatchObject({ path: 'src/a.ts', position: null });
    });

    it('размер якоря по умолчанию — одна строка', () => {
        const withoutSize = comment(51, {
            anchor: {
                review_request: {
                    diff: { file: { entry_id: 'eid:b', path: 'src/b.ts', position: { side: 'old', line: 4 } } },
                },
            },
        });

        const threads = buildThreads({ all: [withoutSize], active: [withoutSize] });

        expect(threads[0]?.anchor?.position).toEqual({ side: 'old', line: 4, size: 1 });
    });
});

describe('пользователь Арканума', () => {
    it('человек — фото со Стаффа, логин в URL экранирован', () => {
        expect(arcanumUser('alice', 'Алиса', false).avatarUrl).toBe(
            'https://center.yandex-team.ru/api/v1/user/alice/avatar/100.jpg',
        );
        const odd = arcanumUser('a/b?c#d', null, false);
        expect(odd.avatarUrl).toBe('https://center.yandex-team.ru/api/v1/user/a%2Fb%3Fc%23d/avatar/100.jpg');
        expect(() => reviewUserSchema.parse(odd)).not.toThrow();
    });

    it('у робота фото со Стаффа тоже есть', () => {
        expect(arcanumUser('robot-example-reviewer', 'Example AI Review', true).avatarUrl).toBe(
            'https://center.yandex-team.ru/api/v1/user/robot-example-reviewer/avatar/100.jpg',
        );
    });

    it('автор комментария собирается тем же хелпером', () => {
        const threads = buildThreads({ all: [comment(1)], active: [comment(1)] });
        expect(threads[0]?.root.author).toEqual(arcanumUser('alice', null, false));
    });
});
