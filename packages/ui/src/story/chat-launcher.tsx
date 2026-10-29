import { useId, useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n/index.js';

/** Кнопка остаётся на месте при чтении; после закрытия чата возвращает клавиатурный фокус. */
export function ChatLauncher({ open, onOpen, activity = 'idle', progressText = null, unreadCount = 0 }: {
    open: boolean; onOpen: () => void; activity?: 'idle' | 'queued' | 'running' | 'paused'; progressText?: string | null; unreadCount?: number;
}) {
    const t = useT();
    const statusId = useId();
    const pending = activity === 'queued' || activity === 'running';
    const status = activity === 'idle' ? '' : t(activity === 'running' ? 'chat.answering' : activity === 'queued' ? 'chat.launcher.queued' : 'chat.launcher.paused');
    const button = useRef<HTMLButtonElement | null>(null);
    const wasOpen = useRef(open);
    useLayoutEffect(() => {
        if (wasOpen.current && !open) button.current?.focus({ preventScroll: true });
        wasOpen.current = open;
    }, [open]);
    return <button ref={button} type="button" className="ctl story-chat-launcher" hidden={open}
        aria-label={t('chat.title')} aria-describedby={status || unreadCount > 0 ? statusId : undefined}
        title={[status, progressText, unreadCount > 0 ? t('chat.launcher.unread', unreadCount) : ''].filter(Boolean).join(' · ') || undefined}
        data-activity={activity} aria-haspopup="dialog" aria-expanded={false} onClick={onOpen}>
        {pending ? <span className="story-chat-launcher__spinner" aria-hidden="true" /> : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M21 11.5a8.8 8.8 0 0 1-9 8.5 10.3 10.3 0 0 1-3.6-.6L3 21l1.6-4.6A8.2 8.2 0 0 1 3 11.5 8.8 8.8 0 0 1 12 3a8.8 8.8 0 0 1 9 8.5Z" /></svg>}
        <span>{t('chat.title')}</span>
        {status ? <span className="story-chat-launcher__activity" aria-hidden="true">{status}</span> : null}
        {unreadCount > 0 ? <span className="story-chat-launcher__unread" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
        <span id={statusId} className="visually-hidden" role="status">{[status, progressText, unreadCount > 0 ? t('chat.launcher.unread', unreadCount) : ''].filter(Boolean).join(' · ')}</span>
    </button>;
}
