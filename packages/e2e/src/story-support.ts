import { routeFixtures } from '@sherpa/fixtures';

const anchor = routeFixtures('medium')?.rawResults?.sections[0]?.stops[0]?.anchors[0];
if (anchor === undefined) throw new Error('Missing code fixture');
export const codeReference = anchor;
export const evidenceSource = { kind: 'lines' as const, path: anchor.path, side: anchor.side, start: anchor.start, end: Math.min(anchor.end, anchor.start + 8) };
/** Фикстура механики UI; смысл рассказов проверяется отдельно реальной генерацией в qa/. */
export const evidence = (quote: string) => ({ claims: [{ quote, sources: [evidenceSource], limitation: null }] });
const summary = 'ПР меняет порядок записи и обновления кэша.';
export const outline = { contractVersion: 2, summary, evidence: evidence(summary), stops: [
    { title: 'Запись до уведомления', intent: 'Объяснить новое поведение.' },
    { title: 'Проверка ошибок', intent: 'Объяснить, что проверено тестами.' },
] };
export const body = { contractVersion: 2, stops: [
    { planIndex: 1, paragraph: 'Сначала завершается запись. Кэш обновляется после успешного сохранения.', evidence: evidence('Кэш обновляется после успешного сохранения.') },
    { planIndex: 2, paragraph: 'Тесты проверяют успешную запись и откат при ошибке.', evidence: evidence('Тесты проверяют успешную запись и откат при ошибке.') },
] };
