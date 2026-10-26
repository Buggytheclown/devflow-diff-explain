import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';

/**
 * Отметка «просмотрено» — один контрол на карточку файла и на остановку (docs/design/SPEC-elements.md §2.10):
 * коробка-чекбокс с подписью у файла и залитая пилюля-тумблер у остановки
 * (docs/design/SPEC-changes-2026-09-20.md §5, строки «Checkbox» и «Viewed toggle»).
 *
 * Состояний у контрола два. Трёхсостоянный индикатор прочитанности (§2.12) — другая сущность:
 * он живёт в дереве и на чипах файлов, в кнопку «частично» не попадает.
 *
 * Это тогл, а не настоящий чекбокс: состояние озвучивается `aria-pressed`.
 */
export interface ViewedToggleProps {
    readonly viewed: boolean;
    /** Класс места вызова: индикатор в шапке остановки и голая строка в шапке файла — разные. */
    readonly className: string;
    /** Коробка с подписью (шапка файла) или пилюля-тумблер (шапка остановки). */
    readonly variant?: 'checkbox' | 'toggle';
    readonly disabled?: boolean;
    /**
     * У файла всегда несёт числа прогресса (docs/design/SPEC-elements.md §2.12), у остановки — причину выключенности.
     * В режиме чтения прошлой итерации заменяется на её причину.
     */
    readonly title?: string | undefined;
    readonly onToggle: (viewed: boolean) => void;
}

export function ViewedToggle({
    viewed,
    className,
    variant = 'checkbox',
    disabled = false,
    title,
    onToggle,
}: ViewedToggleProps) {
    const t = useT();
    // Отметки живут в активной итерации: в прошлой контрол виден, но не нажимается.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const effectiveDisabled = readOnly || disabled;
    const effectiveTitle = readOnly ? readOnlyReason : title;
    const variantClass = variant === 'toggle' ? 'ctl ctl--toggle' : 'ctl-checkbox';
    return (
        <button
            type="button"
            className={`viewed-toggle ${variantClass} ${className}${viewed ? ' is-on' : ''}`}
            aria-pressed={viewed}
            disabled={effectiveDisabled}
            {...(effectiveTitle === undefined ? {} : { title: effectiveTitle })}
            onClick={() => {
                onToggle(!viewed);
            }}
        >
            {variant === 'toggle' ? (
                viewed ? (
                    <Icon name="check" size={13} />
                ) : null
            ) : (
                <span className="ctl-checkbox__box" aria-hidden="true">
                    <Icon name="check" size={9} />
                </span>
            )}
            {viewed ? t('viewed.on') : t('viewed.off')}
        </button>
    );
}
