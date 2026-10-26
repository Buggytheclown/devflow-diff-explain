import { fixtureIteration } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { readStateOf } from '../progress/read-state.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { BlobLoaderProvider } from './blob-loader.tsx';
import type { FileCardActions } from './file-card.tsx';
import { expansionAnnouncement, FileCard } from './file-card.tsx';
import { createT } from '../i18n/index.js';

const t = createT('ru');

const DATA = fixtureIteration('edge');

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

function render(file: FileDiff, hint = false): string {
    return renderToStaticMarkup(
        <FileCard
            file={file}
            model={parseFileDiff(toParseRequest(file))}
            mode="unified"
            content={null}
            contentAvailable={false}
            expansion={new Map()}
            read={readStateOf({ file, record: null })}
            opened={false}
            showWhitespace={false}
            markdown={false}
            initialHint={
                hint
                    ? {
                          text: 'действие не выполнилось',
                          retry: () => Promise.resolve(null),
                      }
                    : null
            }
            selection={null}
            actions={ACTIONS}
        />,
    );
}

describe('карточка файла', () => {
    it('конфликтный файл получает бейдж в шапке (docs/design/SPEC-elements.md §2.14, §4.1)', () => {
        const conflict = DATA.diff.files.find((file) => file.changeType === 'conflict');
        const plain = DATA.diff.files.find((file) => file.changeType === 'modify' && !file.binary);
        if (conflict === undefined || plain === undefined) {
            throw new Error('фикстуре edge нужны конфликтный и обычный файлы');
        }

        expect(render(conflict)).toContain('file-card__badge--conflict');
        expect(render(conflict)).toContain('>conflict</span>');
        expect(render(plain)).not.toContain('file-card__badge--conflict');
    });

    it('старый путь переименования разложен на каталоги и имя — режутся они по-разному', () => {
        const renamed = DATA.diff.files.find((file) => file.oldPath !== null && file.oldPath !== file.path);
        const oldPath = renamed?.oldPath ?? null;
        if (renamed === undefined || oldPath === null) {
            throw new Error('фикстуре edge нужен переименованный файл');
        }
        const cut = oldPath.lastIndexOf('/');
        const html = render(renamed);

        expect(html).toContain(
            `<span class="file-card__old-path file-card__path-dir"><bdi>${oldPath.slice(0, cut)}</bdi></span>`,
        );
        expect(html).toContain(
            `<span class="file-card__old-path file-card__path-name"><bdi>${oldPath.slice(cut)}</bdi></span>`,
        );
    });

    it('сводка свёрнутой карточки использует переданные счётчики среза', () => {
        const file = DATA.diff.files.find(
            (candidate) => !candidate.binary && candidate.additions !== 3 && candidate.deletions !== 2,
        );
        if (file === undefined) {
            throw new Error('фикстуре edge нужен текстовый файл');
        }

        const html = renderToStaticMarkup(
            <FileCard
                file={file}
                model={parseFileDiff(toParseRequest(file))}
                mode="unified"
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file, record: null })}
                collapseReason="manual"
                onToggleCollapse={() => undefined}
                opened
                showWhitespace={false}
                markdown={false}
                counts={{ additions: 3, deletions: 2 }}
                selection={null}
                actions={ACTIONS}
            />,
        );
        const summary = html.slice(html.indexOf('file-card__collapsed--file'));

        expect(summary).toContain('+3');
        expect(summary).toContain('−2');
        expect(summary).not.toContain(`+${String(file.additions)}`);
        expect(summary).not.toContain(`−${String(file.deletions)}`);
    });
    it('в шапке кнопка меню и раскрытие контекста; blame уехал в меню, редактора нет нигде', () => {
        const source = DATA.diff.files.find((file) => !file.binary);
        if (source === undefined) {
            throw new Error('фикстуре edge нужен текстовый файл');
        }

        const html = render({ ...source, blameUrl: 'https://example.test/blame' }, true);

        // Шапка принимает фокус: после правого клика по ней меню возвращает фокус сюда.
        expect(html).toContain('class="file-card__header" tabindex="-1"');
        expect(html).toContain('file-card__header-action"');
        expect(html).toContain('aria-label="Действия с файлом"');
        expect(html).toContain('>Раскрыть файл</button>');
        // Ссылка на blame теперь живёт пунктом меню, а не отдельной ручкой шапки.
        expect(html).not.toContain('>Blame</a>');
        expect(html).not.toContain('https://example.test/blame');
        expect(html).not.toContain('Открыть в редакторе');
        // Меню закрыто — его пунктов в разметке нет.
        expect(html).not.toContain('Скопировать ссылку');
        expect(html).toContain('file-card__action">повторить</button>');
    });

    it('выключенная отметка «просмотрено» объясняет причину вместо чисел прогресса', () => {
        const file = DATA.diff.files.find((candidate) => candidate.changeType === 'modify' && !candidate.binary);
        if (file === undefined) {
            throw new Error('фикстуре edge нужен обычный файл');
        }
        const html = renderToStaticMarkup(
            <FileCard
                file={file}
                model={null}
                mode="unified"
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file, record: null })}
                viewedDisabledReason="дифф файла ещё разбирается"
                opened={false}
                showWhitespace={false}
                markdown={false}
                selection={null}
                actions={ACTIONS}
            />,
        );

        expect(html).toMatch(/<button[^>]*class="viewed-toggle[^"]*file-card__viewed"[^>]*disabled=""[^>]*title="дифф файла ещё разбирается"/);
        expect(render(file)).not.toMatch(/class="viewed-toggle[^"]*file-card__viewed"[^>]*disabled=""/);
    });

    it('оставляет нотис двоичного файла без действия', () => {
        const file = DATA.diff.files.find((candidate) => candidate.binary);
        if (file === undefined) {
            throw new Error('фикстуре edge нужен двоичный файл');
        }

        expect(file.image).toBeNull();
        const html = render(file);

        expect(html).toContain('<p class="file-card__notice">двоичный файл не показан</p>');
        expect(html).not.toContain('Открыть в редакторе');
    });

    it('картинка без транспорта блобов остаётся тем же нотисом, с транспортом — карточкой-картинкой', () => {
        const file = fixtureIteration('medium').diff.files.find((candidate) => candidate.image !== null);
        if (file === undefined) {
            throw new Error('фикстуре medium нужна картинка');
        }

        // Хост без `capabilities.blobs` транспорта не даёт — карточка ведёт себя как раньше.
        expect(render(file)).toContain('двоичный файл не показан');

        const withBlobs = renderToStaticMarkup(
            <BlobLoaderProvider loadBlob={() => Promise.resolve(null)}>
                <FileCard
                    file={file}
                    model={parseFileDiff(toParseRequest(file))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file, record: null })}
                    opened={false}
                    showWhitespace={false}
                    markdown={false}
                    selection={null}
                    actions={ACTIONS}
                />
            </BlobLoaderProvider>,
        );

        expect(withBlobs).not.toContain('двоичный файл не показан');
        expect(withBlobs).toContain('image-card__modes');
    });

    it('карточка-картинка гасит нотис двоичного, но не смену прав файла', () => {
        const svg = fixtureIteration('medium').diff.files.find(
            (candidate) => candidate.image !== null && candidate.patch !== null,
        );
        if (svg === undefined) {
            throw new Error('фикстуре medium нужна svg-картинка с патчем');
        }
        const withMode: FileDiff = { ...svg, patch: `old mode 100644\nnew mode 100755\n${svg.patch ?? ''}` };

        const html = renderToStaticMarkup(
            <BlobLoaderProvider loadBlob={() => Promise.resolve(null)}>
                <FileCard
                    file={withMode}
                    model={parseFileDiff(toParseRequest(withMode))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file: withMode, record: null })}
                    opened={false}
                    showWhitespace={false}
                    markdown={false}
                    selection={null}
                    actions={ACTIONS}
                />
            </BlobLoaderProvider>,
        );

        expect(html).toContain('image-card__modes');
        expect(html).not.toContain('двоичный файл не показан');
        expect(html).toContain(t('diff.notice.mode', '100644', '100755'));
    });
});

