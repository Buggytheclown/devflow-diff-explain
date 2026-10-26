/**
 * Итерации PR: чистая арифметика переноса строк между итерациями. Ни БД, ни хоста —
 * ими пользуются перенос прогресса, классификация стопов и тексты баннеров.
 */
export { LEGACY_DIFF_ID } from './legacy.js';
export { affectedStops, buildIterationMap, classifyStop, identityMap, opaqueMap } from './line-map.js';
export type { FileStatus, IterationMap, IterationMapInput, MappedRange, StopChangeKind } from './line-map.js';
