import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js';
// @ts-expect-error Mermaid публикует этот бандл парсера без декларации типов.
import { diagram as rawDiagram } from 'mermaid/dist/chunks/mermaid.core/chunk-SHT3W25Y.mjs';
const diagram = rawDiagram as { db: FlowDB; parser: { parser: { yy: FlowDB }; parse(source: string): unknown } };

export interface MermaidTopology {
    nodes: Map<string, string>;
    groups: Map<string, string>;
    edges: { id: string; from: string; to: string; label: string }[];
}

/** Парсер и FlowDB Mermaid 11.17.2 совпадают с браузерной схемой. Сервер
 * извлекает только структуру; отключение санитайзера текста не требует DOM.
 * Браузер по-прежнему рисует SVG в strict mode. */
export function mermaidTopology(source: string): MermaidTopology {
    const db = diagram.db;
    (db as unknown as { sanitizeText: (value: string) => string }).sanitizeText = (value: string) => value;
    diagram.parser.parser.yy = db;
    // Mermaid удаляет строковые комментарии до передачи текста этому парсеру.
    diagram.parser.parse(source.replace(/^\s*%%(?!\{)[^\n]+\n?/gm, '').trimStart() + '\n');
    return {
        nodes: new Map([...db.getVertices()].map(([id, node]) => [id, node.text ?? id])),
        groups: new Map(db.getSubGraphs().map((group) => [group.id, group.title])),
        edges: db.getEdges().map((edge) => ({ id: edge.id ?? '', from: edge.start, to: edge.end, label: edge.text })),
    };
}
