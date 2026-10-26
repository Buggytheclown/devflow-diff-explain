import type { PrMeta } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { breadcrumbFor } from '../pr-key.js';
import { AgentPill, TopBar } from './top-bar.tsx';
import { createT } from '../i18n/index.js';

const t = createT('ru');

const PR: PrMeta = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Окно редактирования заказа',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'users/alice/edit-window',
    toBranch: 'trunk',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

function topBar(pr: typeof PR | null): string {
    return renderToStaticMarkup(
        <TopBar
            version="0.0.0"
            breadcrumb={breadcrumbFor('arcanum-4821', pr)}
            agent={agentPillView({ kind: 'never' }, [], t)}
            reconnectCommand="/sherpa arcanum-4821"
            chatOpen={false}
            onToggleChat={() => undefined}
            view="overview"
            onSelectView={() => undefined}
            onOpenSearch={() => undefined}
            agentConnected
            onReplayTour={() => undefined}
            feedback={{ available: true, reason: null }}
            feedbackContext={{
                uiVersion: '0.0.0',
                prKey: 'arcanum-4821',
                view: 'overview',
                routePhase: 'ready',
                worker: { kind: 'never' },
            }}
            onSendFeedback={() =>
                Promise.resolve({
                    outcome: 'created',
                    issueKey: 'EXAMPLE-1',
                    issueUrl: 'https://st.yandex-team.ru/EXAMPLE-1',
                    message: null,
                })
            }
        />,
    );
}

describe('верхняя панель', () => {
    it('рендерит кнопку Feedback после поиска', () => {
        const html = topBar(PR);

        expect(html).toContain('class="ctl ctl--ghost ctl--topbar search-button"');
        expect(html).toContain('class="ctl ctl--ghost ctl--topbar feedback-button"');
        expect(html.indexOf('search-button')).toBeLessThan(html.indexOf('feedback-button'));
    });
});

describe('брендкрамб верхней панели', () => {
    it('последний сегмент — ссылка на PR у хоста', () => {
        expect(topBar(PR)).toContain(
            '<a class="top-bar__breadcrumb-item" href="https://github.com/quillmart/quillmart/pull/4821">PR 4821</a>',
        );
    });

    it('до прихода меты — запасной текст из ключа PR', () => {
        const html = topBar(null);

        expect(html).toContain('<span class="top-bar__breadcrumb-item">PR 4821</span>');
        expect(html).not.toContain('<a class="top-bar__breadcrumb-item"');
    });
});

describe('поповер индикатора агента', () => {
    it('для never открывает reconnect-команду по disconnected-тону', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('Подключить агента');
        expect(html).toContain('/sherpa fixture-medium');
    });

    it('объясняет отключение агента: читалка работает полностью', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('Читалка работает полностью');
        expect(html).toContain('ИИ-зоны остались только для чтения.');
    });

    it('у подключённого агента нет reconnect-поповера и старой заглушки чата', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView(
                    {
                        kind: 'connected',
                        workerId: 'w-1',
                        harness: 'claude-code',
                        model: 'opus-5',
                        registeredAt: '2026-08-24T10:30:00.000Z',
                        lastSeenAt: '2026-08-24T11:59:00.000Z',
                    },
                    [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).not.toContain('Читалка работает полностью');
        expect(html).not.toContain('agent-popover');
    });
});
