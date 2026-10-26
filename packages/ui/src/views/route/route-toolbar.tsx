import type { UiGenerationCap } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { ToolbarRightCluster } from '../../components/toolbar-controls.tsx';
import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import type { FileFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';

/**
 * Липкий тулбар маршрута (docs/design/README.md §1): переключатель пресета с подсказкой и общий с полным
 * диффом правый кластер. Режим и фильтр файлов обязаны совпадать между вью.
 *
 * Вторая строка — полоса покрытия со своей легендой и счётчиком просмотренных остановок;
 * собирает её вью и передаёт сюда готовой.
 */

export const TRIAGE_HINT: MessageKey = 'route.preset.triage.hint';
export const TOUR_HINT: MessageKey = 'route.preset.tour.hint';

/** docs/design/SPEC-elements.md §2.5: переключатель выключен, пока маршрута нет, и объясняет это (`title`). */
export const PRESET_DISABLED_TITLE: MessageKey = 'route.preset.disabled';

/** Чип фильтра «что нового» — docs/design/README.md §9, снимается крестиком. */
export const CHANGE_CHIP_LABEL: MessageKey = 'route.changeChip';

const PRESETS: readonly { readonly id: RoutePreset; readonly label: MessageKey; readonly hint: MessageKey }[] = [
    { id: 'triage', label: 'route.preset.triage', hint: TRIAGE_HINT },
    { id: 'tour', label: 'route.preset.tour', hint: TOUR_HINT },
];

export interface RouteToolbarProps {
    readonly store: DiffViewStore;
    readonly preset: RoutePreset;
    readonly onPreset: (preset: RoutePreset) => void;
    /** Маршрута нет: переключать нечего (docs/design/SPEC-elements.md §2.5). */
    readonly presetDisabled?: boolean;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    /** Включён фильтр «что нового с прошлого захода» (docs/design/README.md §9): под пресетом встаёт чип. */
    readonly changeFilterOn?: boolean;
    readonly onClearChangeFilter?: () => void;
    /** Вторая строка тулбара: полоса покрытия (docs/design/SPEC-elements.md §2.4). */
    readonly strip: ReactNode;
    /**
     * Кап генерации (docs/design/SPEC-elements.md §4.1): бюджет payload не пустил в контекст агента весь дифф.
     * null — урезания не было или маршрут построен старой версией.
     */
    readonly generationCap?: UiGenerationCap | null;
    /**
     * Замеренная высота тулбара — от неё вью держит липкий офсет колонки остановок.
     * Меряет её сам тулбар: иначе правки его раскладки молча разъезжались бы с офсетом.
     */
    readonly onHeight?: ((height: number) => void) | undefined;
}

export function RouteToolbar({
    store,
    preset,
    onPreset,
    presetDisabled = false,
    filters,
    filter,
    onFilter,
    changeFilterOn = false,
    onClearChangeFilter,
    strip,
    generationCap = null,
    onHeight,
}: RouteToolbarProps) {
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);

    // Замер до отрисовки: иначе первый кадр уедет на запасную высоту из route.css.
    // Стартовое значение снимается вручную — ResizeObserver в фоновой вкладке молчит.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || onHeight === undefined) {
            return;
        }
        const report = (): void => {
            onHeight(element.getBoundingClientRect().height);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [onHeight]);

    return (
        <div className="route-toolbar" ref={ref}>
            <div className="route-toolbar__row">
                {/* `data-tour="presets"` — цель шага 05 тура первого захода. */}
                <div className="route-preset ctl-tabs" role="group" aria-label={t('route.preset.aria')} data-tour="presets">
                    {PRESETS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`ctl ctl--tab route-preset__option${option.id === preset ? ' is-active' : ''}`}
                            aria-pressed={option.id === preset}
                            disabled={presetDisabled}
                            {...(presetDisabled ? { title: t(PRESET_DISABLED_TITLE) } : {})}
                            onClick={() => {
                                onPreset(option.id);
                            }}
                        >
                            {t(option.label)}
                        </button>
                    ))}
                </div>
                <span className="route-toolbar__hint">
                    {t(PRESETS.find((option) => option.id === preset)?.hint ?? TRIAGE_HINT)}
                </span>
                <span className="route-toolbar__spacer" />
                <ToolbarRightCluster
                    store={store}
                    filters={filters}
                    filter={filter}
                    onFilter={onFilter}
                />
            </div>
            {/* Чип фильтра — своей строкой: в строку пресета он не влезает на минимальных 1280. */}
            {changeFilterOn && onClearChangeFilter !== undefined ? (
                <div className="route-toolbar__filters">
                    <button
                        type="button"
                        className="ctl ctl--chip route-change-chip"
                        title={t('route.showWhole')}
                        onClick={onClearChangeFilter}
                    >
                        {t(CHANGE_CHIP_LABEL)}
                        <Icon name="cross" size={9} />
                    </button>
                </div>
            ) : null}
            <div className="route-toolbar__strip">{strip}</div>
            <GenerationCapNote cap={generationCap} />
        </div>
    );
}

/**
 * Строка капа под полосой покрытия (docs/design/SPEC-elements.md §4.1): чем именно план ограничен. Молчит, пока
 * весь дифф влезал в контекст — говорить «покрыто всё» полосе покрытия и так есть чем.
 *
 * Про машинную группу говорится только когда она есть: без неё «0 машинных — одной остановкой»
 * было бы ложью. Знаменатель печатается всегда — иначе числа строки не складываются в дифф,
 * и остаток, о котором говорит баннер, выглядел бы взявшимся ниоткуда.
 */
function GenerationCapNote({ cap }: { cap: UiGenerationCap | null }) {
    const t = useT();
    if (cap === null || cap.filesCovered >= cap.filesTotal) {
        return null;
    }
    return (
        <div className="route-toolbar__cap">
            {cap.machineFiles > 0
                ? t('route.cap.note.machine', cap.filesCovered, cap.filesTotal, cap.machineFiles)
                : t('route.cap.note', cap.filesCovered, cap.filesTotal)}
        </div>
    );
}
