import { useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n/index.js';

/** Кнопка остаётся на месте при чтении; после закрытия чата возвращает клавиатурный фокус. */
export function ChatLauncher({ open, onOpen }: { open: boolean; onOpen: () => void }) {
    const t = useT();
    const button = useRef<HTMLButtonElement | null>(null);
    const wasOpen = useRef(open);
    useLayoutEffect(() => {
        if (wasOpen.current && !open) button.current?.focus({ preventScroll: true });
        wasOpen.current = open;
    }, [open]);
    return <button ref={button} type="button" className="ctl story-chat-launcher" hidden={open}
        aria-haspopup="dialog" aria-expanded={false} onClick={onOpen}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M21 11.5a8.8 8.8 0 0 1-9 8.5 10.3 10.3 0 0 1-3.6-.6L3 21l1.6-4.6A8.2 8.2 0 0 1 3 11.5 8.8 8.8 0 0 1 12 3a8.8 8.8 0 0 1 9 8.5Z" /></svg>
        <span>{t('chat.title')}</span>
    </button>;
}
