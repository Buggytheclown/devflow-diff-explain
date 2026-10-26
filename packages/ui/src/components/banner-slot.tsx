import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../i18n/index.js';
import './banner-slot.css';

/**
 * Лестница приоритетов слота (docs/design/SPEC-elements.md §2.21): провал генерации →
 * провалившееся действие с маршрутом → перестройка → устаревший маршрут → режим чтения прошлой итерации → второй заход →
 * недообъяснённый маршрут → заполнение маршрута → заметки без якоря → аудит-скоуп →
 * кап генерации → язык маршрута → чужой шип. Числа живут здесь, а не россыпью по объявлениям
 * источников: порядок — продуктовое решение.
 *
 * Провал только что нажатой кнопки стоит сразу под провалом генерации: ревьюер ждёт ответа именно
 * на своё действие, но сама несостоявшаяся генерация — новость крупнее.
 *
 * «Маршрут устарел» стоит под перестройкой: пока новый маршрут строится, новость про старый уже
 * не новость. Баннер второго захода — ниже, он про фильтр, а не про условие.
 *
 * Отключения агента здесь нет: статус живёт в индикаторе, а объяснение — в его поповере.
 *
 * Чужой шип — в самом низу: ревью он не отменяет и никакого действия не требует.
 */
export const BANNER_PRIORITY = {
    generationFailed: 400,
    routeActionError: 350,
    routeRegenerating: 300,
    routeStale: 250,
    readOnlyIteration: 240,
    routeSecondPass: 220,
    routeUnderExplained: 200,
    routeFilling: 150,
    notesLost: 120,
    auditScope: 100,
    shipVerdict: 50,
    /**
     * Кап генерации стоит под аудит-скоупом: аудит-скоуп описывает фильтр, который ревьюер
     * включил сам и про который ждёт подтверждения прямо сейчас, а кап — фоновое условие
     * построенного плана, оно никуда не денется и не требует ответа.
     */
    generationCap: 90,
    /**
     * Язык маршрута — под капом генерации: кап говорит, что план неполон, а язык — что план
     * полный, но не на том языке. Выше чужого шипа: у языка есть действие, у шипа его нет.
     */
    routeLocaleMismatch: 80,
} as const;

export interface BannerSource {
    readonly id: string;
    readonly priority: number;
    readonly active: () => boolean;
    readonly render: () => ReactNode;
}

export interface BannerSelection {
    readonly primary: BannerSource | null;
    readonly hidden: readonly BannerSource[];
}

/** Активные источники в порядке продуктового приоритета, а не в порядке условных операторов в App. */
export function selectBanners(sources: readonly BannerSource[]): BannerSelection {
    const active = sources.filter((source) => source.active()).toSorted((left, right) => right.priority - left.priority);
    return { primary: active[0] ?? null, hidden: active.slice(1) };
}

export function BannerSlot({ sources }: { sources: readonly BannerSource[] }) {
    const t = useT();
    const selection = useMemo(() => selectBanners(sources), [sources]);
    const active = selection.primary === null ? [] : [selection.primary, ...selection.hidden];
    const activeKey = active.map((source) => source.id).join('\u0000');
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const expanded = expandedKey === activeKey;

    const primary = active[0];
    if (primary === undefined) {
        return null;
    }
    const hidden = active.slice(1);

    return (
        <section className="banner-slot" aria-label={t('banner.slot')}>
            <div className="banner-slot__item">{primary.render()}</div>
            {hidden.length === 0 ? null : (
                <>
                    <button
                        type="button"
                        className="ctl ctl--link-muted banner-slot__more"
                        aria-expanded={expanded}
                        onClick={() => {
                            setExpandedKey(expanded ? null : activeKey);
                        }}
                    >
                        {t('banner.slot.more', hidden.length)}
                    </button>
                    {expanded
                        ? hidden.map((source) => (
                              <div key={source.id} className="banner-slot__item banner-slot__item--secondary">
                                  {source.render()}
                              </div>
                          ))
                        : null}
                </>
            )}
        </section>
    );
}
