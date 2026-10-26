import type { RouteSnapshot, UiRoutePhase } from '@sherpa/protocol';

import type { MessageKey } from '../../i18n/index.js';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import { routeGenerationAvailable } from '../../route/generation.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import { visibleStops } from '../../route/other-stop.js';
import { planLabel } from '../../route/route-model.js';
import type { RoutePreset } from '../../session/session-store.js';
import type { ViewId } from '../../session/views.js';
import { useShortcut } from '../../shortcuts/context.tsx';
import type { Shortcut } from '../../shortcuts/registry.js';

/**
 * Команды палитры «перейти к остановке NN» (docs/design/README.md §14, группа `route`). Живут на уровне
 * приложения, а не вью: команда обязана работать и с полного диффа — она сама переключает
 * вью на маршрут и доводит прокрутку.
 *
 * Одна команда — один компонент: хуки в цикле объявлять нельзя, а список остановок меняется.
 */
export function RouteCommands({
    snapshot,
    other,
    onJump,
}: {
    snapshot: RouteSnapshot;
    other: OtherStopFacts;
    onJump: (stopId: string) => void;
}) {
    return (
        <>
            {visibleStops(snapshot, other).map((stop) => (
                <StopCommand
                    key={stop.id}
                    id={stop.id}
                    stop={`${planLabel(stop.planIndex)} · ${stripInlineCode(stop.title)}`}
                    onJump={onJump}
                />
            ))}
        </>
    );
}

/** Подпись команды и шортката `t` — одна на двоих: реестр общий (docs/design/SPEC-elements.md §5). */
export const PRESET_COMMAND_LABEL: MessageKey = 'shortcut.route.togglePreset';

export interface PresetCommandInput {
    readonly preset: RoutePreset;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setView: (view: ViewId) => void;
}

/**
 * Шорткат `t` и команда палитры «переключить пресет» (docs/design/SPEC-elements.md §5) — одно объявление на двоих.
 * Пресет это состояние маршрута, но команда работает и с полного диффа: как «перейти
 * к остановке», она сама уводит на маршрут.
 */
export function presetCommand({ preset, setPreset, setView }: PresetCommandInput): Shortcut {
    const next: RoutePreset = preset === 'tour' ? 'triage' : 'tour';
    return {
        id: 'route.togglePreset',
        keys: ['t'],
        label: PRESET_COMMAND_LABEL,
        scope: 'global',
        section: 'route',
        consequence: next === 'tour' ? 'shortcut.route.preset.tour' : 'shortcut.route.preset.triage',
        action: () => {
            setPreset(next);
            // Выбор вью зовётся и с самого маршрута: это единственный способ снять с экрана
            // Review complete, иначе пресет менялся бы под терминальным экраном молча.
            setView('route');
        },
    };
}

/**
 * Команда живёт рядом с командами остановок — на уровне приложения, и только при готовом
 * маршруте: переключать нечего, пока маршрута нет (docs/design/SPEC-elements.md §2.5).
 */
export function RoutePresetCommand(input: PresetCommandInput) {
    useShortcut(presetCommand(input));
    return null;
}

export interface GenerateCommandInput {
    readonly phase: UiRoutePhase | null;
    readonly smallPr: boolean;
    /** Запрос уже в полёте: фаза ещё не сдвинулась, но второму запросу тут делать нечего. */
    readonly generating: boolean;
    readonly onGenerate: () => void;
}

/**
 * «Построить / перегенерировать маршрут» (docs/design/README.md §14). В `ready` и `failed` старый маршрут
 * остаётся читаемым до принятого нового скелета.
 *
 * Пока генерация идёт, команда скрыта: сервер ответил бы `already_running`. То же и в промежутке
 * между запросом и сменой фазы — там команда скрыта по `generating`. Малый PR порога не обходит
 * (docs/architecture.md §7.6) — там её тоже нет.
 */
export function generateCommand({ phase, smallPr, generating, onGenerate }: GenerateCommandInput): Shortcut {
    return {
        id: 'route.generate',
        keys: [],
        label: phase === 'none' ? 'shortcut.route.generate' : 'shortcut.route.regenerate',
        scope: 'global',
        section: 'route',
        consequence: 'shortcut.route.generate.consequence',
        when: () => routeGenerationAvailable({ phase, smallPr, generating }),
        action: onGenerate,
    };
}

export function RouteGenerateCommand(input: GenerateCommandInput) {
    useShortcut(generateCommand(input));
    return null;
}

function StopCommand({ id, stop, onJump }: { id: string; stop: string; onJump: (stopId: string) => void }) {
    useShortcut({
        id: `route.stop.${id}`,
        keys: [],
        label: 'shortcut.route.stop',
        labelArg: stop,
        scope: 'global',
        section: 'route',
        action: () => {
            onJump(id);
        },
    });
    return null;
}
