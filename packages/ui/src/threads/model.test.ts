import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import {
    flattenThread,
    groupThreads,
    isPrLevelThread,
    placeThreadsOnVisibleLines,
    positionLastLine,
    prLevelThreads,
    threadAtLines,
    threadFileId,
    threadCommentCount,
    threadHasAuthor,
    threadHasDraft,
    threadIsVisible,
    threadResolvedByIssues,
} from './model.js';

describe('модель тредов', () => {
    it('сплющивает ветвящееся дерево, считает поддерево и ограничивает отступ', () => {
        const deep = fixtureIteration('medium').threads[0];
        if (deep === undefined) {
            throw new Error('в фикстуре нет глубокого треда');
        }

        const rows = flattenThread(deep.root);

        expect(rows[0]?.subtreeReplies).toBe(rows.length - 1);
        // Отступ — 27px на уровень ответа, потолок на четвёртом (108px); глубже вместо отступа «↳ кому».
        expect(rows.map((row) => row.indent).slice(0, 6)).toEqual([0, 27, 54, 81, 108, 108]);
        expect(rows.every((row) => (row.depth > 5) === (row.replyHintAuthor !== null))).toBe(true);
        expect(rows.filter((row) => row.parent?.id === '4820158')).toHaveLength(2);
    });

    it('оставляет outside только ботам уровня PR и неизвестным файлам', () => {
        const data = fixtureIteration('medium');
        const known = new Set(data.diff.files.slice(0, 2).map((file) => file.fileId));

        const grouped = groupThreads(data.threads, known);

        expect(grouped.outside.every((thread) => thread.anchor !== null || thread.root.author.bot)).toBe(true);
        expect([...grouped.byFile.keys()].every((fileId) => known.has(fileId))).toBe(true);
    });

    it('отделяет PR-level комментарии людей от ботов и исчезнувших файлов, включая черновик', () => {
        const source = fixtureIteration('medium').threads[0];
        if (source === undefined) {
            throw new Error('в фикстуре нет треда');
        }
        const published = {
            ...source,
            id: 'pr-published',
            anchor: null,
            root: { ...source.root, id: 'pr-published-root', draft: false, author: { ...source.root.author, bot: false } },
        };
        const draft = {
            ...published,
            id: 'pr-draft',
            root: { ...published.root, id: 'pr-draft-root', draft: true },
        };
        const bot = {
            ...published,
            id: 'pr-bot',
            root: { ...published.root, id: 'pr-bot-root', author: { ...published.root.author, bot: true } },
        };
        const disappeared = {
            ...published,
            id: 'disappeared-file',
            anchor: { fileId: 'missing-file', path: 'removed.ts', position: null },
            root: { ...published.root, id: 'disappeared-file-root' },
        };

        expect(isPrLevelThread(published)).toBe(true);
        expect(isPrLevelThread(disappeared)).toBe(false);
        // Модалка PR показывает и бот-треды: у них тоже есть Resolve и ответ (§4).
        expect(prLevelThreads([published, draft, bot, disappeared]).map((thread) => thread.id)).toEqual([
            'pr-published',
            'pr-draft',
            'pr-bot',
        ]);
        expect(prLevelThreads([draft])[0]?.root.draft).toBe(true);
        expect(groupThreads([published, draft, bot, disappeared], new Set()).outside.map((thread) => thread.id)).toEqual([
            'pr-bot',
            'disappeared-file',
        ]);
    });

    it('диапазон ставит тред под последней строкой по соглашению line + size', () => {
        const data = fixtureIteration('medium');
        const source = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (source?.anchor === null || source?.anchor === undefined) {
            throw new Error('в фикстуре нет позиционного треда');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === source.anchor?.fileId);
        if (file === undefined) {
            throw new Error('файл треда не найден');
        }
        const model = parseFileDiff(toParseRequest(file));
        const numbers =
            model.content.kind === 'text'
                ? model.content.blocks.flatMap((block) =>
                      block.kind === 'hunk' ? block.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine])) : [],
                  )
                : [];
        const first = numbers.find((line) => numbers.includes(line + 1));
        if (first === undefined) {
            throw new Error('в фикстуре нет двух соседних новых строк');
        }
        const position = { side: 'new' as const, line: first, size: 2 };
        const ranged = { ...source, anchor: { ...source.anchor, position } };

        const placed = placeThreadsOnVisibleLines(model, [ranged]);

        expect(positionLastLine(position)).toBe(first + 1);
        expect(placed.byLine.get(`new:${String(first + 1)}`)).toEqual([ranged]);
    });

    it('якорь из скрытого контекста притягивает к ближайшей видимой строке', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (thread?.anchor === null || thread?.anchor === undefined) {
            throw new Error('в фикстуре нет позиционного треда');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === thread.anchor?.fileId);
        if (file === undefined) {
            throw new Error('файл треда не найден');
        }
        const model = parseFileDiff(toParseRequest(file));
        const hidden = { ...thread, anchor: { ...thread.anchor, position: { side: 'new' as const, line: 9999, size: 1 } } };

        const placed = placeThreadsOnVisibleLines(model, [hidden]);

        expect([...placed.byLine.values()].flat()).toEqual([hidden]);
        expect(placed.unplaced).toEqual([]);
    });

    it('возвращает fallback, когда нужной стороны в модели нет', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (thread?.anchor === null || thread?.anchor === undefined) {
            throw new Error('в фикстуре нет позиционного треда');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === thread.anchor?.fileId);
        if (file === undefined) {
            throw new Error('файл треда не найден');
        }
        const model = parseFileDiff(toParseRequest(file));
        const missingSide = {
            ...thread,
            anchor: { ...thread.anchor, position: { side: 'old' as const, line: 1, size: 1 } },
        };
        const onlyNew = {
            ...model,
            content:
                model.content.kind === 'text'
                    ? {
                          ...model.content,
                          blocks: model.content.blocks.map((block) =>
                              block.kind === 'hunk'
                                  ? {
                                        ...block,
                                        lines: block.lines.map((line) => ({ ...line, oldLine: null })),
                                    }
                                  : block,
                          ),
                      }
                    : model.content,
        };

        const placed = placeThreadsOnVisibleLines(onlyNew, [missingSide]);

        expect([...placed.byLine.values()]).toEqual([]);
        expect(placed.unplaced).toEqual([missingSide]);
    });

    it('линза по автору оставляет треды, где логин написал корень или любой ответ', () => {
        const threads = fixtureIteration('medium').threads;
        const root = threads[0];
        if (root === undefined) {
            throw new Error('в фикстуре нет тредов');
        }
        const replyAuthor = root.root.replies[0]?.author.login ?? null;
        if (replyAuthor === null || replyAuthor === root.root.author.login) {
            throw new Error('для теста нужен тред с ответом другого автора');
        }

        expect(threadHasAuthor(root, replyAuthor)).toBe(true);
        expect(threadIsVisible(root, replyAuthor)).toBe(true);
        expect(threadIsVisible(root, 'nobody')).toBe(false);
        // Линзы нет — виден каждый тред: фильтра источников больше не существует.
        expect(threadIsVisible(root)).toBe(true);
    });

    it('счётчик маркера считает все уровни, черновик в треде виден на любой глубине', () => {
        const thread = fixtureIteration('medium').threads.find((candidate) => candidate.root.replies.length > 0);
        if (thread === undefined) {
            throw new Error('в фикстуре нет треда с ответами');
        }

        expect(threadCommentCount(thread)).toBe(flattenThread(thread.root).length);
        expect(threadHasDraft(thread)).toBe(false);
        expect(
            threadHasDraft({
                ...thread,
                root: { ...thread.root, replies: [...thread.root.replies, { ...thread.root, id: 'd', draft: true }] },
            }),
        ).toBe(true);
    });

    it('правило resolved по комментариям: есть issue и все закрыты', () => {
        const base = fixtureIteration('large').threads;
        const withIssues = base.find((thread) => thread.root.issue === true && thread.root.resolved !== null);
        if (withIssues === undefined) {
            throw new Error('в фикстуре large нет треда с issue и резолвом по комментарию');
        }

        expect(threadResolvedByIssues(withIssues)).toBe(withIssues.root.resolved === true);
        // Хост без резолва по комментарию правило не применяет: у всех `resolved: null`.
        expect(
            threadResolvedByIssues({
                ...withIssues,
                root: { ...withIssues.root, resolved: null, replies: [] },
            }),
        ).toBeNull();
    });
});

