import type { ArchitectureDiagram, RouteSnapshot } from '@sherpa/protocol';
import { readableStoryFixture } from './readable-story.js';

/** Синтетический разветвлённый граф и полный двухэтапный результат для проверок механики. */
export function architectureStoryFixture() {
    const base = readableStoryFixture();
    const source = { kind: 'patch' as const, path: base.anchor.path, side: base.anchor.side, start: base.anchor.start, end: base.anchor.start };
    const limitation = 'Синтетическая архитектура для проверки UI, не объяснение реального PR.';
    const diagram: ArchitectureDiagram = { title: 'Архитектура изменения заказа',
        mermaid: 'flowchart TB\nrequest["Запрос на изменение"] --> handler["Обработчик"]\nsubgraph rules["Правило, затронутое PR"]\nrule{"Можно изменить заказ?"}\nend\nhandler --> rule\nrule -->|"Да"| saved["Сохранение"]\nrule -->|"Нет"| rejected["Отказ"]\nsaved -.->|"Следующий запрос"| handler',
        nodes: [
            { id: 'request', label: 'Запрос на изменение', change: 'unknown', sources: [], limitation },
            { id: 'handler', label: 'Обработчик', change: 'affected', sources: [source], limitation },
            { id: 'rule', label: 'Можно изменить заказ?', change: 'modified', sources: [source], limitation },
            { id: 'saved', label: 'Сохранение', change: 'existing', sources: [source], limitation },
            { id: 'rejected', label: 'Отказ', change: 'existing', sources: [source], limitation },
        ], edges: [] };
    const stops = base.outline.stops.map((stop, i) => ({ title: stop.title, paragraph: base.body.stops[i]?.paragraph ?? '',
        evidence: base.body.stops[i]?.evidence ?? base.outline.evidence, files: stop.files, relatedFiles: stop.relatedFiles,
        nodeIds: i === 0 ? ['rule'] : ['handler', 'saved', 'rejected'] }));
    const outline = { contractVersion: 6 as const, summary: base.outline.summary, evidence: base.outline.evidence,
        flow: { status: 'ready' as const, diagram }, stops };
    const body = { contractVersion: 6 as const, stops: base.body.stops.map((block) => ({ planIndex: block.planIndex, files: block.files })) };
    const snapshot: RouteSnapshot = { ...base.snapshot, storyContractVersion: 6, flow: { status: 'ready', diagram, contexts: [] },
        stops: base.snapshot.stops.map((block, i) => ({ ...block, nodeIds: stops[i]?.nodeIds })) };
    return { ...base, outline, body, snapshot, diagram };
}
