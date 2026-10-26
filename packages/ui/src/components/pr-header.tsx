import type { FileDiff, PrChecks, PrMeta } from '@sherpa/protocol';
import type { ReactNode, Ref } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import type { MessageKey } from '../i18n/index.js';
import { relativeTime, useFormat, useLocale, useT } from '../i18n/index.js';
import { Avatar } from './avatar.tsx';
import './pr-header.css';

/**
 * Шапка PR (docs/design/README.md §1): мета-строка `+N −M · K файлов · ветка · чип PCI DSS`, тайтл и автор.
 * Компонент общий — его же берёт вью маршрута, поэтому он ничего не знает ни про
 * загрузку данных, ни про то, куда ведёт чип: и то и другое приезжает пропсами.
 *
 * Правая сторона шапки — слот `aside` (docs/design/README.md §1): туда встаёт индикатор
 * снапшота с меню выбора итерации; без итераций слот пуст.
 *
 * Вариант `overview` — своя вёрстка с экрана Overview прототипа (`Sherpa.dc.html:523-529`):
 * номер PR в мета-строке, крупнее заголовок, автор без аватарки со временем, ветками и статусом
 * проверок, чип аудит-скоупа не кликается. Слот `aside` тут встаёт в строку автора — своей
 * нижней строки у этого варианта нет.
 */

/** Итоги диффа для мета-строки шапки; `null` — дифф ещё не приехал (скелетон, пустой кадр). */
export interface PrHeaderCounts {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
}

export interface PrHeaderDefaultProps {
    readonly variant?: 'default';
    readonly ref?: Ref<HTMLElement>;
    readonly pr: PrMeta;
    readonly counts: PrHeaderCounts | null;
    /** Линза аудит-скоупа для чипа-шортката; видна только при `available && count > 0`. */
    readonly pci: FileFilter | null;
    readonly pciActive: boolean;
    readonly onTogglePci: () => void;
    /** Правый край нижней строки шапки; на маршруте — индикатор снапшота. */
    readonly aside?: ReactNode;
}

export interface PrHeaderOverviewProps {
    readonly variant: 'overview';
    readonly ref?: Ref<HTMLElement>;
    readonly pr: PrMeta;
    /** Счётчики диффа; null — дифф ещё не приехал, и в мета-строке остаётся только номер PR. */
    readonly counts: PrHeaderCounts | null;
    /**
     * Линза аудит-скоупа; здесь чип только маркер — шорткат в фильтр живёт на полном диффе.
     * Маркер без счётчика и без выключенного состояния, поэтому рисуем его, только когда линза
     * работает и в PR действительно есть её файлы: иначе PR, аудит-скоупа не касающийся,
     * получил бы чужую метку.
     */
    readonly pci: FileFilter | null;
    /** Момент отсчёта относительного времени; инжектируется ради детерминированной галереи. */
    readonly now: number;
    /** Правый край строки автора; здесь тоже индикатор снапшота (docs/design/README.md §1). */
    readonly aside?: ReactNode;
}

export type PrHeaderProps = PrHeaderDefaultProps | PrHeaderOverviewProps;

/** Итоги диффа для мета-строки: одни и те же числа во всех вью. */
export function prHeaderCounts(diff: { readonly files: readonly FileDiff[] }): PrHeaderCounts {
    let additions = 0;
    let deletions = 0;
    for (const file of diff.files) {
        additions += file.additions;
        deletions += file.deletions;
    }
    return { additions, deletions, files: diff.files.length };
}

export function PrHeader(props: PrHeaderProps) {
    return props.variant === 'overview' ? <OverviewHeader {...props} /> : <DefaultHeader {...props} />;
}

function DefaultHeader({ ref, pr, counts, pci, pciActive, onTogglePci, aside = null }: PrHeaderDefaultProps) {
    const t = useT();
    const { count } = useFormat();
    return (
        <header className="pr-header" ref={ref}>
            <div className="pr-header__meta">
                {counts === null ? null : (
                    <>
                        <span className="pr-header__add">+{count(counts.additions)}</span>
                        <span className="pr-header__del">−{count(counts.deletions)}</span>
                        <Separator />
                        <span>{t('pr.files', counts.files)}</span>
                        <Separator />
                    </>
                )}
                <span className="pr-header__branches">
                    {pr.toBranch} ← {pr.fromBranch}
                </span>
                {/* Решение №11: нулевой или недоступный PCI-скоуп не оставляет чипа в шапке. */}
                {pci === null || !pci.available || pci.count === 0 ? null : (
                    <>
                        <Separator />
                        <button
                            type="button"
                            className={`pr-header__pci${pciActive ? ' is-active' : ''}`}
                            aria-pressed={pciActive}
                            title={t('pr.pci.title')}
                            onClick={onTogglePci}
                        >
                            {t('pr.pci.label', pci.count)}
                        </button>
                    </>
                )}
            </div>

            <h1 className="pr-header__title">{pr.title}</h1>

            <div className="pr-header__bottom">
                <div className="pr-header__author">
                    <Avatar
                        className="pr-header__avatar"
                        name={pr.author.displayName ?? pr.author.login}
                        url={pr.author.avatarUrl}
                        initialsRule="pair"
                    />
                    <span>{pr.author.login}</span>
                    <Separator />
                    <span>{pr.statusLabel}</span>
                </div>
                {aside === null ? null : <div className="pr-header__aside">{aside}</div>}
            </div>
        </header>
    );
}

function OverviewHeader({ ref, pr, counts, pci, now, aside = null }: PrHeaderOverviewProps) {
    const t = useT();
    const locale = useLocale();
    const { count } = useFormat();
    return (
        <header className="pr-header pr-header--overview" ref={ref}>
            <div className="pr-header__meta">
                <span>PR {pr.id}</span>
                {counts === null ? null : (
                    <>
                        <Separator />
                        <span className="pr-header__add">+{count(counts.additions)}</span>
                        <span className="pr-header__del">−{count(counts.deletions)}</span>
                        <Separator />
                        <span>{t('pr.files', counts.files)}</span>
                    </>
                )}
                {pci === null || !pci.available || pci.count === 0 ? null : (
                    <>
                        <Separator />
                        <span className="pr-header__pci-tag">PCI DSS</span>
                    </>
                )}
            </div>

            <h1 className="pr-header__title">{pr.title}</h1>

            <div className="pr-header__author">
                <span>{pr.author.login}</span>
                <Separator />
                <span>{relativeTime(pr.updatedAt, now, locale)}</span>
                <Separator />
                <span className="pr-header__branches">
                    {pr.toBranch} ← {pr.fromBranch}
                </span>
                {pr.checks === null ? null : (
                    <>
                        <Separator />
                        <span className={`pr-header__checks is-${pr.checks}`}>{t(CHECKS_LABELS[pr.checks])}</span>
                    </>
                )}
                {aside === null ? null : <div className="pr-header__aside">{aside}</div>}
            </div>
        </header>
    );
}

/** Статус проверок словами: хост отдаёт три состояния, `null` — сегмент не рисуется вовсе. */
const CHECKS_LABELS: Readonly<Record<PrChecks, MessageKey>> = {
    passed: 'pr.checks.passed',
    failed: 'pr.checks.failed',
    pending: 'pr.checks.pending',
};

function Separator() {
    return (
        <span className="pr-header__separator" aria-hidden="true">
            ·
        </span>
    );
}
