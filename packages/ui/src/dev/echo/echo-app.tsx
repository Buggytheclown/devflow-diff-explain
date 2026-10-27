import type { PriorityClass, TaskStatus, UiState, UiTask, WorkerStatus } from '@sherpa/protocol';
import { useState, useSyncExternalStore } from 'react';

import { ApiError, cancelTask, enqueueEchoTask } from '../../api.js';
import { copyText } from '../../components/clipboard.js';
import type { Store, StoreSnapshot } from '../../store.js';

/**
 * Демо петли агента: статус воркера, постановка echo-задачи и очередь с результатами.
 * Живёт в дев-режиме (`dev.html`) — это инструмент прогона ручной матрицы харнесов,
 * а не продуктовый экран: продуктовая главная страница — читалка PR.
 */
export interface EchoAppProps {
    readonly store: Store;
    readonly token: string;
}

export function EchoApp({ store, token }: EchoAppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

    if (snapshot.connection === 'fatal') {
        return (
            <main className="screen screen--message">
                <h1>Шерпа остановилась</h1>
                <p>{snapshot.error}</p>
            </main>
        );
    }

    if (snapshot.state === null) {
        return (
            <main className="screen screen--message">
                <h1>Шерпа</h1>
                <p>{snapshot.connection === 'connecting' ? 'Подключаюсь к серверу…' : 'Сервер недоступен, переподключаюсь…'}</p>
            </main>
        );
    }

    return <Screen state={snapshot.state} connection={snapshot.connection} token={token} />;
}

function Screen({
    state,
    connection,
    token,
}: {
    state: UiState;
    connection: StoreSnapshot['connection'];
    token: string;
}) {
    return (
        <main className="screen">
            <header className="header">
                <WorkerPill worker={state.worker} />
                <span className="header__pr">{state.prKey}</span>
            </header>

            {connection === 'reconnecting' ? (
                <div className="banner banner--warn">
                    <strong>Сервер недоступен, переподключаюсь…</strong>
                    <p>На экране последнее известное состояние. Как только связь вернётся, оно обновится само.</p>
                </div>
            ) : null}

            {state.worker.kind === 'disconnected' ? <DisconnectedBanner prKey={state.prKey} /> : null}

            <EnqueueForm token={token} />
            <TaskList tasks={state.tasks} worker={state.worker} token={token} />
        </main>
    );
}

function WorkerPill({ worker }: { worker: WorkerStatus }) {
    return (
        <span className={`pill pill--${worker.kind}`}>
            <span className="pill__dot" aria-hidden="true" />
            {workerLabel(worker)}
        </span>
    );
}

function workerLabel(worker: WorkerStatus): string {
    switch (worker.kind) {
        case 'never':
            return 'Агент ещё не подключался';
        case 'connected':
            return `Агент · ${workerIdentity(worker.harness, worker.model, worker.workerId)}`;
        case 'disconnected':
            return 'Агент отключён';
    }
}

/**
 * Чем представился воркер: харнес и модель — свободные строки, обе необязательны.
 * Без харнеса остаётся workerId — иначе в статусе не за что зацепиться глазом.
 */
function workerIdentity(harness: string | undefined, model: string | undefined, workerId: string): string {
    return [harness ?? workerId, ...(model === undefined ? [] : [model])].join(' · ');
}

/** Баннер состояния «агент отключён» (docs/spec.md): что случилось, следствие, одно действие. */
function DisconnectedBanner({ prKey }: { prKey: string }) {
    return (
        <div className="banner banner--offline">
            <strong>Агент отключён</strong>
            <p>Сессия перестала отвечать: задачи стоят в очереди, пока агент не вернётся.</p>
            <p>Запусти скилл Шерпы в агентской сессии заново — он зарегистрирует новую сессию воркером:</p>
            <CopyCommand command={`devflow-diff-explain worker register --pr ${prKey}`} />
        </div>
    );
}

function CopyCommand({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);

    const copy = (): void => {
        void copyText(command).then((outcome) => {
            setCopied(outcome === 'copied');
        });
    };

    return (
        <p className="command">
            <code>{command}</code>
            <button type="button" onClick={copy}>
                {copied ? 'Скопировано' : 'Копировать'}
            </button>
        </p>
    );
}

