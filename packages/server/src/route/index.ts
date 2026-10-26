/**
 * Валидатор результатов генерации маршрута. Чистые модули: ни БД, ни сети, ни очереди —
 * оркестрация зовёт их при приёме `task complete` и складывает принятое в снапшот.
 */
export { indexDiff, sideLines, touchesChangedLines } from './diff-index.js';
export type { ChangedFile, DiffIndex } from './diff-index.js';
export { stripCodeFence } from './raw-result.js';
export { OTHER_STOP_ID, otherStopTitle, stopId, validateSkeleton } from './skeleton.js';
export { validateSection } from './section.js';
export type { SectionContext } from './section.js';
export type { RouteStrings } from './strings.js';
export { routeStrings } from './strings.js';
export { applyFilling } from './types.js';
export type { AcceptedSkeleton, RouteStopFilling, RouteValidation } from './types.js';
