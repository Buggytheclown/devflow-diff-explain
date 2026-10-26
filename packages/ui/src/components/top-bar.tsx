import type { UiFeedbackAvailability, UiFeedbackRequest, UiFeedbackResponse, UiUpdate } from '@sherpa/protocol';
import { Fragment, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import type { BreadcrumbSegment } from '../pr-key.js';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import type { ViewId } from '../session/views.js';
import type { AgentPillView } from './agent-pill-view.js';
import type { ChatScrollTarget } from './chat-panel.tsx';
import { CommandBox } from './command-box.tsx';
import type { FeedbackPreviewContext } from './feedback-button.tsx';
import { FeedbackButton } from './feedback-button.tsx';
import { SettingsMenu } from './settings-menu.tsx';
import './top-bar.css';
import { ViewTabs } from './view-tabs.tsx';

/**
 * Верхняя панель (docs/design/README.md §0): марка, брендкрамб, вью-табы, статус агента, поиск и Feedback.
 */
export interface TopBarProps {
    /** Версия поставки — из корневого package.json, подставляется на сборке. */
    readonly version: string;
    /** Доступная новая версия; null — версия остаётся обычным текстом. */
    readonly update?: UiUpdate | null;
    /** Клик по версии с точкой: снимает «Позже» и открывает тост заново. */
    readonly onOpenUpdate?: () => void;
    /** Сегменты брендкрамба слева направо; последний — сам PR и, как только известна мета, ссылка. */
    readonly breadcrumb: readonly BreadcrumbSegment[];
    readonly agent: AgentPillView;
    readonly reconnectCommand: string;
    readonly chatOpen: boolean;
    readonly onToggleChat: (target: ChatScrollTarget | null) => void;
    readonly view: ViewId;
    readonly onSelectView: (view: ViewId) => void;
    readonly onOpenSearch: () => void;
    /** Агент подключён: меню настроек называет им число шагов в строке повтора онбординга. */
    readonly agentConnected: boolean;
    /** Перезапуск прохода тура из меню настроек — то же, что команда палитры `tour.replay`. */
    readonly onReplayTour: () => void;
    readonly feedback: UiFeedbackAvailability;
    readonly feedbackContext: FeedbackPreviewContext;
    readonly onSendFeedback: (request: UiFeedbackRequest) => Promise<UiFeedbackResponse>;
}

export function TopBar({
    version,
    update = null,
    onOpenUpdate,
    breadcrumb,
    agent,
    reconnectCommand: command,
    chatOpen,
    onToggleChat,
    view,
    onSelectView,
    onOpenSearch,
    agentConnected,
    onReplayTour,
    feedback,
    feedbackContext,
    onSendFeedback,
}: TopBarProps) {
    const t = useT();
    return (
        <header className="top-bar">
            <div className="top-bar__brand">
                <span className="top-bar__mark" aria-hidden="true" />
                <span className="top-bar__wordmark">Sherpa</span>
                {update === null ? (
                    <span className="top-bar__version">{version}</span>
                ) : (
                    <button
                        type="button"
                        className="ctl ctl--link-muted top-bar__version top-bar__version--update"
                        aria-label={t('topbar.update', update.latest)}
                        onClick={onOpenUpdate}
                    >
                        <span className="top-bar__version-dot" aria-hidden="true" />
                        {version}
                    </button>
                )}
            </div>

            <nav className="top-bar__breadcrumb" aria-label={t('topbar.breadcrumb')}>
                {breadcrumb.map((segment, index) => (
                    <Fragment key={`${String(index)}:${segment.text}`}>
                        {index === 0 ? null : (
                            <span className="top-bar__breadcrumb-separator" aria-hidden="true">
                                /
                            </span>
                        )}
                        {segment.href === null ? (
                            <span className="top-bar__breadcrumb-item">{segment.text}</span>
                        ) : (
                            // Обычный переход: PR открывается в браузере ревьюера у своего хоста.
                            <a className="top-bar__breadcrumb-item" href={segment.href}>
                                {segment.text}
                            </a>
                        )}
                    </Fragment>
                ))}
            </nav>

            <div className="top-bar__spacer" />
            <ViewTabs view={view} onSelect={onSelectView} />
            <div className="top-bar__spacer" />

            <AgentPill
                view={agent}
                reconnectCommand={command}
                chatOpen={chatOpen}
                onToggleChat={onToggleChat}
            />
            <SearchButton onClick={onOpenSearch} />
            <FeedbackButton availability={feedback} context={feedbackContext} onSend={onSendFeedback} />
            <SettingsMenu
                agentConnected={agentConnected}
                onOpenCommands={onOpenSearch}
                onReplayTour={onReplayTour}
            />
        </header>
    );
}

/** Индикатор открывает чат, а при отключённом агенте — reconnect-поповер. */
export function AgentPill({
    view,
    reconnectCommand: command,
    chatOpen = false,
    onToggleChat = NOOP_TOGGLE_CHAT,
    defaultOpen = false,
}: {
    view: AgentPillView;
    reconnectCommand: string;
    chatOpen?: boolean;
    onToggleChat?: (target: ChatScrollTarget | null) => void;
    defaultOpen?: boolean;
}) {
    const t = useT();
    const [open, setOpen] = useState(defaultOpen);
    const [announcement, setAnnouncement] = useState('');
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const previousTone = useRef(view.tone);

    useEffect(() => {
        const wasDisconnected = previousTone.current === 'disconnected';
        previousTone.current = view.tone;
        const next =
            view.tone === 'disconnected'
                ? wasDisconnected
                    ? null
                    : t('topbar.agent.disconnected')
                : '';
        if (next === null) {
            return;
        }
        const timer = window.setTimeout(() => {
            setAnnouncement(next);
        }, 0);
        return () => {
            window.clearTimeout(timer);
        };
    }, [t, view.tone]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [open]);
    useEscapeLayer('popover', () => {
        setOpen(false);
    }, open);

    return (
        <div ref={wrapperRef} className="agent-pill-wrap">
            <button
                type="button"
                className={`ctl ctl--ghost ctl--topbar agent-pill agent-pill--${view.tone}`}
                title={view.title}
                aria-haspopup={view.tone === 'disconnected' ? 'dialog' : undefined}
                aria-expanded={view.tone === 'disconnected' ? open : chatOpen}
                onClick={() => {
                    if (view.tone === 'disconnected') {
                        setOpen((value) => !value);
                        return;
                    }
                    onToggleChat(view.tone === 'working' ? 'queue' : view.tone === 'failed' ? 'error' : null);
                }}
            >
                <span className="agent-pill__dot" aria-hidden="true" />
                <span className="agent-pill__label">{view.label}</span>
            </button>
            {open && view.tone === 'disconnected' ? (
                <div className="agent-popover" role="dialog" aria-label={t('topbar.agent.connect')}>
                    <div className="agent-popover__title">{t('topbar.agent.connect')}</div>
                    {/* Объяснение «Агент отключён»: отдельного баннера нет, текст живёт здесь. */}
                    <p className="agent-popover__offline">{t('topbar.agent.offline')}</p>
                    <CommandBox command={command} hint={t('command.hint')} actionLabel={t('command.copy')} />
                </div>
            ) : null}
            <span className="visually-hidden" role="status" aria-live="polite">
                {announcement}
            </span>
        </div>
    );
}

/** Кнопка поиска открывает ту же палитру, что глобальное сочетание ⌘K/Ctrl-K. */
const NOOP_TOGGLE_CHAT = (): void => undefined;

function SearchButton({ onClick }: { onClick: () => void }) {
    const t = useT();
    return (
        <button type="button" className="ctl ctl--ghost ctl--topbar search-button" onClick={onClick}>
            {t('topbar.search')}
            <span className="search-button__hint">⌘K</span>
        </button>
    );
}
