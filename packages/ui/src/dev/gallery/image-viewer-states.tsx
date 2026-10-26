import { fixtureIteration, makeFixtureHost, PNG_SMALL_BASE64 } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { BlobLoader } from '../../diff-view/blob-loader.tsx';
import { BlobLoaderProvider } from '../../diff-view/blob-loader.tsx';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import type { ComputeDiff, ImageBodyState } from '../../diff-view/image-card.tsx';
import { readStateOf } from '../../progress/read-state.js';
import '../../diff-view/diff-view.css';

/**
 * Карточка-картинка на картинках фикстуры `medium`. Байты берутся у `FixtureHost`
 * напрямую — галерея работает без сервера и без токена; загрузка и ошибка сделаны транспортами,
 * которые не резолвятся и падают, поэтому кадры детерминированы и без таймеров.
 *
 * Кадры Diff считаются настоящим воркером на настоящем canvas: входные байты фиксированы,
 * поэтому результат от прогона к прогону не меняется.
 */

const MEDIUM = fixtureIteration('medium');
const HOST = makeFixtureHost('medium');
const GET_BLOB = HOST.getBlob ?? ((): Promise<Uint8Array | null> => Promise.resolve(null));

function imageFile(path: string): FileDiff {
    const file = MEDIUM.diff.files.find((candidate) => candidate.path.endsWith(path));
    if (file?.image == null) {
        throw new Error(`фикстуре medium нужна картинка ${path}`);
    }
    return file;
}

const PNG = imageFile('edit-window-banner.png');
const SVG = imageFile('countdown-icon.svg');
const DELETED = imageFile('legacy-window-badge.png');

/** Сторона за лимитом `IMAGE_BLOB_MAX_BYTES`: в фикстуре таких байтов нет, размер ставится руками. */
const TOO_LARGE: FileDiff = {
    ...PNG,
    image: PNG.image === null ? null : { ...PNG.image, after: { blobId: 'blob:too-large', size: 12_000_000 } },
};

function fixtureLoader(mime: string): BlobLoader {
    return async (blobId) => {
        const bytes = await GET_BLOB(blobId);
        if (bytes === null) {
            return null;
        }
        // Копия в буфер, которым владеем: `Uint8Array` хоста типизирован по `ArrayBufferLike`.
        const owned = new Uint8Array(bytes.length);
        owned.set(bytes);
        return new Blob([owned], { type: mime });
    };
}

const PNG_LOADER = fixtureLoader('image/png');

/**
 * Стороны разного размера: `after` подменяется маленькой png вне состава `medium` — состав
 * фикстуры от галереи не зависит, а режим Diff получает честный `sizeMismatch`.
 */
const SMALL_BLOB_ID = 'blob:png-small';
const SMALL_PNG = Uint8Array.from(atob(PNG_SMALL_BASE64), (char) => char.codePointAt(0) ?? 0);

const MIXED_SIZES: FileDiff = {
    ...PNG,
    image: PNG.image === null ? null : { ...PNG.image, after: { blobId: SMALL_BLOB_ID, size: SMALL_PNG.length } },
};

const MIXED_LOADER: BlobLoader = (blobId) =>
    blobId === SMALL_BLOB_ID
        ? Promise.resolve(new Blob([SMALL_PNG], { type: 'image/png' }))
        : PNG_LOADER(blobId);

const SVG_LOADER = fixtureLoader('image/svg+xml');
const FAILING_LOADER: BlobLoader = () => Promise.reject(new Error('ручка блобов ответила 500'));
const PENDING_LOADER: BlobLoader = () => new Promise(() => undefined);

/** Счёт, который никогда не завершается: кадр «считаем разницу…» без таймеров. */
const PENDING_DIFF: ComputeDiff = () => new Promise(() => undefined);

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

function ImageCardState({
    file,
    loadBlob,
    initial,
}: {
    file: FileDiff;
    loadBlob: BlobLoader;
    initial?: ImageBodyState;
}) {
    return (
        <div className="gallery__viewport">
            <BlobLoaderProvider loadBlob={loadBlob}>
                <FileCard
                    file={file}
                    model={parseFileDiff(toParseRequest(file))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file, record: null })}
                    opened
                    showWhitespace={false}
                    markdown={false}
                    selection={null}
                    actions={ACTIONS}
                    initialImage={initial}
                />
            </BlobLoaderProvider>
        </div>
    );
}

export const IMAGE_VIEWER_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'image-two-up-modify',
        title: '2-up: правка png, обе стороны',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-two-up-add',
        title: '2-up: добавленная svg, «Было» — заглушка',
        render: () => <ImageCardState file={SVG} loadBlob={SVG_LOADER} />,
    },
    {
        id: 'image-two-up-delete',
        title: '2-up: удалённая png, «Стало» — заглушка',
        render: () => <ImageCardState file={DELETED} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-swipe',
        title: 'Swipe: разделитель на 35 %',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'swipe', swipe: 35 }} />,
    },
    {
        id: 'image-onion',
        title: 'Onion Skin: непрозрачность 50 %',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'onion', onion: 50 }} />,
    },
    {
        id: 'image-diff',
        title: 'Diff: попиксельная разница правки png',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'diff' }} />,
    },
    {
        id: 'image-diff-busy',
        title: 'Diff: разница считается',
        render: () => (
            <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'diff', computeDiff: PENDING_DIFF }} />
        ),
    },
    {
        id: 'image-diff-size-mismatch',
        title: 'Diff: стороны разного размера',
        render: () => <ImageCardState file={MIXED_SIZES} loadBlob={MIXED_LOADER} initial={{ mode: 'diff' }} />,
    },
    {
        id: 'image-text-svg',
        title: 'Текст: строки патча у svg',
        render: () => <ImageCardState file={SVG} loadBlob={SVG_LOADER} initial={{ mode: 'text' }} />,
    },
    {
        id: 'image-actual-size',
        title: '1:1: масштаб без вписывания',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ fit: 'actual' }} />,
    },
    {
        id: 'image-too-large',
        title: 'сторона за лимитом: не грузится, ссылка к хосту',
        render: () => <ImageCardState file={TOO_LARGE} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-failed',
        title: 'ручка блобов упала: «Повторить»',
        render: () => <ImageCardState file={PNG} loadBlob={FAILING_LOADER} />,
    },
    {
        id: 'image-loading',
        title: 'байты ещё едут',
        render: () => <ImageCardState file={PNG} loadBlob={PENDING_LOADER} />,
    },
];