describe('«Раскрыть файл» на срезе маршрута', () => {
    const CLIP_SOURCE: FileDiff = {
        fileId: 'f-clip',
        path: 'src/clip.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 4,
        deletions: 0,
        patch: ['@@ -1,2 +1,6 @@', ' alpha', '+one', '+', '+two', '+three', ' omega', ''].join('\n'),
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
    const CLIP_CONTENT: FileContent = {
        oldText: 'alpha\nomega\n',
        newText: 'alpha\none\n\ntwo\nthree\nomega\n',
    };

    function renderClipped(anchors: readonly AnchorSpan[]): string {
        const model = parseFileDiff(toParseRequest(CLIP_SOURCE));
        return renderToStaticMarkup(
            <FileCard
                file={CLIP_SOURCE}
                model={clipModelToAnchors(model, anchors).model}
                mode="unified"
                content={CLIP_CONTENT}
                contentAvailable
                expansion={new Map()}
                read={readStateOf({ file: CLIP_SOURCE, record: null })}
                opened={false}
                showWhitespace={false}
                markdown={false}
                selection={null}
                actions={ACTIONS}
            />,
        );
    }

    it('называет изменённые строки чужих остановок вместо «весь файл уже на экране»', () => {
        // Между якорями на новых 2 и 5 лежат только чужие правки: hiddenLines 0, hiddenChanged 2.
        const html = renderClipped([
            { side: 'new', start: 2, end: 2 },
            { side: 'new', start: 5, end: 5 },
        ]);

        expect(html).toContain('весь контекст на экране; 2 изменённые строки — в других остановках');
        expect(html).not.toContain('весь файл уже на экране');
        expect(html).toContain('disabled=""');
    });

    it('без чужих изменённых строк оставляет прежний текст', () => {
        const html = renderClipped([{ side: 'new', start: 2, end: 5 }]);

        expect(html).toContain('весь файл уже на экране');
        expect(html).not.toContain('в других остановках');
    });
});

describe('объявление после догрузки контекста', () => {
    it('в Полном диффе называет пару чисел, включая нулевой остаток', () => {
        expect(expansionAnnouncement(20, 59, 0, t)).toBe('догружено 20 строк, скрыто 59');
        expect(expansionAnnouncement(14, 0, 0, t)).toBe('догружено 14 строк, скрыто 0');
    });

    it('на срезе маршрута вместо «скрыто 0» называет изменённые строки чужих остановок', () => {
        expect(expansionAnnouncement(5, 0, 2, t)).toBe('догружено 5 строк, 2 изменённые строки — в других остановках');
    });

    it('на срезе маршрута с остатком контекста называет оба числа', () => {
        expect(expansionAnnouncement(20, 7, 3, t)).toBe(
            'догружено 20 строк, скрыто 7, 3 изменённые строки — в других остановках',
        );
    });
});
