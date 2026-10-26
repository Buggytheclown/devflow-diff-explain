import type {
    DigestAnchorView,
    DigestClaimView,
    DigestModel,
    DigestTestCodeLocation,
} from '../../route/digest.js';
import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Markdown } from '../../markdown/markdown.tsx';
import { anchorLabel, claimLabel } from '../../route/digest.js';

/**
 * Карточка поведенческого дайджеста (docs/design/README.md §2): хедер со счётчиком утверждений, управление
 * спрятанным тест-кодом либо ссылка на его запись, строки «чип категории + утверждение + якорь»
 * и футер `uncovered` — изменённое поведение, оставшееся без утверждения.
 *
 * Компонент ничего не считает и не грузит: модель приезжает из `route/digest.ts`, прыжок
 * по якорю делает вью. Тест-код раскрывается настоящими карточками файлов под этой картой —
 * значит, глобальный диффмод (docs/design/SPEC-elements.md §2.6) действует на него сам собой.
 */

export const DIGEST_NOTE: MessageKey = 'digest.note';
export const UNCOVERED_NOTE: MessageKey = 'digest.uncovered';
/** Якорь показан, но прыгнуть некуда: строки нет ни в одной карточке маршрута. */
export const ANCHOR_OFFSCREEN: MessageKey = 'digest.anchorOffscreen';

export interface TestDigestProps {
    readonly model: DigestModel;
    /** Тест-код раскрыт под дайджестом. */
    readonly shown: boolean;
    readonly onToggle: () => void;
    /** Тест-файлов остановки, которые прячет дайджест: подпись кнопки честна про их число. */
    readonly hiddenFiles: number;
    /** Куда ведёт тест-код, если в текущей остановке с учётом линзы прятать нечего. */
    readonly location: DigestTestCodeLocation | null;
    /** Есть ли на маршруте карточка, в которой эта строка вообще нарисована. */
    readonly anchorReachable: (anchor: DigestAnchorView) => boolean;
    readonly onOpenAnchor: (anchor: DigestAnchorView) => void;
}

export function TestDigest({
    model,
    shown,
    onToggle,
    hiddenFiles,
    location,
    anchorReachable,
    onOpenAnchor,
}: TestDigestProps) {
    const t = useT();
    return (
        <section className="digest" aria-label={t('digest.aria')}>
            <div className="digest__head">
                <span className="digest__title">{t('digest.title', model.total)}</span>
                {hiddenFiles === 0 ? (
                    location === null ? null : (
                        <button
                            type="button"
                            className="ctl ctl--link-muted digest__anchor digest__location"
                            title={`${location.anchor.path}:${String(location.anchor.line)}`}
                            onClick={() => {
                                onOpenAnchor(location.anchor);
                            }}
                        >
                            {location.label}
                        </button>
                    )
                ) : (
                    <>
                        {shown ? null : <span className="digest__note">{t(DIGEST_NOTE)}</span>}
                        <span className="digest__spacer" />
                        <button
                            type="button"
                            className="ctl ctl--ghost ctl--compact digest__toggle"
                            aria-expanded={shown}
                            title={shown ? t('digest.hide.title') : t('digest.show.title', hiddenFiles)}
                            onClick={onToggle}
                        >
                            {shown ? t('digest.hide') : t('digest.show')}
                        </button>
                    </>
                )}
            </div>

            {model.rows.map((claim, index) => (
                <ClaimRow
                    key={`${claim.kind}\u0000${String(index)}`}
                    claim={claim}
                    anchorReachable={anchorReachable}
                    onOpenAnchor={onOpenAnchor}
                />
            ))}

            {model.footer.length === 0 ? null : (
                <div className="digest__footer">
                    <p className="digest__footer-note">{t(UNCOVERED_NOTE)}</p>
                    {model.footer.map((claim, index) => (
                        <ClaimRow
                            key={`uncovered\u0000${String(index)}`}
                            claim={claim}
                            anchorReachable={anchorReachable}
                            onOpenAnchor={onOpenAnchor}
                        />
                    ))}
                </div>
            )}

            {model.dropped === 0 ? null : (
                <p className="digest__dropped">{t('digest.dropped', model.dropped)}</p>
            )}
        </section>
    );
}

function ClaimRow({
    claim,
    anchorReachable,
    onOpenAnchor,
}: {
    claim: DigestClaimView;
    anchorReachable: (anchor: DigestAnchorView) => boolean;
    onOpenAnchor: (anchor: DigestAnchorView) => void;
}) {
    const t = useT();
    const anchor = claim.anchor;
    return (
        <div className={`digest__row digest__row--${claim.kind}`}>
            <span className={`digest__chip digest__chip--${claim.kind}`}>{t(claimLabel(claim.kind))}</span>
            <span className="digest__text">
                <Markdown text={claim.text} profile="route" />
            </span>
            {anchor === null ? null : anchorReachable(anchor) ? (
                <button
                    type="button"
                    className="ctl ctl--link-muted digest__anchor"
                    title={`${anchor.path}:${String(anchor.line)}`}
                    onClick={() => {
                        onOpenAnchor(anchor);
                    }}
                >
                    {anchorLabel(anchor)}
                </button>
            ) : (
                <span className="digest__anchor digest__anchor--off" title={`${anchor.path} — ${t(ANCHOR_OFFSCREEN)}`}>
                    {anchorLabel(anchor)}
                </span>
            )}
        </div>
    );
}
