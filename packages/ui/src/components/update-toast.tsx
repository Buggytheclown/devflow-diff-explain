import type { UiUpdate } from '@sherpa/protocol';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import { CommandBox } from './command-box.tsx';
import './update-toast.css';

/**
 * Тост «Доступна новая версия»: левый нижний угол, на одной линии
 * с плавающей панелью. Только уведомление — Шерпа ничего не скачивает и не ставит, а говорит,
 * какой командой обновиться.
 */

/** README дистрибутива в Аркануме: копии обновляются по нему, команды у них нет. */
const README_URL = 'https://a.yandex-team.ru/arcadia/junk/alice/sherpa/README.md';

export interface UpdateToastProps {
    readonly update: UiUpdate;
    /** «Не напоминать про X»: версия уезжает в глобальные настройки, сервер её больше не отдаёт. */
    readonly onDismissVersion: () => void;
    /** «Позже» — крестик и Esc: тост скрыт до перезагрузки или до клика по версии в топбаре. */
    readonly onLater: () => void;
    /** Галерея: блок «Как обновить» раскрыт сразу. */
    readonly howToOpen?: boolean;
    /** Галерея: вход без анимации, чтобы снимок был детерминированным. */
    readonly noMotion?: boolean;
}

export function UpdateToast({ update, onDismissVersion, onLater, howToOpen = false, noMotion = false }: UpdateToastProps) {
    const t = useT();
    const [how, setHow] = useState(howToOpen);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const later = useRef(onLater);
    useEffect(() => {
        later.current = onLater;
    });

    // Esc закрывает тост только когда фокус внутри него: глобально эта клавиша принадлежит
    // модальным слоям, и перехватывать её у палитры или композера тост не вправе.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const root = rootRef.current;
            if (event.key !== 'Escape' || root === null) {
                return;
            }
            if (document.activeElement !== null && root.contains(document.activeElement)) {
                later.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    return (
        <div
            ref={rootRef}
            className={`update-toast${noMotion ? ' update-toast--no-motion' : ''}`}
            role="status"
            aria-live="polite"
        >
            <div className="update-toast__head">
                <span className="update-toast__kicker">{t('update.kicker')}</span>
                <button
                    type="button"
                    className="ctl ctl--chevron update-toast__close"
                    aria-label={t('update.later')}
                    onClick={onLater}
                >
                    <span aria-hidden="true">×</span>
                </button>
            </div>

            <div className="update-toast__title">
                {t('update.title', update.latest)}
                <span className="update-toast__current">{t('update.current', update.current)}</span>
            </div>

            {update.whatsNew === null ? null : <p className="update-toast__body">{update.whatsNew}</p>}

            <div className="update-toast__footer">
                <button
                    type="button"
                    className="ctl ctl--ghost ctl--topbar update-toast__how"
                    aria-expanded={how}
                    onClick={() => {
                        setHow((open) => !open);
                    }}
                >
                    {t('update.how')}
                </button>
                <button type="button" className="ctl ctl--link-muted update-toast__dismiss" onClick={onDismissVersion}>
                    {t('update.dismiss', update.latest)}
                </button>
            </div>

            {how ? <UpdateInstructions install={update.install} /> : null}
        </div>
    );
}

/** Чекаут обновляется командой, копия — повторным копированием каталога. */
function UpdateInstructions({ install }: { install: UiUpdate['install'] }) {
    const t = useT();
    if (install.command !== null) {
        return (
            <div className="update-toast__how-block">
                <CommandBox command={install.command} inputLabel={t('update.command.aria')} />
            </div>
        );
    }
    return (
        <div className="update-toast__how-block">
            <p className="update-toast__copy-dir">{t('update.copyDir', install.dir)}</p>
            <a className="update-toast__readme" href={README_URL} target="_blank" rel="noreferrer">
                {t('update.readme')}
            </a>
        </div>
    );
}
