import type { UiTask, WorkerStatus } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

/**
 * Индикатор агента (docs/design/SPEC-elements.md §2.2): четыре состояния поверх реального
 * статуса воркера.
 * Вычисление вынесено из компонента — его гоняют юнит-тесты и галерея состояний.
 */

export type AgentTone = 'connected' | 'working' | 'failed' | 'disconnected';

export interface AgentPillView {
    readonly tone: AgentTone;
    readonly workerKind: WorkerStatus['kind'];
    readonly label: string;
    /** Тултип: харнес, модель, время жизни сессии и длина очереди (docs/design/SPEC-elements.md §2.2). */
    readonly title: string;
}

/**
 * Задача в работе или ждёт своей очереди — то, что агенту ещё предстоит сделать. Отменённая,
 * которую воркер ещё держит, тоже считается: он занят ею, пока не отзовётся.
 */
function isPending(task: UiTask): boolean {
    return task.status === 'queued' || task.heldByWorker;
}

/**
 * «Последняя задача упала»: провал новее последнего успеха. Успех сбрасывает состояние —
 * иначе одна старая ошибка красила бы индикатор до конца сессии.
 */
function lastTaskFailed(tasks: readonly UiTask[]): boolean {
    const latestOf = (status: UiTask['status']): number =>
        tasks
            .filter((task) => task.status === status)
            .reduce((latest, task) => Math.max(latest, Date.parse(task.updatedAt)), Number.NEGATIVE_INFINITY);

    return latestOf('failed') > latestOf('done');
}

export function agentPillView(worker: WorkerStatus, tasks: readonly UiTask[], t: Translate): AgentPillView {
    const pending = tasks.filter(isPending);

    if (worker.kind !== 'connected') {
        return {
            tone: 'disconnected',
            workerKind: worker.kind,
            label: t('agent.disconnected'),
            title:
                worker.kind === 'never'
                    ? t('agent.neverConnected')
                    : t('agent.notResponding', identity(worker), pending.length),
        };
    }

    // Время жизни сессии считается по данным сервера, а не по часам браузера: так индикатор
    // остаётся чистой функцией состояния и одинаково рендерится в галерее и в тестах.
    const uptime = formatUptime(Date.parse(worker.lastSeenAt) - Date.parse(worker.registeredAt), t);
    const title = t('agent.uptime', identity(worker), uptime, pending.length);

    // «Работает» — есть что делать, независимо от класса приоритета: генерация маршрута ставится
    // фоновой, но ревьюер ждёт её у экрана ровно так же.
    if (pending.length > 0) {
        return {
            tone: 'working',
            workerKind: worker.kind,
            label: t('agent.working', pending.length),
            title,
        };
    }

    if (lastTaskFailed(tasks)) {
        return { tone: 'failed', workerKind: worker.kind, label: t('agent.taskFailed'), title };
    }

    return {
        tone: 'connected',
        workerKind: worker.kind,
        label: t('agent.idle', worker.harness ?? worker.workerId),
        title,
    };
}

/**
 * Чем представился воркер: харнес и модель — свободные строки, обе необязательны,
 * поэтому id сессии в тултипе есть всегда (docs/design/SPEC-elements.md §2.2).
 */
function identity(worker: Extract<WorkerStatus, { workerId: string }>): string {
    return [
        ...(worker.harness === undefined ? [] : [worker.harness]),
        ...(worker.model === undefined ? [] : [worker.model]),
        worker.workerId,
    ].join(' · ');
}

function formatUptime(ms: number, t: Translate): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 60) {
        return t('agent.uptime.minutes', minutes);
    }

    const hours = Math.floor(minutes / 60);
    return t('agent.uptime.hours', hours, minutes % 60);
}
