import { PCI_FILTER_ID } from '../filters/lens-filters.js';
import type { FileFilter, FilterStats } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ViewId } from '../session/views.js';
import './audit-banner.css';

/**
 * Баннер аудит-скоупа (docs/design/README.md §Filters, docs/design/SPEC-elements.md §2.21):
 * пока активен фильтр `pci`, ревьюер обязан понимать, что он смотрит не весь PR. Баннер описывает фильтр, поэтому его можно закрыть,
 * и у него ровно одно действие — сбросить фильтр.
 *
 * Компонент рендерится через общий слот баннеров уровня App; собственное условие активности
 * и приоритет держит реестр источников слота.
 */

/** Сколько путей скоупа перечислять поимённо, пока список не превратился в простыню. */
const LISTED_PATHS = 3;

/**
 * Аудит-скоуп имеет следствие там, где фильтр действительно скрывает файлы: в Full diff и
 * на маршруте. PCI-чип в шапке маршрута и баннер про него живут вместе, на обеих вью.
 */
export function auditScopeBannerVisible(
    view: ViewId,
    filterId: string,
    dismissed: boolean,
    files: number,
): boolean {
    return (view === 'diff' || view === 'route') && filterId === PCI_FILTER_ID && !dismissed && files > 0;
}

export interface AuditScopeBannerProps {
    readonly filter: FileFilter;
    readonly stats: FilterStats;
    /** Пути файлов скоупа в текущем диффе — `docs/design/README.md` §Filters требует показать список. */
    readonly paths: readonly string[];
    readonly onShowAll: () => void;
    readonly onDismiss: () => void;
}

export function AuditScopeBanner({ filter, stats, paths, onShowAll, onDismiss }: AuditScopeBannerProps) {
    const t = useT();
    const listed = paths.slice(0, LISTED_PATHS).join(', ');
    const rest = paths.length - LISTED_PATHS;
    const scope =
        paths.length === 0 ? '' : rest > 0 ? t('audit.scope.more', listed, rest) : t('audit.scope', listed);

    return (
        <div className="audit-banner" role="status">
            <span className="audit-banner__tag">PCI DSS</span>
            <div className="audit-banner__body">
                <div className="audit-banner__line">
                    {t('audit.line', stats.files, stats.changedLines, stats.totalChangedLines)}
                </div>
                {/* Список файлов скоупа и следствие про сайнофф docs/design/README.md §Filters требует
                    безусловно; хостовая `note` — добавка к ним, а не замена. */}
                <div className="audit-banner__note">
                    {scope}
                    {t('audit.note')}
                </div>
                {filter.note === null ? null : <div className="audit-banner__note">{filter.note}</div>}
            </div>
            <button type="button" className="ctl ctl--ghost ctl--topbar audit-banner__action" onClick={onShowAll}>
                {t('lens.showAll')}
            </button>
            <button
                type="button"
                className="ctl ctl--toolbar-icon audit-banner__dismiss"
                aria-label={t('audit.dismiss')}
                title={t('audit.dismiss.title')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
