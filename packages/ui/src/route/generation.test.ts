import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteState, UiTask } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';
import {
    generationCardKind,
    generationIsLong,
    generationProgress,
    LONG_GENERATION_MS,
    openRouteTasks,
    provenanceLine,
    routeActionErrorInPlace,
    routeGenerationAvailable,
    routeViewKind,
    snapshotLocale,
} from './generation.js';
import { snapshotFilling } from './other-stop.js';

/** Модель генеративных состояний: разводка фаз и числа «N из M» — всё от данных фикстуры. */

function state(phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures('medium')?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`фикстуре medium нужно состояние ${phase}`);
    }
    return fixture;
}

function snapshotOf(phase: 'filling' | 'ready'): RouteSnapshot {
    const snapshot = state(phase).snapshot;
    if (snapshot === null) {
        throw new Error(`состоянию ${phase} нужен снапшот`);
    }
    return snapshot;
}

function rebuildState(phase: 'reading' | 'failed'): UiRouteState {
    return {
        ...state(phase),
        snapshot: snapshotOf('ready'),
    };
}

function task(overrides: Partial<UiTask> & Pick<UiTask, 'id'>): UiTask {
    return {
        type: 'route.skeleton',
        priority: 'background',
        status: 'queued',
        heldByWorker: overrides.status === 'leased',
        attempt: 1,
        instructions: 'построй скелет',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-08-24T12:00:00.000Z',
        updatedAt: '2026-08-24T12:00:00.000Z',
        ...overrides,
    };
}

describe('разводка фаз вкладки «Маршрут»', () => {
    it('готовый и частично заполненный маршрут рисуются одним и тем же вью', () => {
        expect(routeViewKind(state('ready'))).toBe('workspace');
        expect(routeViewKind(state('filling'))).toBe('workspace');
    });

    it('перестройка и её провал со старым снапшотом остаются рабочим маршрутом', () => {
        expect(routeViewKind(rebuildState('reading'))).toBe('workspace');
        expect(routeViewKind(rebuildState('failed'))).toBe('workspace');
    });

    it('чтение и провал без снапшота, малый PR и приглашение — каждый своим экраном', () => {
        expect(routeViewKind(state('reading'))).toBe('reading');
        expect(routeViewKind(state('failed'))).toBe('failed');
        expect(routeViewKind(routeFixtures('small')?.states.none ?? null)).toBe('small-pr');
        expect(routeViewKind(state('none'))).toBe('invitation');
        expect(routeViewKind(null)).toBe('invitation');
    });

    it('фаза без своих данных деградирует в приглашение, а не в пустой экран', () => {
        expect(routeViewKind({ phase: 'ready', smallPr: false, snapshot: null, failure: null, stale: null })).toBe('invitation');
        expect(routeViewKind({ phase: 'failed', smallPr: false, snapshot: null, failure: null, stale: null })).toBe('invitation');
    });
});

describe('карточка генерации в рельсе Overview', () => {
    it('говорит в фазах чтения, заполнения, готовности и провала — и молчит в остальных', () => {
        expect(generationCardKind(state('reading'))).toBe('reading');
        expect(generationCardKind(state('filling'))).toBe('filling');
        expect(generationCardKind(state('ready'))).toBe('ready');
        expect(generationCardKind(state('failed'))).toBe('failed');
        expect(generationCardKind(state('none'))).toBeNull();
        expect(generationCardKind(null)).toBeNull();
    });
});

describe('доступность генерации маршрута', () => {
    it('одинаково закрывает палитру, баннер и карточку во время генерации и на малом PR', () => {
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'failed', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'none', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'reading', smallPr: false, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'filling', smallPr: false, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: false, generating: true })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: true, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: null, smallPr: false, generating: false })).toBe(false);
    });
});

