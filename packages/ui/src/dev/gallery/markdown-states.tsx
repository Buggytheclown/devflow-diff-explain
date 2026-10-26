import { fixtureIteration } from '@sherpa/fixtures';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { galleryActions } from './diff-states.tsx';

const BASE = fixtureIteration('medium').diff.files[0];
if (BASE === undefined) {
    throw new Error('нет файла фикстуры');
}

// Карточка держит весь словарь разметки: заголовок, жирный, инлайн-код, ссылка,
// таблица, оба списка, цитата и блок кода — иначе часть стилей нечем принимать.
const LINES = [
    '# Контракт просмотра',
    '',
    'Выделите **нижняя граница**, чтобы спросить агента о смысле: порог лежит в `viewed.threshold`, ' +
        'разбор — в [описании остановки](https://example.test/stop-2).',
    'Комментарий останется у этих строк и в режиме кода.',
    '',
    '| Статус | Значение |',
    '| --- | --- |',
    '| OK | Поиск завершён |',
    '| Timeout | Результат неполный |',
    '',
    '- Первая категория',
    '  - Независимый фильтр',
    '',
    '1. Считаем строки',
    '2. Считаем объяснённые',
    '',
    '> Счётчик может быть неполным.',
    '',
    '```ts',
    'const limit = 10;',
    '```',
];

const FILE = {
    ...BASE,
    fileId: 'markdown-gallery',
    path: 'docs/contract.md',
    additions: LINES.length,
    deletions: 0,
    changeType: 'add' as const,
    patch: `@@ -0,0 +1,${String(LINES.length)} @@\n${LINES.map((line) => '+' + line).join('\n')}`,
};

function State() {
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: [FILE] });
        created.toggleMarkdown(FILE.fileId);
        return created;
    }, []);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const model = useMemo(() => parseFileDiff(toParseRequest(FILE)), []);

    return (
        <FileCard
            file={FILE}
            model={model}
            mode="unified"
            content={null}
            contentAvailable={false}
            expansion={new Map()}
            read={readStateOf({ file: FILE, record: null })}
            opened
            showWhitespace={false}
            markdown={snapshot.markdownShown.has(FILE.fileId)}
            selection={snapshot.selection}
            actions={galleryActions(store)}
            renderAfterLine={(_side, line) =>
                line === 3 ? (
                    // Обёртка раскрытого треда: его отступ в документе сверяется с текстом блока.
                    <div className="thread-line">
                        <div className="file-card__notice">Комментарий ревьюера: уточнить смысл нижней границы.</div>
                    </div>
                ) : null
            }
        />
    );
}

export const MARKDOWN_STATES = [
    { id: 'markdown-review', title: 'документ, выделение и общее обсуждение', render: () => <State /> },
];
