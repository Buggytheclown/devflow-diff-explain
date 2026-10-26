/**
 * Картинки фикстуры `medium`. PNG — 48×32 RGBA с прозрачным фоном и цветным
 * прямоугольником; байты сгенерированы скриптом на zlib/struct (сжатие 9), в репозитории лежат
 * готовым base64 — это единственная форма, в которой двоичные данные переживают TS-исходник.
 * SVG собирается из своего же текста: тот же массив строк едет и в патч добавления файла.
 */

/** Правка png: прямоугольник переехал и сменил цвет — разница видна и глазом, и попиксельно. */
export const PNG_BEFORE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAANElEQVR42u3PAQkAMAgAQQOacGW1hAyFO/gAHwGwUr6qyQwYMGDAgAEDBgwYMHBnAAD4oAGZs50uQz8MsgAAAABJRU5ErkJggg==';
export const PNG_AFTER_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAAM0lEQVR42u3PQQkAAAgAMQOazNIaQj/CBhfgIgCAx7qyLzNgwIABAwYMGDBgwMCfAYCVASMKiS40cqcGAAAAAElFTkSuQmCC';

/**
 * Маленькая png 24×16: в составе `medium` её нет — она нужна только галерее состояний,
 * чтобы показать режим Diff на сторонах разного размера.
 */
export const PNG_SMALL_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAAIElEQVR42mNgGAWkAqWjh/6Tg0ctGLVg1AISLBgFdAcAy6JOwBEFpxUAAAAASUVORK5CYII=';

/** Удалённая png: сторона одна, `after` у файла нет вовсе. */
export const PNG_DELETED_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAAOklEQVR42u3PUQkAMAhAQaMvgPms474NIAx2D16Ai5A0yjr98gAAAAAAAAAAAAAAAAAAAAAAOwDpsy6QMcxX9xvYOgAAAABJRU5ErkJggg==';

/** Добавленная svg: у неё есть и картинка, и обычный текстовый патч из этих же строк. */
export const SVG_LINES: readonly string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">',
    '  <title>Edit window countdown</title>',
    '  <circle cx="24" cy="24" r="20" fill="none" stroke="#4c9aff" stroke-width="4" />',
    '  <path d="M24 12 v12 h9" fill="none" stroke="#4c9aff" stroke-width="4"',
    '        stroke-linecap="round" stroke-linejoin="round" />',
    '</svg>',
];

/** Файл целиком: строки через `\n` с завершающим переводом строки, как в репозитории. */
export const SVG_TEXT = `${SVG_LINES.join('\n')}\n`;

/** Содержимое ASCII, поэтому `btoa` хватает и в браузере, и в Node. */
export const SVG_BASE64 = btoa(SVG_TEXT);
