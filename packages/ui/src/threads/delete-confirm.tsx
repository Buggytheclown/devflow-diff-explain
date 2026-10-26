import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../i18n/index.js';

/**
 * Подтверждение удаления в строке действий: вопрос, красное «Удалить», «Отмена» (§3).
 * Один вид на оба места — удаление сообщения в треде и отказ от набранного черновика
 * в композере: ревьюер в обоих случаях теряет неопубликованный текст.
 */
export function DeleteConfirm({
    question,
    confirmLabel,
    busy = false,
    onConfirm,
    onCancel,
}: {
    question: string;
    confirmLabel: string;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <div className="thread__delete-confirm" onKeyDown={onEscape(onCancel)}>
            <span>{question}</span>
            <button
                type="button"
                className="ctl ctl--danger thread__delete-confirm-button"
                disabled={busy}
                autoFocus
                onClick={onConfirm}
            >
                {confirmLabel}
            </button>
            <button
                type="button"
                className="ctl ctl--ghost ctl--compact thread__keep-draft"
                disabled={busy}
                onClick={onCancel}
            >
                {t('thread.composer.cancel')}
            </button>
        </div>
    );
}

/** Esc в строке подтверждения = «Отмена»: вверх событие не уходит, тред остаётся раскрытым. */
function onEscape(cancel: () => void): (event: ReactKeyboardEvent<HTMLElement>) => void {
    return (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
        }
    };
}
