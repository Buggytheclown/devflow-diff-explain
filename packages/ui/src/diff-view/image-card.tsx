import type { FileDiff, FileImage, ImageSide } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES } from '@sherpa/protocol';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Translate } from '../i18n/index.js';
import { activeT, useT } from '../i18n/index.js';
import type { BlobLoader } from './blob-loader.tsx';
import { sharedImageDiffClient } from './image-diff-client.js';
import type { DiffPixelsOptions, ImageDiffResult, PixelSurface } from './image-diff.js';
import './image-card.css';

/**
 * Тело карточки-картинки: вместо нотиса «двоичный файл
 * не показан» — стороны рядом и способы их сравнить. Шапка, «Просмотрено», меню и свёртки
 * остаются общими — это тело внутри обычной `FileCard`.
 *
 * Байты приезжают транспортом (`BlobLoader`), а не ручкой напрямую: галерея и тесты подставляют
 * фикстуру, приложение — `fetchBlob` с токеном.
 */

export type ImageMode = 'two-up' | 'swipe' | 'onion' | 'diff' | 'text';
export type ImageFit = 'fit' | 'actual';

/**
 * Растеризация стороны для режима Diff: в браузере — canvas, в jsdom и галерее — подмена.
 * Браузерная ждёт загруженный `<img>`, поэтому результат может быть и обещанием.
 */
export type Rasterize = (image: HTMLImageElement) => PixelSurface | Promise<PixelSurface>;

/** Счёт разницы: в браузере — воркер вкладки, в тестах — прямой вызов `diffPixels`. */
export type ComputeDiff = (
    before: PixelSurface,
    after: PixelSurface,
    options: DiffPixelsOptions,
) => Promise<ImageDiffResult>;

/**
 * Стартовый кадр карточки: только галерея и тесты — ревьюеру режимы переключает клик.
 * Здесь же подмены растеризации и счёта: без них кадры Diff зависели бы от canvas и воркера.
 */
export interface ImageBodyState {
    readonly mode?: ImageMode;
    readonly fit?: ImageFit;
    /** Положение разделителя Swipe в процентах ширины. */
    readonly swipe?: number;
    /** Непрозрачность верхней стороны Onion Skin в процентах. */
    readonly onion?: number;
    readonly rasterize?: Rasterize;
    readonly computeDiff?: ComputeDiff;
}

export interface ImageBodyProps {
    readonly file: FileDiff;
    readonly image: FileImage;
    readonly loadBlob: BlobLoader;
    /** Строки диффа для режима «Текст» (svg); null — текстового патча у файла нет. */
    readonly textBody?: ReactNode;
    readonly initial?: ImageBodyState | undefined;
}

interface ModeOption {
    readonly id: ImageMode;
    readonly label: 'image.mode.twoUp' | 'image.mode.swipe' | 'image.mode.onion' | 'image.mode.diff' | 'image.mode.text';
}

const MODE_OPTIONS: readonly ModeOption[] = [
    { id: 'two-up', label: 'image.mode.twoUp' },
    { id: 'swipe', label: 'image.mode.swipe' },
    { id: 'onion', label: 'image.mode.onion' },
    { id: 'diff', label: 'image.mode.diff' },
    { id: 'text', label: 'image.mode.text' },
];

/** Шаг разделителя Swipe с клавиатуры. */
const SWIPE_STEP = 2;