describe('раскладка тредов в прошлой итерации', () => {
    const V1 = fixtureIteration('medium', 0);
    const V2 = fixtureIteration('medium', 1);
    const LAYOUT = {
        diffId: V1.diff.diffId,
        fileIdByPath: new Map(V1.diff.files.map((file) => [file.path, file.fileId])),
    };

    it('файл ищется по path: fileId активной итерации в старом диффе не совпадает', () => {
        const v1FileIds = new Set(V1.diff.files.map((file) => file.fileId));

        const handlers = V1.diff.files.find((file) => file.path === 'services/orders/src/api/handlers.ts');
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (handlers === undefined || outdated === undefined) {
            throw new Error('фикстуре medium нужен устаревший тред на handlers.ts');
        }

        // По `fileId` тред активной итерации своего файла в старом диффе не находит.
        const byFileId = groupThreads(V2.threads, v1FileIds);
        const byPath = groupThreads(V2.threads, v1FileIds, LAYOUT);

        expect(byFileId.byFile.get(handlers.fileId)).toBeUndefined();
        expect(byFileId.outside.map((thread) => thread.id)).toContain(outdated.id);
        expect(byPath.byFile.get(handlers.fileId)?.map((thread) => thread.id)).toContain(outdated.id);
        expect([...byPath.byFile.keys()].every((fileId) => v1FileIds.has(fileId))).toBe(true);
    });

    it('файл треда для прокрутки берётся из раскладки, а не из якоря активной итерации', () => {
        const handlers = V1.diff.files.find((file) => file.path === 'services/orders/src/api/handlers.ts');
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (handlers === undefined || outdated?.anchor == null) {
            throw new Error('фикстуре medium нужен устаревший тред на handlers.ts');
        }

        // Прокрутка к треду в старом диффе ищет карточку по этому же переводу: `anchor.fileId`
        // принадлежит активной итерации и в старом диффе не существует.
        expect(V1.diff.files.some((file) => file.fileId === outdated.anchor?.fileId)).toBe(false);
        expect(threadFileId(outdated, LAYOUT)).toBe(handlers.fileId);
        expect(threadFileId(outdated, null)).toBe(outdated.anchor.fileId);
    });

    it('файла с таким path в старой итерации нет — тред уходит в группу «вне диффа»', () => {
        const v1FileIds = new Set(V1.diff.files.map((file) => file.fileId));
        const alien = V2.threads.find((thread) => thread.anchor !== null);
        if (alien?.anchor == null) {
            throw new Error('в фикстуре нет треда с якорем');
        }
        const moved = { ...alien, anchor: { ...alien.anchor, path: 'services/orders/src/gone.ts' } };

        const grouped = groupThreads([moved], v1FileIds, LAYOUT);

        expect(grouped.byFile.size).toBe(0);
        expect(grouped.outside.map((thread) => thread.id)).toEqual([moved.id]);
    });

    it('у своих строк стоит только тред пина этой итерации, включая устаревший', () => {
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (outdated?.pinnedTo == null) {
            throw new Error('в фикстуре нет устаревшего треда с пином');
        }
        const alien = { ...outdated, pinnedTo: { diffId: 'другая-итерация', commit: 'deadbee' } };

        // В активной итерации устаревший якорь уводит тред под шапку файла.
        expect(threadAtLines(outdated, null)).toBe(false);
        // В итерации своего пина он стоит у кода, к которому написан.
        expect(threadAtLines(outdated, LAYOUT)).toBe(true);
        expect(threadAtLines(alien, LAYOUT)).toBe(false);
    });
});
