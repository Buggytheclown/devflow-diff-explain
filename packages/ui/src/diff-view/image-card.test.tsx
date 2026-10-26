// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, FileImage } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlobLoader } from './blob-loader.tsx';
import type { ComputeDiff, Rasterize } from './image-card.tsx';
import { ImageBody } from './image-card.tsx';
import type { ImageDiffResult } from './image-diff.js';

/**
 * Карточка-картинка: доступность режимов по сторонам, жизненный цикл object URL и поведение
 * отказов. Байты — заглушкой: транспорт инжектируется, поэтому ни сервера, ни фикстурного
 * хоста здесь не нужно.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Холста в jsdom нет вовсе, и на каждый вызов он пишет «Not implemented» — отвечаем за него сами.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];

const DATA = fixtureIteration('medium');

function imageFile(suffix: string): { file: FileDiff; image: FileImage } {
    const file = DATA.diff.files.find((candidate) => candidate.path.endsWith(suffix));
    if (file?.image == null) {
        throw new Error(`фикстуре medium нужна картинка ${suffix}`);
    }
    return { file, image: file.image };
}

const MODIFIED = imageFile('edit-window-banner.png');
const ADDED = imageFile('countdown-icon.svg');
const DELETED = imageFile('legacy-window-badge.png');

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn(() => {
        const url = `blob:mock/${String(created.length)}`;
        created.push(url);
        return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(node: ReactNode): { host: HTMLElement; unmount: () => void } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(node);
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return { host, unmount };
}

/** Транспорт, который отдаёт байты; счётчик вызовов — наблюдаемость «сколько раз ходили». */
function okLoader(): BlobLoader & { calls: string[] } {
    const calls: string[] = [];
    const loader = (blobId: string): Promise<Blob | null> => {
        calls.push(blobId);
        return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    };
    return Object.assign(loader, { calls });
}

/** jsdom картинки не грузит: натуральный размер подставляется руками, `load` — событием. */
function measure(image: HTMLImageElement | undefined, width: number, height: number): void {
    if (image === undefined) {
        throw new Error('нет слоя картинки');
    }
    Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true });
    act(() => {
        image.dispatchEvent(new Event('load'));
    });
}

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

function modes(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('.image-card__modes .image-card__mode')];
}

function mode(host: HTMLElement, label: string): HTMLButtonElement {
    const found = modes(host).find((button) => button.textContent === label);
    if (found === undefined) {
        throw new Error(`нет плашки режима ${label}`);
    }
    return found;
}

/** Подмены режима Diff: canvas в jsdom нет, воркер поднимать незачем. */
const RASTERIZE: Rasterize = (image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
    data: new Uint8ClampedArray(image.naturalWidth * image.naturalHeight * 4),
});

function diffResult(changed: number, total: number, sizeMismatch = false): ImageDiffResult {
    return { width: 48, height: 32, data: new Uint8ClampedArray(48 * 32 * 4), changed, total, sizeMismatch };
}

/** Обе стороны 2-up замерены: без натуральных размеров режим Diff считать отказывается. */
function measureBothSides(host: HTMLElement): void {
    const images = [...host.querySelectorAll<HTMLImageElement>('img.image-card__image')];
    measure(images[0], 48, 32);
    measure(images[1], 48, 32);
}