export function ImageBody({ file, image, loadBlob, textBody = null, initial }: ImageBodyProps) {
    const t = useT();
    const before = useImageSide(image.before, loadBlob);
    const after = useImageSide(image.after, loadBlob);
    const [mode, setMode] = useState<ImageMode>(initial?.mode ?? 'two-up');
    const [fit, setFit] = useState<ImageFit>(initial?.fit ?? 'fit');
    const [swipe, setSwipe] = useState(initial?.swipe ?? 50);
    const [onion, setOnion] = useState(initial?.onion ?? 50);
    const diff = useDiffCache();

    const bothSides = image.before !== null && image.after !== null;
    const hasText = textBody !== null;
    // Апскейл растра в 1:1 честнее показывать пикселями; svg от этого только рябит.
    const pixelated = image.mime !== 'image/svg+xml';
    // Растеризовать нечего, пока хотя бы у одной стороны нет собственного размера (svg без
    // width/height): такой `<img>` дал бы пустой холст, а не разницу.
    const noSize = before.natural !== null && after.natural !== null && (before.natural.width === 0 || after.natural.width === 0);
    const options = MODE_OPTIONS.filter((option) => option.id !== 'text' || hasText).map((option) => ({
        ...option,
        reason: !bothSides
            ? option.id === 'swipe' || option.id === 'onion' || option.id === 'diff'
                ? t('image.mode.needBothSides')
                : null
            : option.id === 'diff' && noSize
              ? t('image.mode.noSize')
              : null,
    }));

    return (
        <div className="image-card">
            <div className="image-card__controls">
                <div className="image-card__modes ctl-tabs" role="group" aria-label={t('image.mode.aria')}>
                    {options.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`ctl ctl--tab image-card__mode${option.id === mode ? ' is-active' : ''}`}
                            aria-pressed={option.id === mode}
                            disabled={option.reason !== null}
                            title={option.reason ?? undefined}
                            onClick={() => {
                                setMode(option.id);
                            }}
                        >
                            {t(option.label)}
                        </button>
                    ))}
                </div>
                <span className="image-card__spacer" />
                {mode === 'text' ? null : (
                    <button
                        type="button"
                        className={`ctl ctl--tab image-card__mode image-card__mode--single${fit === 'actual' ? ' is-active' : ''}`}
                        aria-pressed={fit === 'actual'}
                        title={t(fit === 'actual' ? 'image.fit.toFitTitle' : 'image.fit.toActualTitle')}
                        onClick={() => {
                            setFit(fit === 'actual' ? 'fit' : 'actual');
                        }}
                    >
                        {t(fit === 'actual' ? 'image.fit.toFit' : 'image.fit.toActual')}
                    </button>
                )}
            </div>

            {mode === 'text' ? (
                textBody
            ) : mode === 'diff' ? (
                <PixelDiff
                    file={file}
                    image={image}
                    fit={fit}
                    pixelated={pixelated}
                    before={before}
                    after={after}
                    cache={diff}
                    rasterize={initial?.rasterize}
                    computeDiff={initial?.computeDiff}
                />
            ) : mode === 'swipe' || mode === 'onion' ? (
                <Overlay
                    file={file}
                    image={image}
                    mode={mode}
                    fit={fit}
                    pixelated={pixelated}
                    before={before}
                    after={after}
                    swipe={swipe}
                    onSwipe={setSwipe}
                    onion={onion}
                    onOnion={setOnion}
                />
            ) : (
                <div className="image-card__pair">
                    <SideColumn
                        file={file}
                        side="before"
                        model={image.before}
                        view={before}
                        fit={fit}
                        pixelated={pixelated}
                    />
                    <SideColumn
                        file={file}
                        side="after"
                        model={image.after}
                        view={after}
                        fit={fit}
                        pixelated={pixelated}
                    />
                </div>
            )}
        </div>
    );
}

/** Что известно про сторону: `missing` — 404 у хоста, `tooLarge` — сторону не грузили вовсе. */
type SideState = 'idle' | 'loading' | 'ready' | 'missing' | 'error' | 'tooLarge';

interface SideLoad {
    readonly state: SideState;
    /** Object URL байтов; освобождается при размонтировании и смене `blobId`. */
    readonly url: string | null;
    readonly error: string | null;
}

