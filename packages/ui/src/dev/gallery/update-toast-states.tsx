import { fixtureIteration } from '@sherpa/fixtures';
import type { UiUpdate } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { TopBar } from '../../components/top-bar.tsx';
import { UpdateToast } from '../../components/update-toast.tsx';
import { useT } from '../../i18n/index.js';
import { breadcrumbFor } from '../../pr-key.js';

/**
 * Тост обновления и версия-кнопка в топбаре. Данные статические:
 * галерея рисуется без сервера, а проверка версии в ней и не запускалась бы.
 */

const CURRENT = '0.4.0';
const LATEST = '0.5.0';

const WHATS_NEW = 'Тост обновления, читшит шорткатов и английский интерфейс — язык берётся от агента.';

const ARC_CHECKOUT: UiUpdate = {
    current: CURRENT,
    latest: LATEST,
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: WHATS_NEW,
    install: {
        kind: 'arc-checkout',
        dir: '/Users/x/arc/arcadia',
        command: "cd '/Users/x/arc/arcadia' && arc pull",
    },
};

const COPY: UiUpdate = {
    ...ARC_CHECKOUT,
    install: { kind: 'copy', dir: '/Users/x/tools/sherpa/skill', command: null },
};

const MEDIUM = fixtureIteration('medium');

const WORKER = {
    kind: 'connected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
} as const;

/**
 * Тост в галерее стоит в потоке, а не в углу экрана: у карточки состояния свои границы,
 * `position: fixed` вырвал бы его на весь вьюпорт.
 */
function Framed({ children }: { children: ReactNode }) {
    return <div className="update-toast-frame">{children}</div>;
}

function UpdateTopBarState() {
    const t = useT();
    return (
        <TopBar
            version={CURRENT}
            update={ARC_CHECKOUT}
            onOpenUpdate={() => undefined}
            breadcrumb={breadcrumbFor('fixture-medium', MEDIUM.pr)}
            agent={agentPillView(WORKER, [], t)}
            reconnectCommand={reconnectCommand('fixture-medium')}
            chatOpen={false}
            onToggleChat={() => undefined}
            view="route"
            onSelectView={() => undefined}
            onOpenSearch={() => undefined}
            agentConnected
            onReplayTour={() => undefined}
            feedback={{ available: true, reason: null }}
            feedbackContext={{
                uiVersion: CURRENT,
                prKey: 'fixture-medium',
                view: 'route',
                routePhase: 'ready',
                worker: WORKER,
            }}
            onSendFeedback={() =>
                Promise.resolve({ outcome: 'created', issueKey: null, issueUrl: null, message: null })
            }
        />
    );
}

export const UPDATE_TOAST_STATES: readonly { readonly id: string; readonly title: string; readonly render: () => ReactNode }[] =
    [
        {
            id: 'update-toast-arc-checkout',
            title: 'чекаут Аркадии',
            render: () => (
                <Framed>
                    <UpdateToast update={ARC_CHECKOUT} onLater={() => undefined} onDismissVersion={() => undefined} />
                </Framed>
            ),
        },
        {
            id: 'update-toast-copy',
            title: 'копия каталога',
            render: () => (
                <Framed>
                    <UpdateToast update={COPY} onLater={() => undefined} onDismissVersion={() => undefined} />
                </Framed>
            ),
        },
        {
            id: 'update-toast-how',
            title: '«Как обновить» раскрыт',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={ARC_CHECKOUT}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        howToOpen
                    />
                </Framed>
            ),
        },
        {
            id: 'update-toast-no-motion',
            title: 'без анимации входа',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={ARC_CHECKOUT}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        noMotion
                    />
                </Framed>
            ),
        },
        {
            id: 'update-top-bar-dot',
            title: 'версия с точкой обновления',
            render: () => <UpdateTopBarState />,
        },
    ];
