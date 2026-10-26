import type { FlowDiagram, ReadableExample, RouteSnapshot } from '@sherpa/protocol';
import { guidedStoryFixture } from './guided-story.js';

/** Только локальная проверка состояний интерфейса и протокола. */
export function readableStoryFixture() {
    const base = guidedStoryFixture();
    const evidence = (quote: string) => ({ claims: [{ quote, sources: [], limitation: 'Фикстура интерфейса, не разбор поведения реального кода.' }] });
    const sample = 'Заказ можно изменить → обработчик продолжает работу. Если правило запрещает изменение → возвращается отказ.';
    const example: ReadableExample = { text: sample, evidence: evidence(sample) };
    const outline = { ...base.outline, contractVersion: 4 as const };
    const body = { contractVersion: 4 as const, stops: base.body.stops.map((stop, i) => ({ ...stop, example: null,
        files: stop.files.map((file, j) => ({ ...file, explanation: i === 0 ? 'Здесь задано правило изменения заказа. Обработчик опирается на него при выборе дальнейшего действия.' : 'Файл подключает правило к обработке или проверяет его работу.', example: i === 0 && j === 0 ? example : null })),
    })) };
    const source = { kind: 'patch' as const, path: base.anchor.path, side: base.anchor.side, start: base.anchor.start, end: base.anchor.start };
    const diagram: FlowDiagram = { title: 'От запроса на изменение до результата', nodes: [
        { id: 'request', label: 'Запрос на изменение заказа', change: 'unknown', sources: [], limitation: 'Внешний вызывающий код не показан в фикстуре.' },
        { id: 'rule', label: 'Проверка правила', change: 'modified', sources: [source], limitation: null },
        { id: 'result', label: 'Изменение или отказ', change: 'unknown', sources: [], limitation: 'Результат приведён для проверки интерфейса.' },
    ], edges: [
        { from: 'request', to: 'rule', label: 'Параметры изменения', kind: 'data', change: 'unknown', sources: [], limitation: 'Связь с внешним вызывающим кодом не подтверждена.' },
        { from: 'rule', to: 'result', label: 'Выбор следующего действия', kind: 'control', change: 'modified', sources: [source], limitation: null },
    ] };
    const snapshot: RouteSnapshot = { ...base.snapshot, storyContractVersion: 4, flow: { status: 'ready', diagram, contexts: [] },
        stops: base.snapshot.stops.map((stop, i) => ({ ...stop, example: null, guidedFiles: stop.guidedFiles?.map((file, j) => ({ ...file, explanation: body.stops[i]?.files[j]?.explanation ?? file.explanation, example: i === 0 && j === 0 ? example : null })) })),
    };
    return { ...base, outline, body, snapshot, diagram, example };
}
