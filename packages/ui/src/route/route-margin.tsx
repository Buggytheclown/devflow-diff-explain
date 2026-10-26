import type { UiChatAskAnchor } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import { ASK_ANSWER_IN_CHAT_NOTE, ASK_RANGES_DISABLED_TITLE } from '../components/chat-prompts.js';
import type { DiffFileModel } from '../diff/model.js';
import { useT } from '../i18n/index.js';
import { modelHasPosition } from '../threads/card-threads.tsx';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteMarginFile } from './margin-model.js';
import {
    marginBadgeLabel,
    marginBadgeShown,
    marginBadgeTitle,
    marginStripSummary,
    marginStripText,
    marginTargetStopId,
    treeBadgeAria,
    treeBadgeLabel,
} from './margin-model.js';
import './route-margin.css';

/**
 * Маршрут на полях полного диффа (docs/design/README.md §10, docs/product.md §3, принцип 5): бейдж остановки в строке дерева
 * и в шапке карточки, штрихованная полоса под непокрытым диапазоном. Тот же ИИ-слой, что задаёт
 * порядок на вкладке маршрута, — здесь он молчит о порядке и только отвечает «кто это объясняет».
 *
 * Компоненты общие для дерева и для карточек: вид один, различаются размеры (docs/design/README.md §10).
 */

export interface RouteBadgeProps {
    readonly file: RouteMarginFile;
    /** Цель клика по штриховке: «Прочее» — там эти строки и читаются. */
    readonly otherStopId: string | null;
    readonly variant: 'tree' | 'card';
    /** Без обработчика бейдж остаётся подписью: кнопка, которая никуда не ведёт, врала бы. */
    readonly onJump?: ((stopId: string) => void) | undefined;
}

export function RouteBadge({ file, otherStopId, variant, onJump }: RouteBadgeProps) {
    const t = useT();
    if (!marginBadgeShown(file)) {
        return null;
    }
    const target = marginTargetStopId(file, otherStopId);
    const jump = target === null ? undefined : onJump;
    const title = marginBadgeTitle(file, jump !== undefined, t);
    const label = variant === 'tree' ? treeBadgeLabel(file) : marginBadgeLabel(file, t);
    // Штриховка, а не только цвет: в шапке карточки бейдж говорит это ещё и текстом,
    // в дереве метка 17×13 текста не вмещает — там за неё говорят штриховка и тултип.
    const className = `route-badge route-badge--${variant}${file.stops.length === 0 ? ' route-badge--hatched' : ''}`;

    if (jump === undefined || target === null) {
        return (
            <span className={className} title={title}>
                {label}
            </span>
        );
    }
    return (
        <button
            type="button"
            className={className}
            title={title}
            // Озвучка метки дерева коротка намеренно: она стоит первым потомком строки,
            // и длинный заголовок остановки читался бы раньше имени файла.
            aria-label={variant === 'tree' ? treeBadgeAria(file, true, t) : title}
            // В дереве бейдж не заводит своей остановки табуляции: строки живут под роль-курсором
            // дерева (docs/design/SPEC-elements.md §2.20), и лишний таб-стоп сломал бы его клавиатуру.
            tabIndex={variant === 'tree' ? -1 : undefined}
            onClick={(event) => {
                // Клик по бейджу — переход к остановке, а не открытие файла строкой дерева.
                event.stopPropagation();
                jump(target);
            }}
        >
            {label}
        </button>
    );
}

export interface MarginStrips {
    /** Диапазоны, чьей последней строки в карточке нет: одна полоса-свод под шапкой. */
    readonly underHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
}

/**
 * Действие «попросить агента разложить диапазон» у штрихованной полосы (docs/design/README.md §10).
 * Это вопрос в чат, а не перегенерация: маршрут им не меняется.
 */
export interface MarginStripActions {
    /** Отключённый агент гасит точку входа так же, как в поповере (docs/design/SPEC-elements.md §2.15). */
    readonly agentConnected: boolean;
    /** Вопрос об этом диапазоне уже в очереди или в работе: вместо кнопки — чип «спрошено». */
    readonly isPending: (anchor: UiChatAskAnchor) => boolean;
    readonly onAskToPlace: (anchor: UiChatAskAnchor) => void;
}

export interface MarginStripsInput {
    /** Модель, которая реально нарисована в карточке. */
    readonly model: DiffFileModel | null;
    /** Строки диффа рисуются: свёрнутая карточка полосу под строкой поставить не может. */
    readonly rowsShown: boolean;
    readonly ranges: readonly AnchorSpan[];
    /** Файл диапазонов: без него у вопроса нет якоря, и полоса остаётся подписью. */
    readonly file?: { readonly fileId: string; readonly path: string } | null;
    readonly actions?: MarginStripActions | null;
}

/**
 * Полосы «без остановки маршрута» под непокрытыми диапазонами. Диапазон, чья последняя строка
 * не отрисована (карточка свёрнута по размеру, «только пробелы», патч не разобрался), не пропадает
 * молча: такие уходят в один свод под шапкой (docs/product.md §3, принцип 3).
 */
export function useMarginStrips({
    model,
    rowsShown,
    ranges,
    file = null,
    actions = null,
}: MarginStripsInput): MarginStrips {
    const t = useT();
    const layout = useMemo(() => {
        const byLine = new Map<string, AnchorSpan>();
        const orphans: AnchorSpan[] = [];
        for (const span of ranges) {
            if (rowsShown && modelHasPosition(model, span.side, span.end)) {
                byLine.set(lineKey(span.side, span.end), span);
            } else {
                orphans.push(span);
            }
        }
        return { byLine, orphans };
    }, [model, ranges, rowsShown]);

    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const span = layout.byLine.get(lineKey(side, line));
            if (span === undefined) {
                return null;
            }
            const anchor = file === null ? null : { fileId: file.fileId, path: file.path, ...span };
            return (
                <RouteStrip
                    text={marginStripText(span, t)}
                    {...(anchor === null || actions === null ? {} : { anchor, actions })}
                />
            );
        },
        [actions, file, layout.byLine, t],
    );

    // Свод под шапкой собирает несколько диапазонов, а якорь у вопроса один: кнопки здесь нет.
    // Ссылки стабильные: карточка мемоизирована, и новый узел на каждый рендер обесценил бы memo.
    const underHeader = useMemo(
        () => (layout.orphans.length === 0 ? null : <RouteStrip text={marginStripSummary(layout.orphans, t)} />),
        [layout.orphans, t],
    );

    return useMemo(() => ({ underHeader, renderAfterLine }), [renderAfterLine, underHeader]);
}

function RouteStrip({
    text,
    anchor,
    actions,
}: {
    readonly text: string;
    readonly anchor?: UiChatAskAnchor;
    readonly actions?: MarginStripActions;
}) {
    const t = useT();
    return (
        <div className="route-strip">
            <span className="route-strip__text">{text}</span>
            {anchor === undefined || actions === undefined ? null : actions.isPending(anchor) ? (
                <span className="route-strip__chip" role="status">
                    {t('margin.ask.asked')}
                </span>
            ) : (
                <button
                    type="button"
                    className="ctl ctl--link route-strip__action"
                    disabled={!actions.agentConnected}
                    title={t(actions.agentConnected ? ASK_ANSWER_IN_CHAT_NOTE : ASK_RANGES_DISABLED_TITLE)}
                    onClick={() => {
                        actions.onAskToPlace(anchor);
                    }}
                >
                    {t('margin.ask.place')}
                </button>
            )}
        </div>
    );
}

function lineKey(side: 'old' | 'new', line: number): string {
    return `${side}:${String(line)}`;
}
