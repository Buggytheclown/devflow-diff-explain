import { fixtureIteration } from '@sherpa/fixtures';
import type { UiTask, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { LocaleProvider, useT } from '../../i18n/index.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { SettingsMenu } from '../../components/settings-menu.tsx';
import { AgentPill, TopBar } from '../../components/top-bar.tsx';
import { breadcrumbFor } from '../../pr-key.js';
import type { ViewId } from '../../session/views.js';
import { SettingsProvider } from '../../settings/context.tsx';
import { useResolvedTheme } from '../../settings/document-settings.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { UI_VERSION } from '../../version.js';
import { MARKDOWN_STATES } from './markdown-states.tsx';
import { DIFF_STATES } from './diff-states.tsx';
import { SYNTAX_STATES } from './syntax-states.tsx';
import { FULL_DIFF_STATES } from './full-diff-states.tsx';
import { REVIEW_COMPLETION_STATES } from './review-completion-states.tsx';
import { OVERVIEW_STATES } from './overview-states.tsx';
import { ROUTE_STATES } from './route-states.tsx';
import { ROUTE_COVERAGE_STATES } from './route-coverage-states.tsx';
import { ROUTE_PRESET_STATES } from './route-presets-states.tsx';
import { ROUTE_DIGEST_STATES } from './route-digest-states.tsx';
import { ROUTE_GENERATION_STATES } from './route-generation-states.tsx';
import { ROUTE_BADGE_STATES } from './route-badges-states.tsx';
import { ROUTE_LONG_PATH_STATES } from './route-long-paths-states.tsx';
import { FILTER_STATES } from './filters-states.tsx';
import { COMMENT_COMPOSER_STATES } from './comment-composer-states.tsx';
import { ROUTE_REBUILD_STATES } from './route-rebuild-states.tsx';
import { PR_COMMENTS_STATES } from './pr-comments-states.tsx';
import { CODE_THREAD_STATES } from './code-threads-states.tsx';
import { LINE_COMMENT_STATES } from './line-comments-states.tsx';
import { ROUTE_STOP_FAILURE_STATES } from './route-stop-failure-states.tsx';
import { SELECTION_POPOVER_STATES } from './selection-popover-states.tsx';
import { CHAT_PANEL_STATES } from './chat-panel-states.tsx';
import { AGENT_NOTE_STATES } from './agent-notes-states.tsx';
import { AGENT_NOTE_DRAFT_STATES } from './agent-note-draft-states.tsx';
import { AGENT_ASK_DIFF_STATES, AGENT_ASK_ROUTE_STATES } from './agent-ask-states.tsx';
import { ITERATION_SECOND_PASS_STATES } from './iterations-second-pass-states.tsx';
import { ITERATION_SNAPSHOT_STATES } from './iterations-snapshots-states.tsx';
import { ITERATION_PINNED_THREAD_STATES } from './iterations-pinned-threads-states.tsx';
import { ITERATION_LOST_NOTE_STATES } from './iterations-lost-notes-states.tsx';
import { ITERATION_SLICE_STATES } from './iterations-slice-states.tsx';
import { SHORTCUT_STATES } from './shortcuts-states.tsx';
import { ROUTE_LOCALE_STATES } from './route-locale-states.tsx';
import { ONBOARDING_STATES } from './onboarding-states.tsx';
import { UPDATE_TOAST_STATES } from './update-toast-states.tsx';
import { LIMIT_STATES } from './limits-states.tsx';
import { DRAFT_BUFFER_STATES } from './draft-buffer-states.tsx';
import { DISCUSSION_STATES } from './discussion-states.tsx';
import { FILE_MENU_STATES } from './file-menu-states.tsx';
import { REVIEW_BAR_CHAT_DOCK_STATES } from './review-bar-chat-dock-states.tsx';
import { IMAGE_VIEWER_STATES } from './image-viewer-states.tsx';
import { PALETTE_STATES } from './palette-states.tsx';
import { STORY_STATES, GUIDED_STORY_STATES } from './story-states.tsx';
import { CONTROL_STATES } from './control-states.tsx';
import { LayoutWidths, TokenSwatches, TypographyScale } from './tokens-showcase.tsx';

/**
 * Реестр состояний галереи: каждое состояние рендерится детерминированно, без сервера
 * и без токена, на фикстурах `@sherpa/fixtures`.
 *
 * Добавить состояние = добавить одну запись в этот массив.
 */
export interface GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const MEDIUM = fixtureIteration('medium');

const CONNECTED = {
    kind: 'connected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
} as const;

const TASK = {
    type: 'echo',
    priority: 'interactive',
    attempt: 1,
    instructions: 'echo',
    progressText: null,
    result: null,
    failReason: null,
    createdAt: '2026-08-21T11:00:00.000Z',
    updatedAt: '2026-08-21T11:00:00.000Z',
} as const;

const AGENT_STATES = [
    { id: 'connected', title: 'подключён', worker: CONNECTED, tasks: [] },
    {
        id: 'working',
        title: 'работает',
        worker: CONNECTED,
        tasks: [
            { ...TASK, id: 1, status: 'leased', heldByWorker: true },
            { ...TASK, id: 2, status: 'queued', heldByWorker: false },
        ],
    },
    {
        id: 'failed',
        title: 'последняя задача упала',
        worker: CONNECTED,
        tasks: [{ ...TASK, id: 1, status: 'failed', heldByWorker: false }],
    },
    {
        id: 'disconnected',
        title: 'отключён',
        worker: { ...CONNECTED, kind: 'disconnected' },
        tasks: [],
    },
] as const;

/** Брендкрамб фикстурного PR: хост из ключа PR, последний сегмент — ссылка из меты. */
const MEDIUM_BREADCRUMB = breadcrumbFor('fixture-medium', MEDIUM.pr);

/**
 * Галерея открывается тем же, что видит ревьюер при старте приложения (`DEFAULT_VIEW` — Обзор),
 * поэтому это состояние стоит первым; остальной порядок реестра прежний.
 */
const START_STATE_ID = 'overview-ownership';

const ITERATION_STATES = [
    ...ITERATION_SECOND_PASS_STATES,
    ...ITERATION_SNAPSHOT_STATES,
    ...ITERATION_PINNED_THREAD_STATES,
    ...ITERATION_LOST_NOTE_STATES,
    ...ITERATION_SLICE_STATES,
];

export const GALLERY_STATES: readonly GalleryState[] = [
    ...STORY_STATES,
    ...GUIDED_STORY_STATES,
    ...OVERVIEW_STATES.filter((state) => state.id === START_STATE_ID),
    ...AGENT_STATES.map((state) => ({
        id: `agent-${state.id}`,
        group: 'Индикатор агента',
        title: state.title,
        render: () => <AgentPillState worker={state.worker} tasks={state.tasks} />,
    })),
    {
        id: 'top-bar',
        group: 'Верхняя панель',
        title: 'целиком, фикстурный PR',
        render: () => <TopBarState />,
    },
    {
        id: 'settings-menu',
        group: 'Меню настроек',
        title: 'закрытое',
        render: () => <SettingsMenuState />,
    },
    {
        id: 'settings-menu-open',
        group: 'Меню настроек',
        title: 'открытое',
        render: () => <SettingsMenuState open />,
    },
    {
        id: 'settings-menu-open-offline',
        group: 'Меню настроек',
        title: 'открытое, агента нет — 7 шагов',
        render: () => <SettingsMenuState open agentConnected={false} />,
    },
    {
        id: 'settings-menu-open-ru',
        group: 'Меню настроек',
        title: 'открытое, русский',
        render: () => (
            <LocaleProvider locale="ru">
                <SettingsMenuState open />
            </LocaleProvider>
        ),
    },
    {
        id: 'settings-menu-open-light',
        group: 'Меню настроек',
        title: 'открытое, светлая тема',
        render: () => <SettingsMenuThemedState theme="light" arcanum={false} />,
    },
    {
        id: 'settings-menu-open-arcanum-dark',
        group: 'Меню настроек',
        title: 'открытое, Темная Arcanum',
        render: () => <SettingsMenuThemedState theme="dark" arcanum />,
    },
    {
        id: 'settings-menu-open-arcanum-light',
        group: 'Меню настроек',
        title: 'открытое, Светлая Arcanum',
        render: () => <SettingsMenuThemedState theme="light" arcanum />,
    },
    ...OVERVIEW_STATES.filter((state) => state.id !== START_STATE_ID),
    ...REVIEW_COMPLETION_STATES,
    ...SHORTCUT_STATES,
    ...DRAFT_BUFFER_STATES,
    ...REVIEW_BAR_CHAT_DOCK_STATES,
    ...FILTER_STATES.map((state) => ({
        id: state.id,
        group: 'Фильтры',
        title: state.title,
        render: state.render,
    })),
    ...COMMENT_COMPOSER_STATES.map((state) => ({
        id: state.id,
        group: 'Композер комментария',
        title: state.title,
        render: state.render,
    })),
    ...PR_COMMENTS_STATES.map((state) => ({
        id: state.id,
        group: 'Комментарии к PR',
        title: state.title,
        render: state.render,
    })),
    ...LINE_COMMENT_STATES.map((state) => ({
        id: state.id,
        group: 'Комментарии к строке',
        title: state.title,
        render: state.render,
    })),
    ...CODE_THREAD_STATES.map((state) => ({
        id: state.id,
        group: 'Треды у кода',
        title: state.title,
        render: state.render,
    })),
    ...[...DIFF_STATES, ...MARKDOWN_STATES].map((state) => ({
        id: state.id,
        group: 'Дифф',
        title: state.title,
        render: state.render,
    })),
    ...SYNTAX_STATES.map((state) => ({
        id: state.id,
        group: 'Подсветка синтаксиса',
        title: state.title,
        render: state.render,
    })),
    ...SELECTION_POPOVER_STATES.map((state) => ({
        id: state.id,
        group: 'Поповер выделения',
        title: state.title,
        render: state.render,
    })),
    ...CHAT_PANEL_STATES.map((state) => ({
        id: state.id,
        group: 'Чат с агентом',
        title: state.title,
        render: state.render,
    })),
    ...AGENT_NOTE_STATES.map((state) => ({
        id: state.id,
        group: 'Заметки агента',
        title: state.title,
        render: state.render,
    })),
    ...AGENT_NOTE_DRAFT_STATES.map((state) => ({
        id: state.id,
        group: 'Заметки агента',
        title: state.title,
        render: state.render,
    })),
    ...[...FULL_DIFF_STATES, ...AGENT_ASK_DIFF_STATES].map((state) => ({
        id: state.id,
        group: 'Полный дифф',
        title: state.title,
        render: state.render,
    })),
    ...[
        ...ROUTE_STATES,
        ...ROUTE_COVERAGE_STATES,
        ...ROUTE_PRESET_STATES,
        ...ROUTE_DIGEST_STATES,
        ...ROUTE_GENERATION_STATES,
        ...ROUTE_BADGE_STATES,
        ...ROUTE_LONG_PATH_STATES,
        ...ROUTE_REBUILD_STATES,
        ...ROUTE_STOP_FAILURE_STATES,
        ...AGENT_ASK_ROUTE_STATES,
    ].map((state) => ({
        id: state.id,
        group: 'Маршрут',
        title: state.title,
        render: state.render,
    })),
    ...ITERATION_STATES.map((state) => ({
        id: state.id,
        group: 'Итерации',
        title: state.title,
        render: state.render,
    })),
    ...PALETTE_STATES.map((state) => ({
        id: state.id,
        group: 'Командная палитра',
        title: state.title,
        render: state.render,
    })),
    ...ONBOARDING_STATES.map((state) => ({
        id: state.id,
        group: 'Онбординг',
        title: state.title,
        render: state.render,
    })),
    ...UPDATE_TOAST_STATES.map((state) => ({
        id: state.id,
        group: 'Обновление',
        title: state.title,
        render: state.render,
    })),
    ...ROUTE_LOCALE_STATES.map((state) => ({
        id: state.id,
        group: 'Язык маршрута',
        title: state.title,
        render: state.render,
    })),
    ...LIMIT_STATES.map((state) => ({
        id: state.id,
        group: 'Лимиты и деградации',
        title: state.title,
        render: state.render,
    })),
    ...DISCUSSION_STATES.map((state) => ({
        id: state.id,
        group: 'Обсуждение на Обзоре',
        title: state.title,
        render: state.render,
    })),
    ...FILE_MENU_STATES.map((state) => ({
        id: state.id,
        group: 'Файлы',
        title: state.title,
        render: state.render,
    })),
    ...IMAGE_VIEWER_STATES.map((state) => ({
        id: state.id,
        group: 'Картинки',
        title: state.title,
        render: state.render,
    })),
    ...CONTROL_STATES,
    {
        id: 'tokens-swatches',
        group: 'Токены',
        title: 'свотчи',
        render: () => <TokenSwatches />,
    },
    {
        id: 'tokens-typography',
        group: 'Токены',
        title: 'шкала типографики',
        render: () => <TypographyScale />,
    },
    {
        id: 'tokens-widths',
        group: 'Токены',
        title: 'ширины и потолок код-панелей',
        render: () => <LayoutWidths />,
    },
];

function AgentPillState({ worker, tasks }: { worker: WorkerStatus; tasks: readonly UiTask[] }) {
    const t = useT();
    return (
        <AgentPill view={agentPillView(worker, tasks, t)} reconnectCommand={reconnectCommand('fixture-medium')} />
    );
}

/**
 * Меню настроек стенда: обёртка прижимает триггер вправо — панель раскрывается от его правого
 * края, и у левого края холста она уехала бы за кадр.
 */
function SettingsMenuState({ open = false, agentConnected = true }: { open?: boolean; agentConnected?: boolean }) {
    return (
        <div className="gallery-settings-menu">
            <SettingsMenu
                agentConnected={agentConnected}
                onOpenCommands={() => undefined}
                onReplayTour={() => undefined}
                defaultOpen={open}
            />
        </div>
    );
}

/**
 * То же меню в выбранном оформлении независимо от переключателя стенда: `data-theme` стоит
 * на самой карточке, а не на `<html>` — токены цепляются к любому поддереву (docs/design/theme.md).
 * Стенд вокруг остаётся в своей теме, и переключатель темы стенда с карточкой не спорит.
 */
function SettingsMenuThemedState({ theme, arcanum }: { theme: 'dark' | 'light'; arcanum: boolean }) {
    const [settings] = useState(() =>
        createUiSettingsStore({ loaded: true, initial: { theme, arcanum } }),
    );
    return (
        <SettingsProvider store={settings}>
            <SettingsMenuThemedContent />
        </SettingsProvider>
    );
}

/** Переключатели внутри карточки меняют её палитру, не затрагивая оформление стенда. */
function SettingsMenuThemedContent() {
    const theme = useResolvedTheme();
    return (
        <div data-theme={theme} className="gallery-themed">
            <SettingsMenuState open />
        </div>
    );
}

/** Табы в галерее живые: иначе их выбранное состояние не с чем сравнить. */
function TopBarState() {
    const t = useT();
    const [view, setView] = useState<ViewId>('route');

    return (
        <TopBar
            version={UI_VERSION}
            breadcrumb={MEDIUM_BREADCRUMB}
            agent={agentPillView(CONNECTED, [], t)}
            reconnectCommand={reconnectCommand('fixture-medium')}
            chatOpen={false}
            onToggleChat={() => undefined}
            view={view}
            onSelectView={setView}
            onOpenSearch={() => undefined}
            agentConnected
            onReplayTour={() => undefined}
            feedback={{ available: true, reason: null }}
            feedbackContext={{
                uiVersion: UI_VERSION,
                prKey: 'fixture-medium',
                view,
                routePhase: 'ready',
                worker: CONNECTED,
            }}
            onSendFeedback={() =>
                Promise.resolve({
                    outcome: 'created',
                    issueKey: 'EXAMPLE-123456',
                    issueUrl: 'https://st.yandex-team.ru/EXAMPLE-123456',
                    message: null,
                })
            }
        />
    );
}
