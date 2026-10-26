import type { ReactNode } from 'react';

import type { Translate } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import { Markdown } from '../../markdown/markdown.tsx';
import type { RouteOtherView } from '../../route/route-model.js';
import { StopViewedToggle } from './stop-card.tsx';

/**
 * «Прочее — модель не разместила эти строки» (docs/design/README.md §2): штрихованная карточка с честным
 * копирайтом и единственным действием — раскрыть непокрытые диапазоны как сырой дифф.
 *
 * Содержимое считает UI: непокрытое — все изменённые строки минус объединение якорей всех
 * остановок. В снапшоте его нет и быть не может (инвариант контракта маршрута).
 */

export interface OtherCardProps {
    /** Вид уже суженный текущим фильтром: числа обязаны совпадать с тем, что раскроется. */
    readonly view: RouteOtherView;
    readonly stopCount: number;
    readonly opened: boolean;
    readonly onOpen: () => void;
    /** Раскрытые карточки непокрытых диапазонов; собираются вью. */
    readonly diff: ReactNode;
    /** Непокрытое ещё считается: не все файлы диффа разобраны. */
    readonly pending: boolean;
    /** У части файлов разбор сорвался: их непокрытых диапазонов нет — отмечать «Прочее» нечем. */
    readonly parseFailed?: boolean;
    /**
     * Маршрут ещё заполняется (docs/design/README.md §8): непокрытое сейчас — это незанятые слоты плана,
     * а не решение модели. Числа станут честными, когда остановки приземлятся.
     */
    readonly filling?: boolean;
    /** Файлов, разбор которых сорвался: их непокрытые строки в счёт не вошли. */
    readonly failedFiles?: number;
    readonly onRetryFailed?: () => void;
    /**
     * «Попросить агента разложить их» (docs/design/README.md §2): вопрос с перечнем диапазонов подставляется
     * в чат. Маршрут кнопка не меняет — перегенерация живёт отдельно (docs/design/SPEC-elements.md §4.3).
     * undefined — точки входа нет (чат недоступен).
     */
    readonly onAskToPlace?: () => void;
    /** Отключённый агент: точка входа в чат гаснет так же, как в поповере (docs/design/SPEC-elements.md §2.15). */
    readonly agentConnected?: boolean;
    /** Карточка оставлена на экране вопреки фильтру (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /**
     * «Прочее» — такая же остановка маршрута: её отметка пишет в прогресс непокрытые диапазоны
     * (docs/design/README.md §13 «Other read as raw diff»).
     */
    readonly viewed?: boolean;
    readonly onViewed?: (viewed: boolean) => void;
    readonly failedViewed?: boolean | null;
    /** Флеш акцентной линии после перехода к «Прочему». */
    readonly flash?: boolean;
    /** Подсветка наведением на штрихованный сегмент полосы покрытия (docs/design/SPEC-elements.md §2.4). */
    readonly marked?: boolean;
}