function EnqueueForm({ token }: { token: string }) {
    const [text, setText] = useState('');
    const [priority, setPriority] = useState<PriorityClass>('interactive');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = (): void => {
        if (pending || text.trim() === '') {
            return;
        }

        setPending(true);
        setError(null);
        enqueueEchoTask(token, text, priority)
            .then(() => {
                setText('');
            })
            .catch((failure: unknown) => {
                setError(messageOf(failure));
            })
            .finally(() => {
                setPending(false);
            });
    };

    return (
        <form
            className="enqueue"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <label className="enqueue__label" htmlFor="echo-text">
                Текст echo-задачи
            </label>
            <textarea
                id="echo-text"
                className="enqueue__text"
                value={text}
                rows={3}
                maxLength={4000}
                placeholder="Агент вернёт этот текст как результат"
                onChange={(event) => {
                    setText(event.target.value);
                }}
            />
            <div className="enqueue__actions">
                <select
                    className="enqueue__priority"
                    aria-label="Приоритет"
                    value={priority}
                    onChange={(event) => {
                        setPriority(event.target.value === 'background' ? 'background' : 'interactive');
                    }}
                >
                    <option value="interactive">интерактивная</option>
                    <option value="background">фоновая</option>
                </select>
                <button type="submit" disabled={pending || text.trim() === ''}>
                    Поставить echo-задачу
                </button>
            </div>
            {error === null ? null : <p className="enqueue__error">{error}</p>}
        </form>
    );
}

function TaskList({ tasks, worker, token }: { tasks: readonly UiTask[]; worker: WorkerStatus; token: string }) {
    if (tasks.length === 0) {
        return <p className="tasks__empty">Задач пока нет.</p>;
    }

    // Новые сверху: сервер отдаёт очередь в порядке постановки.
    return (
        <ul className="tasks">
            {[...tasks].reverse().map((task) => (
                <li key={task.id}>
                    <TaskCard task={task} worker={worker} token={token} />
                </li>
            ))}
        </ul>
    );
}

function TaskCard({ task, worker, token }: { task: UiTask; worker: WorkerStatus; token: string }) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const cancel = (): void => {
        setPending(true);
        setError(null);
        cancelTask(token, task.id)
            .catch((failure: unknown) => {
                setError(messageOf(failure));
            })
            .finally(() => {
                setPending(false);
            });
    };

    const cancellable = task.status === 'queued' || task.status === 'leased';

    return (
        <article className={`task task--${task.status}`}>
            <header className="task__header">
                <code className="task__id">sherpa/{task.id}</code>
                <span className="task__meta">
                    {task.type} · {task.priority === 'interactive' ? 'интерактивная' : 'фоновая'}
                </span>
                <span className="task__status">{statusLabel(task.status)}</span>
                {task.attempt > 1 ? <span className="task__meta">попытка {task.attempt}</span> : null}
                {cancellable ? (
                    <button type="button" onClick={cancel} disabled={pending}>
                        Отменить
                    </button>
                ) : null}
            </header>

            {task.status === 'leased' ? <LeasedDetails task={task} worker={worker} /> : null}

            {task.result === null ? null : (
                <details className="task__result">
                    <summary>Результат</summary>
                    <pre>{task.result}</pre>
                </details>
            )}

            {task.failReason === null ? null : <p className="task__fail">Причина: {task.failReason}</p>}
            {error === null ? null : <p className="task__fail">{error}</p>}
        </article>
    );
}

/**
 * Задача в аренде. Аренда переживает смерть сессии: воркер считается отключённым раньше, чем
 * истекает lease (`WORKER_DEAD_AFTER_SECONDS` меньше любого `LEASE_TTL_SECONDS`), поэтому есть
 * окно, когда агента уже нет, а статус задачи всё ещё `leased` — писать «агент работает» в нём
 * нельзя, это противоречило бы баннеру «агент отключён» на том же экране (docs/protocol.md §5, §7).
 */
function LeasedDetails({ task, worker }: { task: UiTask; worker: WorkerStatus }) {
    const progress = task.progressText === null ? '' : `: ${task.progressText}`;

    if (worker.kind === 'disconnected') {
        return (
            <>
                <p className="task__progress">
                    задача осталась в аренде у отключённого агента
                    {task.progressText === null ? '' : `; последнее, что он сообщил: ${task.progressText}`}
                </p>
                <p className="task__hint">
                    Вернётся в очередь, когда истечёт аренда, — или раньше, если отменить её вручную.
                </p>
            </>
        );
    }

    return (
        <>
            <p className="task__progress">агент работает{progress}</p>
            {/* docs/protocol.md §5: прервать сессию нельзя — отмена доходит до агента при следующем вызове. */}
            <p className="task__hint">Отмена дойдёт до агента при следующем вызове CLI.</p>
        </>
    );
}

function statusLabel(status: TaskStatus): string {
    switch (status) {
        case 'queued':
            return 'в очереди';
        case 'leased':
            return 'у агента';
        case 'done':
            return 'готово';
        case 'failed':
            return 'ошибка';
        case 'cancelled':
            return 'отменена';
    }
}

function messageOf(failure: unknown): string {
    if (failure instanceof ApiError) {
        return failure.message;
    }
    return 'Не получилось: неизвестная ошибка. Посмотри вывод сервера в терминале.';
}
