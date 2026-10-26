import { describe, expect, it, vi } from 'vitest';

import type { MessageKey } from '../../i18n/index.js';
import { createT, translateKey } from '../../i18n/index.js';
import { createSessionStore } from '../../session/session-store.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { generateCommand, PRESET_COMMAND_LABEL, presetCommand } from './route-commands.tsx';

/**
 * Команда «переключить пресет» — одно объявление на шорткат `t` и палитру (docs/design/SPEC-elements.md §5).
 * Реестр общий, поэтому проверяется и её описание, и то, что делает `action`.
 */

/** Подписи команд — ключи словаря; тест сверяет русскую формулировку, а не ключ. */
const ru = (key: MessageKey | undefined): string =>
    key === undefined ? '' : translateKey(createT('ru'), key);

function keyEvent(key: string) {
    return {
        key,
        code: '',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
    };
}

describe('команда переключения пресета', () => {
    it('объявлена под клавишей t с той же формулировкой, что в палитре', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const command = presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        });

        expect(command.keys).toEqual(['t']);
        expect(command.label).toBe(PRESET_COMMAND_LABEL);
        expect(command.consequence).toBe('shortcut.route.preset.tour');
        expect(ru(command.consequence)).toBe('переставит остановки в порядок чтения');
    });

    it('переключает пресет туда и обратно, оставаясь на маршруте', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const run = (): void => {
            presetCommand({
                preset: session.getSnapshot().preset,
                setPreset: session.setPreset,
                setView: session.setView,
            }).action();
        };

        run();
        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'tour' });

        run();
        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'triage' });
    });

    it('выбирает вью и с самого маршрута: иначе Review complete остался бы на экране', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const before = session.getViewSelectionSnapshot();

        presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        }).action();

        expect(session.getViewSelectionSnapshot()).toBe(before + 1);
    });

    it('с полного диффа переключает пресет и уводит на маршрут', () => {
        const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        }).action();

        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'tour' });
    });

    it('живёт в общем реестре: клавиша t доходит до неё, команда видна палитре', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const registry = createShortcutRegistry();
        registry.register(
            presetCommand({
                preset: 'triage',
                setPreset: session.setPreset,
                setView: session.setView,
            }),
        );

        expect(registry.handle(keyEvent('t'))).toBe(true);
        expect(session.getSnapshot().preset).toBe('tour');
        expect(registry.list().map((shortcut) => shortcut.label)).toContain(PRESET_COMMAND_LABEL);
    });
});

describe('команда генерации маршрута', () => {
    const run = (
        phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed',
        smallPr = false,
        generating = false,
    ) => {
        const calls: number[] = [];
        const command = generateCommand({
            phase,
            smallPr,
            generating,
            onGenerate: () => {
                calls.push(calls.length + 1);
            },
        });
        return { command, calls };
    };

    it('в ready и failed называется перегенерацией и честно называет отложенное следствие', () => {
        for (const phase of ['ready', 'failed'] as const) {
            const { command } = run(phase);
            expect(ru(command.label)).toBe('Перегенерировать маршрут');
            expect(ru(command.consequence)).toBe('сбросит отметки остановок, когда новый маршрут приедет');
            expect(command.when?.()).toBe(true);
        }
    });

    it('маршрута ещё не было — предлагает построить', () => {
        const { command } = run('none');

        expect(ru(command.label)).toBe('Построить маршрут');
        expect(command.when?.()).toBe(true);
    });

    it('пока генерация идёт — команда скрыта: сервер ответил бы отказом', () => {
        expect(run('reading').command.when?.()).toBe(false);
        expect(run('filling').command.when?.()).toBe(false);
    });

    it('запрос уже в полёте — команда скрыта, пока фаза не сдвинулась', () => {
        expect(run('failed', false, true).command.when?.()).toBe(false);
        expect(run('none', false, true).command.when?.()).toBe(false);
        expect(run('ready', false, true).command.when?.()).toBe(false);
    });

    it('малый PR порога не обходит — команды нет ни в одной фазе', () => {
        expect(run('none', true).command.when?.()).toBe(false);
        expect(run('failed', true).command.when?.()).toBe(false);
        expect(run('ready', true).command.when?.()).toBe(false);
    });

    it('видна палитре и зовёт генерацию', () => {
        const registry = createShortcutRegistry();
        const { command, calls } = run('failed');
        registry.register(command);

        registry.list().find((shortcut) => shortcut.id === 'route.generate')?.action();

        expect(calls).toHaveLength(1);
    });
});