interface SideView extends SideLoad {
    /** `naturalWidth`/`naturalHeight` после `onLoad`; null — картинка ещё не отрисована. */
    readonly natural: { readonly width: number; readonly height: number } | null;
    readonly retry: () => void;
    readonly onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Загрузка одной стороны. Каждая сторона грузится своим эффектом — параллельно и по одному разу
 * на карточку; сторона больше `IMAGE_BLOB_MAX_BYTES` не грузится вовсе.
 */
function useImageSide(side: ImageSide | null, loadBlob: BlobLoader): SideView {
    const blobId = side?.blobId ?? null;
    const size = side?.size ?? 0;
    const [attempt, setAttempt] = useState(0);
    // Ключ попытки: смена стороны и «Повторить» обнуляют и результат, и замеренный размер
    // прямо при рендере — иначе пришлось бы сбрасывать их setState-ом из эффекта.
    const attemptKey = `${String(attempt)}:${blobId ?? ''}`;
    const [loaded, setLoaded] = useState<{ readonly key: string; readonly load: SideLoad } | null>(null);
    const [measured, setMeasured] = useState<{
        readonly key: string;
        readonly natural: { readonly width: number; readonly height: number };
    } | null>(null);
    const load = loaded?.key === attemptKey ? loaded.load : initialLoad(blobId, size);
    const natural = measured?.key === attemptKey ? measured.natural : null;

    useEffect(() => {
        if (blobId === null || size > IMAGE_BLOB_MAX_BYTES) {
            return;
        }

        let objectUrl: string | null = null;
        let cancelled = false;
        loadBlob(blobId).then(
            (blob) => {
                if (cancelled) {
                    return;
                }
                if (blob === null) {
                    setLoaded({ key: attemptKey, load: { state: 'missing', url: null, error: null } });
                    return;
                }
                objectUrl = URL.createObjectURL(blob);
                setLoaded({ key: attemptKey, load: { state: 'ready', url: objectUrl, error: null } });
            },
            (error: unknown) => {
                if (!cancelled) {
                    setLoaded({
                        key: attemptKey,
                        load: {
                            state: 'error',
                            url: null,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    });
                }
            },
        );

        return () => {
            cancelled = true;
            if (objectUrl !== null) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [attemptKey, blobId, loadBlob, size]);

    const retry = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);
    const onLoad = useCallback(
        (event: SyntheticEvent<HTMLImageElement>) => {
            const image = event.currentTarget;
            setMeasured({ key: attemptKey, natural: { width: image.naturalWidth, height: image.naturalHeight } });
        },
        [attemptKey],
    );

    return { ...load, natural, retry, onLoad };
}

/** Состояние стороны до всякой загрузки — оно же кадр серверного рендера. */
function initialLoad(blobId: string | null, size: number): SideLoad {
    if (blobId === null) {
        return { state: 'idle', url: null, error: null };
    }
    if (size > IMAGE_BLOB_MAX_BYTES) {
        return { state: 'tooLarge', url: null, error: null };
    }
    return { state: 'loading', url: null, error: null };
}

/** Колонка режима 2-up: подпись стороны, картинка на шахматке, размеры и «Скачать». */
function SideColumn({
    file,
    side,
    model,
    view,
    fit,
    pixelated,
}: {
    file: FileDiff;
    side: 'before' | 'after';
    model: ImageSide | null;
    view: SideView;
    fit: ImageFit;
    pixelated: boolean;
}) {
    const t = useT();
    const title = t(side === 'before' ? 'image.side.before' : 'image.side.after');

    if (model === null) {
        return (
            <div className="image-card__side">
                <p className="image-card__side-title">{title}</p>
                <p className="file-card__image-empty">{t('image.side.empty')}</p>
            </div>
        );
    }

    const dimensions = view.natural === null || view.natural.width === 0 ? null : t('image.dimensions', view.natural.width, view.natural.height);
    return (
        <div className="image-card__side">
            <p className="image-card__side-title">{title}</p>
            <div
                className={`image-card__frame${fit === 'actual' ? ' image-card__frame--actual' : ''}${
                    pixelated ? ' image-card__frame--pixelated' : ''
                }`}
            >
                {view.state === 'ready' && view.url !== null ? (
                    <img
                        className="image-card__image"
                        src={view.url}
                        alt={t(side === 'before' ? 'image.alt.before' : 'image.alt.after', file.path)}
                        onLoad={view.onLoad}
                    />
                ) : (
                    <SideStatus file={file} model={model} view={view} />
                )}
            </div>
            <p className="image-card__meta">
                {dimensions === null ? null : <span>{dimensions}</span>}
                <span>{formatBytes(model.size, t)}</span>
                {view.state === 'ready' && view.url !== null ? (
                    <a className="image-card__download" href={view.url} download={basename(file.path)}>
                        {t('image.download')}
                    </a>
                ) : null}
            </p>
        </div>
    );
}

/** Всё, что не «картинка на экране»: загрузка, 404, ошибка ручки, отказ по размеру. */
function SideStatus({ file, model, view }: { file: FileDiff; model: ImageSide; view: SideView }) {
    const t = useT();
    if (view.state === 'tooLarge') {
        return (
            <p className="image-card__status">
                {t('image.tooLarge', formatBytes(model.size, t))}
                {file.hostFileUrl === null ? null : (
                    <a className="image-card__download" href={file.hostFileUrl} target="_blank" rel="noopener">
                        {t('image.openAtHost')}
                    </a>
                )}
            </p>
        );
    }
    if (view.state === 'error') {
        return (
            <p className="image-card__status" role="status">
                {t('image.failed', view.error ?? '')}
                <button type="button" className="ctl ctl--link image-card__retry" onClick={view.retry}>
                    {t('image.retry')}
                </button>
            </p>
        );
    }
    return (
        <p className="image-card__status">{t(view.state === 'missing' ? 'image.missing' : 'image.loading')}</p>
    );
}

/**
 * Swipe и Onion Skin: обе стороны в одном боксе по общему размеру. Пока хотя бы одна сторона
 * не приехала, показываются те же статусы, что и в 2-up, — иначе режим выглядел бы пустым.
 */
function Overlay({
    file,
    image,
    mode,
    fit,
    pixelated,
    before,
    after,
    swipe,
    onSwipe,
    onion,
    onOnion,
}: {
    file: FileDiff;
    image: FileImage;
    mode: 'swipe' | 'onion';
    fit: ImageFit;
    pixelated: boolean;
    before: SideView;
    after: SideView;
    swipe: number;
    onSwipe: (value: number) => void;
    onion: number;
    onOnion: (value: number) => void;
}) {
    const t = useT();
    const stageRef = useRef<HTMLDivElement | null>(null);

    const moveTo = useCallback(
        (clientX: number) => {
            const box = stageRef.current?.getBoundingClientRect();
            if (box === undefined || box.width === 0) {
                return;
            }
            onSwipe(clamp(((clientX - box.left) / box.width) * 100));
        },
        [onSwipe],
    );

    // Бокс наложения — по большей стороне, а каждая картинка занимает в нём свою долю от общего
    // левого верхнего угла. Растянуть обе на весь бокс нельзя: стороны разного разрешения
    // совпали бы пиксель в пиксель, и переезд ассета в 2x выглядел бы как «ничего не изменилось».
    const width = Math.max(before.natural?.width ?? 0, after.natural?.width ?? 0);
    const height = Math.max(before.natural?.height ?? 0, after.natural?.height ?? 0);
    const size = width === 0 || height === 0 ? undefined : { width, aspectRatio: `${String(width)} / ${String(height)}` };
    // Доля ширины бокса, высота — от неё: бокс может оказаться выше пропорций (минимальная
    // высота у ненайденных размеров), и заданная процентами высота растянула бы картинку.
    const layerSize = (natural: SideView['natural']): CSSProperties | undefined =>
        natural === null || width === 0
            ? undefined
            : { width: `${String((natural.width / width) * 100)}%`, height: 'auto' };

    // Накладывать нечего, пока хотя бы одна сторона не приехала: до тех пор на экране те же
    // колонки со статусами, что и в 2-up.
    if (before.state !== 'ready' || after.state !== 'ready') {
        return (
            <div className="image-card__pair">
                <SideColumn file={file} side="before" model={image.before} view={before} fit={fit} pixelated={pixelated} />
                <SideColumn file={file} side="after" model={image.after} view={after} fit={fit} pixelated={pixelated} />
            </div>
        );
    }

    return (
        <div
            className={`image-card__overlay${fit === 'actual' ? ' image-card__overlay--actual' : ''}${
                pixelated ? ' image-card__overlay--pixelated' : ''
            }`}
        >
            <div
                className={`image-card__stage${size === undefined ? ' image-card__stage--unsized' : ''}`}
                ref={stageRef}
                style={size}
            >
                <img
                    className="image-card__layer"
                    src={before.url ?? undefined}
                    alt={t('image.alt.before', file.path)}
                    onLoad={before.onLoad}
                    style={layerSize(before.natural)}
                />
                {/* Клип и непрозрачность — на слое во весь бокс, а не на самой картинке:
                    иначе проценты считались бы от её размера и разъезжались с разделителем. */}
                <div
                    className="image-card__clip"
                    style={
                        mode === 'swipe'
                            ? { clipPath: `inset(0 ${String(100 - swipe)}% 0 0)` }
                            : { opacity: onion / 100 }
                    }
                >
                    <img
                        className="image-card__layer"
                        src={after.url ?? undefined}
                        alt={t('image.alt.after', file.path)}
                        onLoad={after.onLoad}
                        style={layerSize(after.natural)}
                    />
                </div>
                {mode === 'swipe' ? (
                    <div
                        className="image-card__divider"
                        style={{ left: `${String(swipe)}%` }}
                        role="slider"
                        tabIndex={0}
                        aria-label={t('image.swipe.aria')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(swipe)}
                        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
                            // `preventDefault` снимает и фокус по клику — иначе после перетаскивания
                            // ←/→ и Home/End молчали бы, пока до разделителя не дотабаешься.
                            event.preventDefault();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            event.currentTarget.focus();
                            moveTo(event.clientX);
                        }}
                        onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                moveTo(event.clientX);
                            }
                        }}
                        onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onKeyDown={(event) => {
                            const next = swipeByKey(event.key, swipe);
                            if (next !== null) {
                                event.preventDefault();
                                onSwipe(next);
                            }
                        }}
                    />
                ) : null}
            </div>

            {mode === 'onion' ? (
                <label className="image-card__slider">
                    {t('image.onion.label')}
                    <input
                        type="range"
                        min={0}
                        max={100}
                        value={onion}
                        onChange={(event) => {
                            onOnion(Number(event.currentTarget.value));
                        }}
                    />
                    <span className="image-card__slider-value">{t('image.onion.value', onion)}</span>
                </label>
            ) : null}
        </div>
    );
}