describe('карточка-картинка', () => {
    it('у файла с двумя сторонами доступны наложения, у односторонего — нет', async () => {
        const both = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        const single = render(<ImageBody file={DELETED.file} image={DELETED.image} loadBlob={okLoader()} />);
        await settle();

        expect(mode(both.host, 'Swipe').disabled).toBe(false);
        expect(mode(both.host, 'Onion Skin').disabled).toBe(false);
        expect(mode(both.host, 'Diff').disabled).toBe(false);
        expect(mode(single.host, 'Swipe').disabled).toBe(true);
        expect(mode(single.host, 'Swipe').title).toBe('нужны обе стороны');
        expect(mode(single.host, 'Diff').disabled).toBe(true);
        expect(mode(single.host, 'Diff').title).toBe('нужны обе стороны');
    });

    it('«Текст» есть только у картинки с текстовым патчем', async () => {
        const svg = render(
            <ImageBody file={ADDED.file} image={ADDED.image} loadBlob={okLoader()} textBody={<p>строки</p>} />,
        );
        const png = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        expect(modes(svg.host).map((button) => button.textContent)).toContain('Текст');
        expect(modes(png.host).map((button) => button.textContent)).not.toContain('Текст');

        act(() => {
            mode(svg.host, 'Текст').click();
        });
        expect(svg.host.textContent).toContain('строки');
    });

    it('object URL создаётся на сторону и освобождается при размонтировании', async () => {
        const view = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        expect(created).toHaveLength(2);
        expect(view.host.querySelectorAll('img.image-card__image')).toHaveLength(2);

        view.unmount();
        expect(revoked).toEqual(created);
    });

    it('«Скачать» отдаёт object URL под именем файла', async () => {
        const { host } = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        const links = [...host.querySelectorAll<HTMLAnchorElement>('a.image-card__download')];
        expect(links).toHaveLength(2);
        expect(links[0]?.getAttribute('download')).toBe('edit-window-banner.png');
        expect(links[0]?.getAttribute('href')).toBe(created[0]);
    });

    it('сторона за лимитом не грузится вовсе, а объясняет размер', async () => {
        const loader = okLoader();
        const image: FileImage = {
            ...MODIFIED.image,
            before: { blobId: 'blob:huge', size: 12_000_000 },
            after: null,
        };
        const { host } = render(<ImageBody file={MODIFIED.file} image={image} loadBlob={loader} />);
        await settle();

        expect(loader.calls).toEqual([]);
        expect(host.textContent).toContain('слишком большая: 11,4 МБ');
    });

    it('404 у хоста — «картинка недоступна», без кнопки повтора', async () => {
        const { host } = render(
            <ImageBody file={DELETED.file} image={DELETED.image} loadBlob={() => Promise.resolve(null)} />,
        );
        await settle();

        expect(host.textContent).toContain('картинка недоступна');
        expect(host.querySelector('.image-card__retry')).toBeNull();
    });

    it('ошибка ручки показывает причину, «Повторить» идёт в транспорт снова', async () => {
        const calls: string[] = [];
        let fail = true;
        const loader: BlobLoader = (blobId) => {
            calls.push(blobId);
            return fail ? Promise.reject(new Error('ручка ответила 500')) : Promise.resolve(new Blob([]));
        };
        const { host } = render(<ImageBody file={DELETED.file} image={DELETED.image} loadBlob={loader} />);
        await settle();

        expect(calls).toHaveLength(1);
        expect(host.textContent).toContain('не загрузилось: ручка ответила 500');

        fail = false;
        act(() => {
            host.querySelector<HTMLButtonElement>('.image-card__retry')?.click();
        });
        await settle();

        expect(calls).toHaveLength(2);
        expect(host.querySelector('img.image-card__image')).not.toBeNull();
    });

    it('разделитель Swipe ходит с клавиатуры: ←/→ по 2 %, Home и End по краям', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'swipe' }} />,
        );
        await settle();

        const divider = host.querySelector<HTMLElement>('.image-card__divider');
        if (divider === null) {
            throw new Error('нет разделителя');
        }
        expect(divider.getAttribute('aria-valuenow')).toBe('50');

        const press = (key: string): void => {
            act(() => {
                divider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        };

        press('ArrowLeft');
        expect(divider.getAttribute('aria-valuenow')).toBe('48');
        press('ArrowRight');
        press('ArrowRight');
        expect(divider.getAttribute('aria-valuenow')).toBe('52');
        press('Home');
        expect(divider.getAttribute('aria-valuenow')).toBe('0');
        press('End');
        expect(divider.getAttribute('aria-valuenow')).toBe('100');
    });

    it('Onion Skin ведёт непрозрачность верхней стороны от ползунка', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'onion' }} />,
        );
        await settle();

        const clip = host.querySelector<HTMLElement>('.image-card__clip');
        expect(clip?.style.opacity).toBe('0.5');
    });

    it('в наложении каждая сторона занимает свою долю бокса, а не растягивается на весь', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'onion' }} />,
        );
        await settle();

        const layers = [...host.querySelectorAll<HTMLImageElement>('.image-card__layer')];
        measure(layers[0], 48, 32);
        measure(layers[1], 96, 64);

        expect(layers[0]?.style.width).toBe('50%');
        expect(layers[1]?.style.width).toBe('100%');
        // Высота идёт от ширины: бокс наложения бывает выше пропорций, и заданная процентами
        // высота растянула бы картинку.
        expect(layers[0]?.style.height).toBe('auto');
        expect(layers[1]?.style.height).toBe('auto');
    });

    it('Swipe клипает слой «Стало» во весь бокс, а не саму картинку', async () => {
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ mode: 'swipe', swipe: 35 }}
            />,
        );
        await settle();

        const clip = host.querySelector<HTMLElement>('.image-card__clip');
        expect(clip?.style.clipPath).toBe('inset(0 65% 0 0)');
        expect(clip?.querySelector('.image-card__layer')).not.toBeNull();
    });
    it('Diff считает только после выбора режима и печатает сводку', async () => {
        let calls = 0;
        const computeDiff: ComputeDiff = () => {
            calls += 1;
            return Promise.resolve(diffResult(384, 1536));
        };
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ rasterize: RASTERIZE, computeDiff }}
            />,
        );
        await settle();
        measureBothSides(host);

        // Карточка открылась в 2-up: воркер не трогали.
        expect(calls).toBe(0);

        act(() => {
            mode(host, 'Diff').click();
        });
        await settle();

        expect(calls).toBe(1);
        expect(host.querySelector('canvas.image-card__diff')).not.toBeNull();
        expect(host.textContent).toContain('изменено 25 % пикселей');
        expect(host.textContent).toContain('384');
    });

    it('уход из Diff и возврат не считают ту же пару заново', async () => {
        let calls = 0;
        let release: ((result: ImageDiffResult) => void) | null = null;
        const computeDiff: ComputeDiff = () => {
            calls += 1;
            return new Promise<ImageDiffResult>((resolve) => {
                release = resolve;
            });
        };
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ mode: 'diff', rasterize: RASTERIZE, computeDiff }}
            />,
        );
        await settle();
        const sources = [...host.querySelectorAll<HTMLImageElement>('img.image-card__source')];
        measure(sources[0], 48, 32);
        measure(sources[1], 48, 32);
        await settle();
        expect(calls).toBe(1);

        // Счёт ещё идёт: уходим в 2-up и возвращаемся — тот же запрос должен дождаться ответа.
        act(() => {
            mode(host, '2-up').click();
        });
        act(() => {
            mode(host, 'Diff').click();
        });
        await settle();
        expect(calls).toBe(1);

        act(() => {
            release?.(diffResult(384, 1536));
        });
        await settle();
        expect(host.textContent).toContain('изменено 25 % пикселей');

        // Готовый итог тоже переживает переключение: ни растеризации, ни воркера.
        act(() => {
            mode(host, 'Onion Skin').click();
        });
        act(() => {
            mode(host, 'Diff').click();
        });
        await settle();
        expect(calls).toBe(1);
        expect(host.textContent).toContain('изменено 25 % пикселей');
    });

    it('Diff при разных размерах сторон печатает пометку о размерах', async () => {
        const computeDiff: ComputeDiff = () => Promise.resolve(diffResult(1000, 1536, true));
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ mode: 'diff', rasterize: RASTERIZE, computeDiff }}
            />,
        );
        await settle();

        const sources = [...host.querySelectorAll<HTMLImageElement>('img.image-card__source')];
        measure(sources[0], 48, 32);
        measure(sources[1], 24, 16);
        await settle();

        expect(host.textContent).toContain('размеры различаются: 48 × 32 → 24 × 16');
    });

    it('провал счёта показывает причину, «Повторить» считает заново', async () => {
        let calls = 0;
        let fail = true;
        const computeDiff: ComputeDiff = () => {
            calls += 1;
            return fail ? Promise.reject(new Error('воркер упал')) : Promise.resolve(diffResult(0, 1536));
        };
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ mode: 'diff', rasterize: RASTERIZE, computeDiff }}
            />,
        );
        await settle();
        const sources = [...host.querySelectorAll<HTMLImageElement>('img.image-card__source')];
        measure(sources[0], 48, 32);
        measure(sources[1], 48, 32);
        await settle();

        expect(calls).toBe(1);
        expect(host.textContent).toContain('не удалось посчитать разницу: воркер упал');

        fail = false;
        act(() => {
            host.querySelector<HTMLButtonElement>('.image-card__retry')?.click();
        });
        await settle();

        expect(calls).toBe(2);
        expect(host.textContent).toContain('изменено 0 % пикселей');
    });
});
