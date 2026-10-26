import type { Thread } from '@sherpa/protocol';

import { Avatar } from '../components/avatar.tsx';
import { useT } from '../i18n/index.js';
import { authorName, commentFirstLine, threadCommentCount } from './model.js';
import type { ThreadStore } from './store.js';

/**
 * Свёрнутый тред у кода — маркер на левой кромке карточки (docs/design/SPEC-changes-2026-09-20.md §3).
 * Он парит над границей: сетка ряда не меняется, колонки под маркеры нет, ширина кода прежняя.
 * Несколько тредов одной строки дают один маркер с суммарным счётчиком.
 */
export function ThreadMarker({
    threads,
    store,
    openThreads,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    openThreads: ReadonlySet<string>;
}) {
    const t = useT();
    const first = threads[0];
    if (first === undefined) {
        return null;
    }
    // Маркер раскрыт, только когда раскрыты все треды строки: иначе клик по нему прятал бы
    // видимый тред вместо того, чтобы достать скрытый (на строке рядом живут обычный и resolved).
    const open = threads.every((thread) => openThreads.has(thread.id));
    const partly = !open && threads.some((thread) => openThreads.has(thread.id));
    const resolved = threads.every((thread) => thread.resolved);
    const messages = threads.reduce((total, thread) => total + threadCommentCount(thread), 0);
    const author = first.root.author.bot ? first.root.author.login : authorName(first.root);
    const preview = commentFirstLine(first.root.body, 60);
    return (
        <button
            type="button"
            className={`ctl thread-marker${open ? ' is-open' : ''}${partly ? ' is-partly-open' : ''}${resolved ? ' thread-marker--resolved' : ''}`}
            aria-expanded={open}
            aria-label={t('thread.marker.aria', messages)}
            title={t(open ? 'thread.marker.collapse' : 'thread.marker.expand', author, preview)}
            // Маркер лежит внутри `.diff-row`, а выделение строк начинается с mousedown по ряду
            // (`file-card` → `onSelectStart`). Без остановки клик по маркеру заодно выделял бы строку.
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
            onClick={() => {
                store.setThreadsOpen(
                    threads.map((thread) => thread.id),
                    !open,
                );
            }}
        >
            <Avatar
                className="thread-marker__avatar"
                name={first.root.author.displayName ?? first.root.author.login}
                url={first.root.author.avatarUrl}
            />
            <span className="thread-marker__count" aria-hidden="true">
                {resolved ? '✓' : messages}
            </span>
        </button>
    );
}