/**
 * Итог счёта для пары object URL: ключ отделяет свежий результат от ответа на прошлые байты.
 * Отдельного «считаем» здесь нет — это состояние ключа, у которого итога ещё нет.
 */
type DiffJob =
    | { readonly key: string; readonly state: 'ready'; readonly result: ImageDiffResult }
    | { readonly key: string; readonly state: 'error'; readonly error: string };

/**
 * Счёт разницы, переживающий уход из режима Diff: и готовый итог, и незавершённый запрос.
 * Живёт в `ImageBody`, потому что сам `PixelDiff` размонтируется вместе с режимом, а байты
 * сторон при этом остаются те же.
 */
interface DiffCache {
    /** Номер попытки: «Повторить» меняет ключ и этим отправляет пару считаться заново. */
    readonly attempt: number;
    readonly job: DiffJob | null;
    readonly setJob: (job: DiffJob) => void;
    readonly requestRef: RefObject<{ readonly key: string; readonly promise: Promise<ImageDiffResult> } | null>;
    readonly retry: () => void;
}

function useDiffCache(): DiffCache {
    const [attempt, setAttempt] = useState(0);
    const [job, setJob] = useState<DiffJob | null>(null);
    const requestRef = useRef<{ readonly key: string; readonly promise: Promise<ImageDiffResult> } | null>(null);
    const retry = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);
    return { attempt, job, setJob, requestRef, retry };
}

