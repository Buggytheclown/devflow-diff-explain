import { expect, it } from 'vitest';
import type { RouteSnapshot } from './route.js';
import { preparationProgress } from './preparation.js';

function snapshot(readyFiles: number, flow: 'ready' | 'pending' | 'unavailable' | 'not_applicable' = 'unavailable', readyBlocks = 6) {
    // Геометрия готовности независима от содержимого патчей и их приёмки.
    let index = 0;
    return { snapshotId: 'new', storyContractVersion: 5, commit: 'head', flow: { status: flow },
        stops: Array.from({ length: 6 }, (_, b) => ({ paragraph: b < readyBlocks ? 'intro' : null, guidedFiles: Array.from({ length: b === 0 ? 4 : 5 }, () => ({ explanation: index++ < readyFiles ? 'ready' : null })) })) } as unknown as RouteSnapshot;
}
it('описание даёт 1/37, схема 2/37, шесть вводных и 18 файлов — 26/37', () => {
    expect(preparationProgress({ phase: 'filling', snapshot: snapshot(0, 'pending', 0) })).toMatchObject({ completed: 1, total: 37, percent: 2 });
    expect(preparationProgress({ phase: 'filling', snapshot: snapshot(0, 'ready', 0) })).toMatchObject({ completed: 2, total: 37, percent: 5 });
    expect(preparationProgress({ phase: 'filling', snapshot: snapshot(18, 'ready') })).toMatchObject({ completed: 26, total: 37, percent: 70 });
});
it('считает 2 + блоки + файлы; ошибка схемы оставляет 36/37, неприменимость завершает', () => {
    const route = { phase: 'ready', snapshot: snapshot(30) };
    expect(preparationProgress(route)).toMatchObject({ completed: 36, total: 37, percent: 97, status: 'partial' });
    expect(preparationProgress({ ...route, snapshot: snapshot(30, 'not_applicable') })).toMatchObject({ completed: 37, percent: 100, status: 'ready' });
});
it('готовые материалы предыдущего разбора не входят в новую подготовку', () => {
    expect(preparationProgress({ phase: 'reading', snapshot: snapshot(30, 'ready'), generation: { id: 'generation', commit: 'next', snapshotId: null, previousSnapshotId: 'new', status: 'running' } })).toMatchObject({ completed: 0, total: null, snapshotId: null, status: 'planning' });
});
it('отмена и старый формат не выдаются за полностью завершённую новую подготовку', () => {
    const saved = snapshot(30, 'ready');
    expect(preparationProgress({ phase: 'failed', snapshot: saved, generation: { id: 'g', commit: 'head', snapshotId: 'new', previousSnapshotId: null, status: 'cancelled' } }).status).toBe('cancelled');
    expect(preparationProgress({ phase: 'ready', snapshot: { ...saved, storyContractVersion: 4 } })).toMatchObject({ status: 'legacy', total: null, percent: null });
});
