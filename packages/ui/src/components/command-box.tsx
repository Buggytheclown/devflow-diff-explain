import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import { copyText } from './clipboard.js';

import './command-box.css';

export interface CommandBoxProps {
    readonly command: string;
    readonly hint?: string;
    readonly actionLabel?: string;
    /** Подпись поля для скринридера; по умолчанию — команда запуска Шерпы. */
    readonly inputLabel?: string;
}

/** Сколько держится видимый отклик после нажатия, мс. */
const FEEDBACK_MS = 2000;

type Feedback = 'copied' | 'manual';

/** Копируемая команда; без Clipboard API запасной путь — выделить текст. */
export function CommandBox({ command, hint, actionLabel, inputLabel }: CommandBoxProps) {
    const t = useT();
    const label = actionLabel ?? t('command.copy');
    const inputRef = useRef<HTMLInputElement | null>(null);
    const timerRef = useRef<number | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
            }
        },
        [],
    );

    const show = (next: Feedback): void => {
        setFeedback(next);
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            setFeedback(null);
        }, FEEDBACK_MS);
    };

    const selectCommand = (): void => {
        inputRef.current?.focus();
        inputRef.current?.select();
        show('manual');
    };

    const copy = (): void => {
        void copyText(command).then((outcome) => {
            if (outcome === 'copied') {
                show('copied');
            } else {
                selectCommand();
            }
        });
    };

    const copied = feedback === 'copied';

    return (
        <div className="command-box">
            <div className="command-box__row">
                <input
                    ref={inputRef}
                    className="command-box__command"
                    value={command}
                    readOnly
                    aria-label={inputLabel ?? t('command.aria')}
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
                <button type="button" className="ctl ctl--secondary command-box__action" onClick={copy}>
                    {/* Обе подписи в одной ячейке грида: ширина кнопки — максимум из них, при смене не прыгает. */}
                    <span className={labelClass(copied)}>{t('command.copied')}</span>
                    <span className={labelClass(!copied)}>{label}</span>
                </button>
            </div>
            {hint === undefined ? null : <div className="command-box__hint">{hint}</div>}
            <div
                className={feedback === 'manual' ? 'command-box__fallback' : 'visually-hidden'}
                role="status"
                aria-live="polite"
            >
                {feedback === 'copied' ? t('command.copied.status') : feedback === 'manual' ? t('command.manual') : ''}
            </div>
        </div>
    );
}

function labelClass(visible: boolean): string {
    return visible ? 'command-box__action-label' : 'command-box__action-label command-box__action-label--ghost';
}