/**
 * Режим Diff: обе стороны растеризуются в `ImageData` и уезжают считаться в воркер, результат
 * рисуется в том же боксе, что слои Swipe. Счёт ленивый — карточка в 2-up воркер не поднимает.
 */
function PixelDiff({
    file,
    image,
    fit,
    pixelated,
    before,
    after,
    cache,
    rasterize,
    computeDiff,
}: {
    file: FileDiff;
    image: FileImage;
    fit: ImageFit;
    pixelated: boolean;
    before: SideView;
    after: SideView;
    cache: DiffCache;
    rasterize: Rasterize | undefined;
    computeDiff: ComputeDiff | undefined;
}) {
    const t = useT();
    const beforeRef = useRef<HTMLImageElement | null>(null);
    const afterRef = useRef<HTMLImageElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const { attempt, job, setJob, requestRef, retry } = cache;

    const beforeNatural = before.natural;
    const afterNatural = after.natural;
    const noSize = beforeNatural !== null && afterNatural !== null && (beforeNatural.width === 0 || afterNatural.width === 0);
    const sized = beforeNatural !== null && afterNatural !== null && !noSize;
    // Результат живёт, пока живы те же object URL: пересчитывать одну и ту же пару байтов
    // при каждом возврате в Diff незачем. «Повторить» меняет ключ и запускает счёт заново.
    const key = `${String(attempt)} ${before.url ?? ''} ${after.url ?? ''}`;
    const current = job?.key === key ? job : null;

    useEffect(() => {
        const beforeImage = beforeRef.current;
        const afterImage = afterRef.current;
        if (!sized || beforeImage === null || afterImage === null) {
            return;
        }

        let cancelled = false;
        // Незавершённый счёт той же пары дожидаем, а не начинаем сначала: уход в 2-up и возврат
        // в Diff не должны стоить ещё одной растеризации и ещё одного круга в воркер.
        let pending = requestRef.current?.key === key ? requestRef.current.promise : null;
        if (pending === null) {
            // Растеризация ждёт загруженный элемент и может бросить (браузер не дал холст) —
            // через async-обёртку её отказ приходит тем же путём, что и отказ воркера.
            pending = (async (): Promise<ImageDiffResult> => {
                const read = rasterize ?? rasterizeWithCanvas;
                const compute = computeDiff ?? sharedImageDiffClient().compute;
                const [beforeSurface, afterSurface] = await Promise.all([read(beforeImage), read(afterImage)]);
                return compute(beforeSurface, afterSurface, { accent: accentColor() });
            })();
            requestRef.current = { key, promise: pending };
        }

        pending.then(
            (result) => {
                if (!cancelled) {
                    setJob({ key, state: 'ready', result });
                }
            },
            (error: unknown) => {
                if (!cancelled) {
                    setJob({ key, state: 'error', error: messageOf(error) });
                }
            },
        );

        // Ответ снятого запроса никуда не пишется: воркер общий, прерывать его ради одной
        // размонтированной карточки дороже, чем дать досчитать — итог дождётся в `requestRef`.
        return () => {
            cancelled = true;
        };
    }, [key, sized, rasterize, computeDiff, requestRef, setJob]);

    const result = current?.state === 'ready' ? current.result : null;
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null || result === null) {
            return;
        }
        canvas.width = result.width;
        canvas.height = result.height;
        const context = canvas.getContext('2d');
        if (context === null) {
            return;
        }
        // Через `createImageData`, а не конструктор `ImageData`: в jsdom глобали нет вовсе.
        const frame = context.createImageData(result.width, result.height);
        frame.data.set(result.data);
        context.putImageData(frame, 0, 0);
    }, [result]);

    // Считать нечего, пока хотя бы одна сторона не приехала: до тех пор на экране те же
    // колонки со статусами, что и в 2-up.
    if (before.state !== 'ready' || after.state !== 'ready') {
        return (
            <div className="image-card__pair">
                <SideColumn file={file} side="before" model={image.before} view={before} fit={fit} pixelated={pixelated} />
                <SideColumn file={file} side="after" model={image.after} view={after} fit={fit} pixelated={pixelated} />
            </div>
        );
    }

    // Бокс — по большей стороне, как у наложений: разница считается по тому же прямоугольнику.
    const width = Math.max(beforeNatural?.width ?? 0, afterNatural?.width ?? 0);
    const height = Math.max(beforeNatural?.height ?? 0, afterNatural?.height ?? 0);
    const size = width === 0 || height === 0 ? undefined : { width, aspectRatio: `${String(width)} / ${String(height)}` };
    const percent = result === null || result.total === 0 ? 0 : (result.changed / result.total) * 100;

    return (
        <div
            className={`image-card__overlay${fit === 'actual' ? ' image-card__overlay--actual' : ''}${
                pixelated ? ' image-card__overlay--pixelated' : ''
            }`}
        >
            <div
                className={`image-card__stage${size === undefined ? ' image-card__stage--unsized' : ''}`}
                style={size}
            >
                {/* Источники растеризации: `drawImage` нужен загруженный элемент, а показывать
                    его вместе с разницей нельзя — отсюда скрытая пара. */}
                <img
                    ref={beforeRef}
                    className="image-card__source"
                    src={before.url ?? undefined}
                    alt=""
                    aria-hidden
                    onLoad={before.onLoad}
                />
                <img
                    ref={afterRef}
                    className="image-card__source"
                    src={after.url ?? undefined}
                    alt=""
                    aria-hidden
                    onLoad={after.onLoad}
                />
                {result === null ? null : (
                    <canvas
                        ref={canvasRef}
                        className="image-card__layer image-card__diff"
                        role="img"
                        aria-label={t('image.diff.alt', file.path)}
                    />
                )}
            </div>

            <p className="image-card__meta" role="status">
                {noSize ? (
                    <span>{t('image.mode.noSize')}</span>
                ) : current === null ? (
                    <span>{t('image.diff.busy')}</span>
                ) : current.state === 'error' ? (
                    <>
                        <span>{t('image.diff.failed', current.error)}</span>
                        <button type="button" className="ctl ctl--link image-card__retry" onClick={retry}>
                            {t('image.retry')}
                        </button>
                    </>
                ) : (
                    <>
                        <span>{t('image.diff.summary', percent, current.result.changed, current.result.total)}</span>
                        {current.result.sizeMismatch && beforeNatural !== null && afterNatural !== null ? (
                            <span>
                                {t(
                                    'image.diff.sizeMismatch',
                                    beforeNatural.width,
                                    beforeNatural.height,
                                    afterNatural.width,
                                    afterNatural.height,
                                )}
                            </span>
                        ) : null}
                    </>
                )}
            </p>
        </div>
    );
}

