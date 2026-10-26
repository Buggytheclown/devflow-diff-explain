import type { ReadableExample, GuidedFile, RouteAnchor, RouteStop, RouteStopChange, RouteTestClaim, StoryEvidenceBlock } from '@sherpa/protocol';

/**
 * Общие типы приёмки результатов маршрута.
 *
 * Языка два: `errors` читает модель («исправь и вызови complete снова»,
 * `docs/protocol.md §3`) — английские и действенные; `validationNotes` стопа читает ревьюер
 * в UI — русские.
 */

/** Итог приёмки: нормализованный результат либо список ошибок для модели. */
export type RouteValidation<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: string[] };

/**
 * Принятый скелет. `stops` — план целиком, включая синтетическое «Прочее» (модель про него
 * не знает); `intents` в снапшот не едут — их потребит постановщик секций.
 */
export interface AcceptedSkeleton {
    readonly summary: string;
    readonly storyContractVersion?: 2 | 3 | 4;
    readonly summaryEvidence?: StoryEvidenceBlock;
    readonly stops: RouteStop[];
    /** Порядок полного тура: id стопов, «Прочее» последним. */
    readonly tourOrder: string[];
    /** Черновой замысел стопа по плановому номеру. */
    readonly intents: Map<number, string>;
}

/** Принятое заполнение одного стопа: то, чем секция дополняет плановый слот. */
export interface RouteStopFilling {
    readonly planIndex: number;
    readonly paragraph: string;
    readonly bridge: string | null;
    readonly anchors: RouteAnchor[];
    readonly storyEvidence?: StoryEvidenceBlock;
    readonly guidedFiles?: GuidedFile[];
    readonly example?: ReadableExample | null;
    readonly tests: RouteTestClaim[];
    readonly droppedClaims: number;
    readonly validationNotes: string[];
    /** Классификация относительно прошлого захода; null — стоп не менялся или заход первый. */
    readonly change: RouteStopChange | null;
}

/** Плановый слот + заполнение = готовый стоп снапшота. */
export function applyFilling(stop: RouteStop, filling: RouteStopFilling): RouteStop {
    return {
        ...stop,
        status: 'ready',
        paragraph: filling.paragraph,
        bridge: filling.bridge,
        anchors: filling.anchors,
        ...(filling.storyEvidence === undefined ? {} : { storyEvidence: filling.storyEvidence }),
        ...(filling.guidedFiles === undefined ? {} : { guidedFiles: filling.guidedFiles }),
        ...(filling.example === undefined ? {} : { example: filling.example }),
        tests: filling.tests,
        droppedClaims: filling.droppedClaims,
        validationNotes: filling.validationNotes,
        change: filling.change,
    };
}