export function OtherCard({
    view,
    stopCount,
    opened,
    onOpen,
    diff,
    pending,
    parseFailed = false,
    filling = false,
    failedFiles = 0,
    onRetryFailed,
    onAskToPlace,
    agentConnected = false,
    keptInView = false,
    viewed = false,
    onViewed,
    failedViewed = null,
    flash = false,
    marked = false,
}: OtherCardProps) {
    const t = useT();
    const { lines } = view;
    const files = view.files.length;
    // Слот держат одни конфликты: непокрытого нет, читать и раскладывать нечего — карточка
    // говорит только про конфликты, без «0 строк в 0 файлах» и активных кнопок на пустоте.
    const conflictsOnly = !filling && !pending && files === 0 && view.conflictFiles > 0;

    return (
        <section
            className={`route-stop route-stop--other${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${view.stop.id}`}
            role="region"
            aria-label={t('route.stop.aria', view.planLabel, stopCount, stripInlineCode(view.stop.title))}
        >
            <div className="route-stop__side">
                <div className="route-stop__head">
                    <span className="route-stop__rule route-stop__rule--other" aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    <span className="route-stop__spacer" />
                    {onViewed === undefined ? null : (
                        <StopViewedToggle
                            viewed={viewed}
                            pending={pending}
                            parseFailed={parseFailed}
                            unfilled={filling}
                            failedViewed={failedViewed}
                            onViewed={onViewed}
                        />
                    )}
                </div>
                <h2 className="route-stop__title">
                    <Markdown text={view.stop.title} profile="route" />
                </h2>
                {filling ? (
                    <p className="route-stop__paragraph">{t('route.other.filling')}</p>
                ) : pending ? (
                    <p className="route-stop__paragraph">{t('route.other.pending')}</p>
                ) : conflictsOnly ? (
                    <p className="route-stop__paragraph">{t('route.other.none')}</p>
                ) : (
                    <p className="route-stop__paragraph">{t('route.other.counted', lines, files)}</p>
                )}
                {keptInView ? <p className="route-stop__kept">{t('route.stop.kept')}</p> : null}
            </div>

            <div className="route-stop__diff">
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                <div className="route-other">
                    <p className="route-other__text">
                        {filling ? (
                            t('route.other.fillingNote')
                        ) : conflictsOnly ? (
                            t('route.other.conflictsOnly')
                        ) : (
                            <>
                                {t('route.other.text.lead')}
                                <strong>{t('route.other.text.notExplained')}</strong>
                                {t('route.other.text.between')}
                                <strong>{t('route.other.text.notImportant')}</strong>
                                {t('route.other.text.tail')}
                            </>
                        )}
                    </p>
                    {conflictsOnly ? null : (
                        <div className="route-other__actions">
                            <button
                                type="button"
                                className="ctl ctl--secondary route-other__action"
                                disabled={pending || filling}
                                onClick={onOpen}
                            >
                                {filling
                                    ? t('route.other.waitFilling')
                                    : pending
                                      ? t('route.other.counting')
                                      : opened
                                        ? t('route.other.collapse')
                                        : t('route.other.open', lines)}
                            </button>
                            {onAskToPlace === undefined ? null : (
                                <button
                                    type="button"
                                    className="ctl ctl--ghost ctl--topbar route-other__action route-other__action--secondary"
                                    disabled={pending || filling || !agentConnected}
                                    title={askToPlaceTitle(t, { pending, filling, agentConnected })}
                                    onClick={onAskToPlace}
                                >
                                    {t('route.other.ask')}
                                </button>
                            )}
                        </div>
                    )}
                    {conflictsOnly || onAskToPlace === undefined ? null : (
                        <p className="route-other__honest">{t('chat.ask.answerInChat')}</p>
                    )}
                    {/* Конфликты вне покрытия (docs/design/SPEC-elements.md §4.1): их не объяснить и не прочитать
                        здесь — единственное честное действие ревьюера лежит в Аркануме. */}
                    {view.conflictFiles === 0 ? null : (
                        <p className="route-other__conflicts" role="status">
                            {t('route.other.conflicts', view.conflictFiles)}
                        </p>
                    )}
                    {failedFiles === 0 ? null : (
                        <p className="route-other__failed" role="status">
                            {t('route.other.failedFiles', failedFiles)}
                            {onRetryFailed === undefined ? null : (
                                <button type="button" className="ctl ctl--link-muted" onClick={onRetryFailed}>
                                    {t('route.other.retryParse')}
                                </button>
                            )}
                        </p>
                    )}
                </div>
                {opened ? diff : null}
            </div>
        </section>
    );
}

/**
 * Почему кнопка «разложить» недоступна. Незакрытый счёт диапазонов важнее статуса агента:
 * пока числа не окончательные, перечислять в вопросе нечего.
 */
function askToPlaceTitle(
    t: Translate,
    {
        pending,
        filling,
        agentConnected,
    }: {
        pending: boolean;
        filling: boolean;
        agentConnected: boolean;
    },
): string {
    if (filling) {
        return t('route.other.waitFilling');
    }
    if (pending) {
        return t('route.other.counting');
    }
    return agentConnected ? t('chat.ask.answerInChat') : t('chat.ask.rangesDisabled');
}

/** Баннер docs/design/SPEC-elements.md §4.3: план объясняет меньше половины диффа. */
export function RegenerateBanner({ onGenerate }: { readonly onGenerate?: () => void }) {
    const t = useT();
    return (
        <div className="route-regenerate" role="status">
            <span className="route-regenerate__dot" aria-hidden="true" />
            <span className="route-regenerate__text">{t('route.regenerate.hint')}</span>
            {onGenerate === undefined ? null : (
                <button type="button" className="ctl ctl--secondary route-regenerate__action" onClick={onGenerate}>
                    {t('route.regenerate.action')}
                </button>
            )}
        </div>
    );
}
