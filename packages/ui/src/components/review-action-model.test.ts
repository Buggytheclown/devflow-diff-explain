import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';
import {
    availableShipMode,
    draftsCounterKey,
    isShipVerdict,
    noDraftsKey,
    partialPublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
    shipModeOf,
    shipModesOf,
    shipOptionDisabledKey,
} from './review-action-model.js';

const t = createT('ru');

describe('модель плавающей панели', () => {
    it('гардит публикацию на несохранённом черновике, потере связи и запросе в полёте', () => {
        expect(publishDisabledReason({ t, connection: 'online', pendingComposer: true, publishing: false })).toBe(
            'есть несохранённый текст',
        );
        expect(
            publishDisabledReason({ t, connection: 'reconnecting', pendingComposer: false, publishing: false }),
        ).toBe('нет связи с сервером');
        expect(publishDisabledReason({ t, connection: 'online', pendingComposer: false, publishing: true })).toBe(
            'публикуется…',
        );
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                publishing: false,
                failure: true,
            }),
        ).toBe('сначала повторите предыдущую публикацию');
        expect(
            publishDisabledReason({ t, connection: 'online', pendingComposer: false, publishing: false }),
        ).toBeNull();
    });

    // Буфер черновиков: публиковать нечего, пока хост не принял текст.
    it('гардит публикацию на недовезённых черновиках буфера', () => {
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 2,
                publishing: false,
            }),
        ).toBe('2 черновика ещё не отправлены — ship недоступен, пока не сохранятся');
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 1,
                publishing: false,
            }),
        ).toBe('1 черновик ещё не отправлен — ship недоступен, пока не сохранится');
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 0,
                publishing: false,
            }),
        ).toBeNull();
    });

    it('режимы сплит-кнопки — ship, sticky и comment из режимов PR, в порядке меню', () => {
        expect(shipModesOf(['request_changes', 'comment', 'sticky_ship', 'ship'])).toEqual([
            'ship',
            'sticky_ship',
            'comment',
        ]);
        expect(shipModesOf(['comment'])).toEqual(['comment']);
    });

    it('действующий режим: сохранённый, иначе ship, иначе comment', () => {
        const all = shipModesOf(['comment', 'ship', 'sticky_ship', 'request_changes']);
        expect(availableShipMode('sticky_ship', all)).toBe('sticky_ship');
        expect(availableShipMode('comment', all)).toBe('comment');
        expect(availableShipMode('sticky_ship', ['ship', 'comment'])).toBe('ship');
        // Своего PR на GitHub и локального ревью шип не касается вовсе.
        expect(availableShipMode('ship', ['comment'])).toBe('comment');
        expect(availableShipMode('sticky_ship', ['comment'])).toBe('comment');
        // Без comment режимы решает хост; нет ни одного — нет и кнопки.
        expect(availableShipMode('comment', ['ship', 'sticky_ship'])).toBe('ship');
        expect(availableShipMode('comment', ['sticky_ship'])).toBe('sticky_ship');
        expect(availableShipMode('ship', [])).toBeNull();
    });

    it('запоминаются режимы сплит-кнопки, Request changes — нет', () => {
        expect(shipModeOf('ship')).toBe('ship');
        expect(shipModeOf('sticky_ship')).toBe('sticky_ship');
        expect(shipModeOf('comment')).toBe('comment');
        expect(shipModeOf('request_changes')).toBeNull();
    });

    it('шип — только ship и sticky_ship', () => {
        expect(isShipVerdict('ship')).toBe(true);
        expect(isShipVerdict('sticky_ship')).toBe(true);
        expect(isShipVerdict('comment')).toBe(false);
        expect(isShipVerdict('request_changes')).toBe(false);
    });

    it('строка меню выключена вне режимов хоста, Comment — без черновиков', () => {
        const modes = shipModesOf(['comment', 'ship', 'request_changes']);
        expect(shipOptionDisabledKey('ship', modes, 0, 'pr')).toBeNull();
        expect(shipOptionDisabledKey('sticky_ship', modes, 2, 'pr')).toBe('ship.mode.sticky.unavailable');
        expect(shipOptionDisabledKey('ship', ['sticky_ship', 'comment'], 2, 'pr')).toBe('ship.mode.ship.unavailable');
        expect(shipOptionDisabledKey('comment', modes, 1, 'pr')).toBeNull();
        expect(shipOptionDisabledKey('comment', modes, 0, 'pr')).toBe('ship.noDrafts');
        expect(shipOptionDisabledKey('comment', ['comment'], 0, 'agent')).toBe('ship.noDraftsForAgent');
        expect(shipOptionDisabledKey('comment', ['ship'], 2, 'pr')).toBe('ship.mode.comment.unavailable');
    });

    it('показывает точное следствие команды с числом черновиков', () => {
        expect(t(publishConsequenceKey('comment', 'pr'), 3)).toBe('Опубликует 3 черновика без вердикта');
        expect(createT('en')(publishConsequenceKey('comment', 'pr'), 1)).toBe('Publishes 1 draft without a verdict');
        expect(t(publishConsequenceKey('request_changes', 'pr'), 2)).toBe('Опубликует 2 черновика и запросит изменения');
        expect(t(publishConsequenceKey('ship', 'pr'), 1)).toBe('Опубликует 1 черновик и одобрит снапшот');
        expect(createT('en')(publishConsequenceKey('ship', 'pr'), 1)).toBe('Publishes 1 draft and approves the snapshot');
    });

    it('на локальном хосте comment передаёт черновики агенту', () => {
        expect(t(publishConsequenceKey('comment', 'agent'), 5)).toBe('Передаст 5 черновиков агенту');
        expect(createT('en')(publishConsequenceKey('comment', 'agent'), 1)).toBe('Hands 1 draft to the agent');
        // Локальное ревью с `--verdicts`: вердикт тоже уходит агенту, а не публикуется в PR.
        expect(t(publishConsequenceKey('ship', 'agent'), 1)).toBe('Передаст 1 черновик агенту и одобрит изменения');
        expect(createT('en')(publishConsequenceKey('request_changes', 'agent'), 2)).toBe(
            'Hands 2 drafts to the agent and requests changes',
        );
        expect(t(draftsCounterKey('agent'), 2)).toBe('2 черновика уйдут агенту');
        expect(createT('en')(draftsCounterKey('agent'), 1)).toBe('1 draft goes to the agent');
        expect(t(draftsCounterKey('pr'), 1)).toBe('1 черновик уйдёт при публикации');
        expect(t(noDraftsKey('agent'))).toBe('нет комментариев для агента');
        expect(createT('en')(noDraftsKey('agent'))).toBe('no comments for the agent');
    });

    it('частичный провал сохраняет список комментариев и не превращается в успех', () => {
        const failure = partialPublicationFailure(
            'ship',
            {
                publishedCommentIds: ['ok'],
                failed: [{ commentId: 'bad', message: 'Арканум отказал' }],
                verdictApplied: false,
            },
            new Map([['bad', 'Нужно исправить границу']]),
            t,
        );

        expect(failure).toEqual({
            verdict: 'ship',
            failedCount: 1,
            comments: [{ commentId: 'bad', message: 'Арканум отказал', body: 'Нужно исправить границу' }],
            message: null,
        });
        expect(
            partialPublicationFailure(
                'ship',
                { publishedCommentIds: [], failed: [], verdictApplied: true },
                new Map(),
                t,
            ),
        ).toBeNull();
    });

    it('сетевой провал оставляет тот же вердикт для явного ретрая', () => {
        const error = new Error('сервер недоступен');
        expect(requestPublicationFailure('sticky_ship', 3, error)).toMatchObject({
            verdict: 'sticky_ship',
            failedCount: 3,
            message: 'сервер недоступен',
        });
    });
});
