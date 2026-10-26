import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { QuestionRange } from '../../components/chat-prompts.js';
import { placeRangesQuestion } from '../../components/chat-prompts.js';
import { useT } from '../../i18n/index.js';
import type { RouteFileGroup, RouteOtherView } from '../../route/route-model.js';
import { filterOtherView, uncoveredAsGroup } from '../../route/route-model.js';
import { OtherCard } from './other-card.tsx';

/**
 * Запись «Прочее»: непокрытое маршрутом, свёрнутое в одну карточку с раскрытием (docs/design/README.md §2).
 * Числа и вопрос агенту считаются по тому же набору, который раскроется под фильтром.
 */

export function OtherSection({
    view,
    stopCount,
    pending,
    parseFailed,
    filling,
    failedFiles,
    onRetryFailed,
    agentConnected,
    onComposeQuestion,
    opened,
    fileIds,
    keptInView,
    viewed,
    marked,
    failedViewed,
    flash,
    onViewed,
    onOpen,
    renderCard,
}: {
    view: RouteOtherView;
    stopCount: number;
    pending: boolean;
    /** У части файлов диффа разбор сорвался: непокрытое по ним не посчитано. */
    parseFailed: boolean;
    /** Маршрут ещё заполняется: «Прочее» считает не остаток модели, а незанятые слоты плана. */
    filling: boolean;
    failedFiles: number;
    onRetryFailed: () => void;
    agentConnected: boolean;
    /** Без него у карточки нет точки входа в чат — кнопка, которая никуда не ведёт, врала бы. */
    onComposeQuestion?: (text: string) => void;
    opened: boolean;
    /** null — показывать всё непокрытое (фильтра нет или карточка удержана на экране). */
    fileIds: ReadonlySet<string> | null;
    keptInView: boolean;
    viewed: boolean;
    marked: boolean;
    failedViewed: boolean | null;
    flash: boolean;
    onViewed: (viewed: boolean) => void;
    onOpen: () => void;
    renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
}) {
    const t = useT();
    // Карточка считает по тому же набору, который раскроется: иначе кнопка обещала бы все строки,
    // а показывала подмножество, прошедшее фильтр.
    const filtered = useMemo(() => filterOtherView(view, fileIds), [fileIds, view]);
    const groups = useMemo(() => filtered.files.map((file) => uncoveredAsGroup(file)), [filtered.files]);
    // Вопрос перечисляет ровно то, что видит ревьюер: карточка сужена фильтром, и обещать
    // агенту диапазоны, которых на экране нет, она не должна.
    const askToPlace = useMemo(
        () =>
            onComposeQuestion === undefined
                ? undefined
                : () => {
                      onComposeQuestion(placeRangesQuestion(otherQuestionRanges(filtered), t));
                  },
        [filtered, onComposeQuestion, t],
    );

    return (
        <div data-stop={view.stop.id}>
            <OtherCard
                view={filtered}
                stopCount={stopCount}
                pending={pending}
                parseFailed={parseFailed}
                filling={filling}
                failedFiles={failedFiles}
                onRetryFailed={onRetryFailed}
                agentConnected={agentConnected}
                {...(askToPlace === undefined ? {} : { onAskToPlace: askToPlace })}
                keptInView={keptInView}
                viewed={viewed}
                marked={marked}
                failedViewed={failedViewed}
                flash={flash}
                onViewed={onViewed}
                opened={opened}
                onOpen={onOpen}
                diff={groups.map((group) => renderCard(view.stop.id, group))}
            />
        </div>
    );
}

/** Непокрытые диапазоны «Прочего» для текста вопроса — в порядке файлов и якорей вью. */
function otherQuestionRanges(view: RouteOtherView): readonly QuestionRange[] {
    return view.files.flatMap((file) =>
        file.anchors.map((anchor) => ({
            path: file.path,
            side: anchor.side,
            start: anchor.start,
            end: anchor.end,
        })),
    );
}