/** Растеризация через canvas: единственное место карточки, которому нужен браузер. */
async function rasterizeWithCanvas(image: HTMLImageElement): Promise<PixelSurface> {
    await whenDrawable(image);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) {
        throw new Error(activeT()('image.diff.noCanvas'));
    }
    context.drawImage(image, 0, 0);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: frame.width, height: frame.height, data: frame.data };
}

/**
 * Ожидание кадра перед `drawImage`: по незагруженному элементу он молча не рисует ничего, и
 * разница вышла бы нулевой вместо ошибки. Обычно те же байты только что показывались в 2-up и
 * ждать нечего; отказ декодирования уходит в ошибку счёта с «Повторить».
 */
async function whenDrawable(image: HTMLImageElement): Promise<void> {
    if (image.complete && image.naturalWidth > 0) {
        return;
    }
    await image.decode();
}

/** Запасной акцент: разница обязана быть видна даже там, где токен не прочитался. */
const FALLBACK_ACCENT: readonly [number, number, number] = [255, 138, 61];

/** Цвет изменённых пикселей — вычисленный токен `--accent`: разница красится темой, а не кодом. */
function accentColor(): [number, number, number] {
    if (typeof document === 'undefined') {
        return [...FALLBACK_ACCENT];
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return parseColor(raw) ?? [...FALLBACK_ACCENT];
}

/** `#abc`, `#aabbcc`, `rgb(…)`/`rgba(…)` — формы, в которых браузеры отдают вычисленный токен. */
export function parseColor(raw: string): [number, number, number] | null {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(raw);
    if (hex !== null) {
        const digits = hex[1] ?? '';
        const step = digits.length === 3 ? 1 : 2;
        const channel = (index: number): number => {
            const part = digits.slice(index * step, index * step + step);
            return Number.parseInt(step === 1 ? part + part : part, 16);
        };
        return [channel(0), channel(1), channel(2)];
    }

    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/iu.exec(raw);
    if (rgb === null) {
        return null;
    }
    const channels: [number, number, number] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return channels.some((value) => Number.isNaN(value)) ? null : channels;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Клавиатура разделителя: ←/→ по 2 %, Home/End по краям; `null` — клавиша не наша. */
export function swipeByKey(key: string, current: number): number | null {
    if (key === 'ArrowLeft') {
        return clamp(current - SWIPE_STEP);
    }
    if (key === 'ArrowRight') {
        return clamp(current + SWIPE_STEP);
    }
    if (key === 'Home') {
        return 0;
    }
    if (key === 'End') {
        return 100;
    }
    return null;
}

function clamp(value: number): number {
    return Math.min(100, Math.max(0, value));
}

/** «1 023 Б», «12,4 КБ», «1,2 МБ»: разряды и запятая — из локали, слова — из словаря. */
export function formatBytes(bytes: number, t: Translate): string {
    if (bytes < 1024) {
        return t('image.size.bytes', bytes);
    }
    if (bytes < 1024 * 1024) {
        return t('image.size.kilobytes', bytes / 1024);
    }
    return t('image.size.megabytes', bytes / (1024 * 1024));
}

/** Имя файла для `download`: путь целиком браузер всё равно не сохранит. */
function basename(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? path : path.slice(cut + 1);
}
