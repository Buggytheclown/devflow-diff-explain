import type { RouteSnapshot } from '@sherpa/protocol';
import { fixtureIteration, routeFixtures } from './data/index.js';

/** Фикстура UI/контракта: не образец содержательной генерации на реальном ПРе. */
export function guidedStoryFixture() {
    const diff = fixtureIteration('medium').diff;
    const base = routeFixtures('medium')?.states.ready?.snapshot;
    if (base == null) throw new Error('Missing route fixture');
    const anchor = base.stops.flatMap((stop) => stop.anchors)[0];
    const first = diff.files.find((file) => file.fileId === anchor?.fileId);
    if (first === undefined || anchor === undefined) throw new Error('Missing source fixture');
    const ordered = [first, ...diff.files.filter((file) => file.fileId !== first.fileId).reverse()];
    const evidence = (quote: string) => ({ claims: [{ quote, sources: [], limitation: 'Фикстура интерфейса: содержание не является разбором реального ПРа.' }] });
    const summary = 'ПР задаёт правила изменения заказа и подключает их к обработчику. Сначала разберём правило, затем его использование и проверки.';
    const groups = [ordered.slice(0, 2), ordered.slice(2)];
    const outline = { contractVersion: 3 as const, summary, evidence: evidence(summary), stops: groups.map((files, i) => ({
        title: i === 0 ? 'Правило изменения заказа' : 'Подключение и проверки', intent: 'Объяснить роль файлов и зависимости.',
        files: files.map((file) => file.path), relatedFiles: i === 0 ? [] : [first.path],
    })) };
    const body = { contractVersion: 3 as const, stops: groups.map((files, i) => {
        const paragraph = i === 0 ? 'Сначала посмотрим на правило, которое ограничивает изменение заказа.' : 'Затем проследим, как обработчик использует это правило, и посмотрим на проверки.';
        return { planIndex: i + 1, paragraph, evidence: evidence(paragraph), files: files.map((file) => ({ path: file.path,
            explanation: `Файл \`${file.path}\` ${i === 0 ? 'задаёт часть правила изменения заказа' : 'встраивает правило в обработку заказа или проверяет его работу'}. Его полный дифф показан ниже.`,
            annotations: file === first ? [{ side: anchor.side, start: anchor.start, end: Math.min(anchor.end, anchor.start + 4), text: 'Здесь находится важная часть изменения правила: она определяет дальнейшее поведение обработчика.' }] : [],
        })) };
    }) };
    const template = base.stops[0];
    if (template === undefined) throw new Error('Missing stop fixture');
    const snapshot: RouteSnapshot = { ...base, presentation: 'story', storyContractVersion: 3, summary,
        summaryEvidence: evidence(summary), stops: body.stops.map((stop, i) => ({ ...template, id: `guided-${String(i + 1)}`, planIndex: i + 1,
            title: outline.stops[i]?.title ?? 'Block', paragraph: stop.paragraph, status: 'ready', anchors: [], storyEvidence: stop.evidence,
            guidedFiles: stop.files.map((file) => ({ ...file, fileId: diff.files.find((entry) => entry.path === file.path)?.fileId ?? 'missing' })),
            relatedFiles: i === 0 ? [] : [{ fileId: first.fileId, path: first.path }],
        })), tourOrder: ['guided-1', 'guided-2'] };
    return { diff, outline, body, snapshot, first, anchor };
}
