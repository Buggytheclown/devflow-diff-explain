import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IMAGE_VIEWER_STATES } from './image-viewer-states.tsx';

/**
 * Галерея карточки-картинки: состав состояний и то, что видно в статичной разметке. Байты
 * приезжают эффектом, которого у серверного рендера нет, — поэтому здесь проверяются ряд
 * режимов, заглушки сторон и стартовые статусы, а не сами картинки.
 */
function markup(id: string): string {
    const state = IMAGE_VIEWER_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея карточки-картинки', () => {
    it('регистрирует ровно те id, которые заводит нарезка задачи', () => {
        expect(IMAGE_VIEWER_STATES.map((state) => state.id)).toEqual([
            'image-two-up-modify',
            'image-two-up-add',
            'image-two-up-delete',
            'image-swipe',
            'image-onion',
            'image-diff',
            'image-diff-busy',
            'image-diff-size-mismatch',
            'image-text-svg',
            'image-actual-size',
            'image-too-large',
            'image-failed',
            'image-loading',
        ]);
    });

    it('растровая правка: ряд режимов вместо нотиса о двоичном файле', () => {
        const html = markup('image-two-up-modify');

        expect(html).not.toContain('двоичный файл не показан');
        expect(html).toContain('>2-up</button>');
        expect(html).toContain('>Swipe</button>');
        expect(html).toContain('>Onion Skin</button>');
        expect(html).toContain('>Diff</button>');
        // Текстового патча у растра нет — режима «Текст» тоже.
        expect(html).not.toContain('>Текст</button>');
        expect(html).toContain('>Было</p>');
        expect(html).toContain('>Стало</p>');
    });

    it('добавленная svg: «Было» — заглушка, режимы наложения выключены, «Текст» есть', () => {
        const html = markup('image-two-up-add');

        expect(html).toContain('file-card__image-empty');
        expect(html).toContain('нужны обе стороны');
        expect(html).toContain('>Текст</button>');
    });

    it('удалённая png: заглушка стоит на стороне «Стало»', () => {
        const html = markup('image-two-up-delete');
        const empty = html.indexOf('file-card__image-empty');

        expect(empty).toBeGreaterThan(html.indexOf('>Стало</p>'));
    });

    it('режим «Текст» рисует строки патча svg', () => {
        const html = markup('image-text-svg');

        expect(html).toContain('file-card__body');
        expect(html).toContain('viewBox');
    });

    it('сторона за лимитом: размер в мегабайтах и ссылка к хосту вместо загрузки', () => {
        const html = markup('image-too-large');

        expect(html).toContain('слишком большая: 11,4 МБ');
        expect(html).toContain('Открыть в Аркануме');
    });

    it('Diff до прихода байтов показывает те же статусы сторон, что и 2-up', () => {
        // Серверный рендер эффектов не гоняет: ни растеризации, ни воркера здесь нет,
        // поэтому кадр — статусы сторон, а не сама разница.
        expect(markup('image-diff')).toContain('загружается…');
    });

    it('пока байты едут, у обеих сторон стоит статус загрузки', () => {
        expect(markup('image-loading').match(/загружается…/gu)).toHaveLength(2);
    });
});