describe('где показывать ошибку ручки генерации', () => {
    it('рядом с вызвавшим действием: красная карточка маршрута и карточка генерации Overview', () => {
        expect(routeActionErrorInPlace('route', state('failed'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('failed'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('reading'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('filling'))).toBe(true);
    });

    it('«Построить маршрут» из палитры в фазе none: места под причину нет — её берёт слот', () => {
        expect(routeActionErrorInPlace('route', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('overview', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('diff', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('diff', state('failed'))).toBe(false);
        expect(routeActionErrorInPlace('route', state('reading'))).toBe(false);
        expect(routeActionErrorInPlace('route', rebuildState('failed'))).toBe(false);
        // У готового маршрута строки под ошибку в карточке нет.
        expect(routeActionErrorInPlace('overview', state('ready'))).toBe(false);
    });
});

describe('прогресс заполнения маршрута', () => {
    it('числа берутся из статусов слотов фикстуры, а не из картинки в дизайн-хендоффе', () => {
        const progress = generationProgress(snapshotOf('filling'));

        // «Прочего» на недостроенном маршруте нет: s01, s02, s05 заполнены — три из шести.
        expect(progress.total).toBe(6);
        expect(progress.ready).toBe(3);
        expect(progress.slots.map((slot) => slot.status)).toEqual([
            'ready',
            'ready',
            'queued',
            'queued',
            'ready',
            'filling',
        ]);
        expect(progress.slots.map((slot) => slot.planLabel)).toEqual(['01', '02', '03', '04', '05', '06']);
    });

    it('готовый снапшот заполненным больше не считается', () => {
        expect(snapshotFilling(snapshotOf('ready'))).toBe(false);
        expect(snapshotFilling(snapshotOf('filling'))).toBe(true);
    });

    it('на готовом маршруте «Прочее» входит в план, только когда ему есть что показать', () => {
        expect(generationProgress(snapshotOf('ready')).total).toBe(6);
        expect(generationProgress(snapshotOf('ready'), { uncovered: 0, conflictFiles: 0 }).total).toBe(6);
        const withOther = generationProgress(snapshotOf('ready'), { uncovered: 38, conflictFiles: 0 });
        expect(withOther.total).toBe(7);
        expect(withOther.ready).toBe(7);
        expect(withOther.slots.at(-1)?.planLabel).toBe('07');
    });
});

describe('долгая генерация', () => {
    it('открытыми считаются только задачи маршрута в очереди и в аренде', () => {
        const tasks = [
            task({ id: 1, status: 'queued' }),
            task({ id: 2, status: 'leased', type: 'route.section' }),
            task({ id: 3, status: 'done' }),
            task({ id: 4, status: 'queued', type: 'echo', priority: 'interactive' }),
            // Отменённую секцию воркер ещё крутит, но генерация уже не идёт и не блокируется.
            task({ id: 5, status: 'cancelled', type: 'route.section', heldByWorker: true }),
        ];

        expect(openRouteTasks(tasks).map((item) => item.id)).toEqual([1, 2]);
    });

    it('порог — минута от постановки самой старой открытой задачи', () => {
        const created = Date.parse('2026-08-24T12:00:00.000Z');
        const tasks = [task({ id: 1 })];

        expect(generationIsLong(tasks, created + LONG_GENERATION_MS - 1)).toBe(false);
        expect(generationIsLong(tasks, created + LONG_GENERATION_MS)).toBe(true);
        expect(generationIsLong([task({ id: 1, status: 'done' })], created + 600_000)).toBe(false);
    });
});

describe('summary и провенанс', () => {
    it('провенанс — харнес, модель и короткий коммит', () => {
        expect(provenanceLine(snapshotOf('ready'), createT('ru'), 'ru')).toBe(
            `claude-code · claude-opus-5 · ${snapshotOf('ready').commit.slice(0, 7)}`,
        );
    });

    it('пустой провенанс не оставляет висящих разделителей', () => {
        const snapshot = { ...snapshotOf('ready'), provenance: { harness: null, model: null, locale: null } };

        expect(provenanceLine(snapshot, createT('ru'), 'ru')).toBe(snapshot.commit.slice(0, 7));
    });

    it('язык маршрута дописывается только при расхождении с языком вкладки', () => {
        const ready = snapshotOf('ready');
        const english = { ...ready, provenance: { ...ready.provenance, locale: 'en' as const } };

        // Снапшот без записанного языка (`locale: null`) читается как русский.
        expect(provenanceLine(ready, createT('ru'), 'ru')).not.toContain('русский');
        expect(provenanceLine(ready, createT('en'), 'en')).toContain('Russian');
        expect(provenanceLine(english, createT('ru'), 'ru')).toContain('английский');
        expect(provenanceLine(english, createT('en'), 'en')).not.toContain('English');
    });

    it('локаль снапшота: null — русский', () => {
        expect(snapshotLocale({ harness: null, model: null, locale: null })).toBe('ru');
        expect(snapshotLocale({ harness: null, model: null, locale: 'en' })).toBe('en');
    });
});
