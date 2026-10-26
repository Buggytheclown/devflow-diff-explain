import type { UiGenerationCap } from '@sherpa/protocol';

import { useT } from '../i18n/index.js';
import './generation-cap-banner.css';

/**
 * Баннер капа генерации (docs/design/SPEC-elements.md §4.1): бюджет payload выбросил из
 * контекста агента файлы, которые машинными не назовёшь, — значит план строился по неполному диффу, и это надо сказать.
 *
 * Действий нет: перегенерация ничего не изменит (бюджет тот же), а единственный настоящий ход —
 * дочитать эти файлы в полном диффе, куда ведёт сам текст. Приоритет — самый низкий в слоте
 * (`BANNER_PRIORITY`): это фоновое условие плана, а не новость, на которую ждут ответа.
 */

/** Файлы, которых модель не видела: всё, что не влезло, минус машинная группа. */
export function generationCapMissingFiles(cap: UiGenerationCap): number {
    return Math.max(cap.filesTotal - cap.filesCovered - cap.machineFiles, 0);
}

export function generationCapBannerVisible(cap: UiGenerationCap | null): boolean {
    return cap?.truncated === true;
}

export function GenerationCapBanner({ cap }: { readonly cap: UiGenerationCap }) {
    const t = useT();
    return (
        <div className="generation-cap-banner" role="status">
            <span className="generation-cap-banner__dot" aria-hidden="true" />
            <span className="generation-cap-banner__text">
                {t('banner.generationCap', generationCapMissingFiles(cap))}
            </span>
        </div>
    );
}
