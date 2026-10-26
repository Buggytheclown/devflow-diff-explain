/**
 * Патч файла, которого `arc diff` не показывает. Неотслеживаемые файлы в дифф рабочего дерева
 * не попадают, а ревьюеру они нужны наравне с остальными — «добавлен целиком» адаптер пишет сам.
 */

/** Сколько байтов содержимого проверяем на нулевой байт: двоичность видна в начале файла. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Маркеры двоичного файла в патче самого `arc`. */
const BINARY_PATCH_MARKER = /^(?:Binary files |GIT binary patch)/mu;

export function isBinaryContent(content: Uint8Array): boolean {
    const limit = Math.min(content.length, BINARY_PROBE_BYTES);
    for (let index = 0; index < limit; index += 1) {
        if (content[index] === 0) {
            return true;
        }
    }
    return false;
}

/** Патч `arc` про двоичный файл: текста в нём нет, показывать нечего. */
export function isBinaryPatch(patch: string): boolean {
    return BINARY_PATCH_MARKER.test(patch);
}

/**
 * Патч нового файла целиком. null — содержимое двоичное: такой файл едет с `patch: null`
 * и `binary: true`.
 */
export function synthesizeAddPatch(path: string, content: Uint8Array): string | null {
    if (isBinaryContent(content)) {
        return null;
    }

    const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`];
    if (content.length === 0) {
        // Пустой файл: ханка нет — добавлять нечего, а `@@ -0,0 +1,0 @@` парсеру только мешает.
        return `${header.join('\n')}\n`;
    }

    const text = new TextDecoder().decode(content);
    const endsWithNewline = text.endsWith('\n');
    const lines = endsWithNewline ? text.slice(0, -1).split('\n') : text.split('\n');
    const body = lines.map((line) => `+${line}`);
    if (!endsWithNewline) {
        body.push('\\ No newline at end of file');
    }

    return `${[...header, `@@ -0,0 +1,${String(lines.length)} @@`, ...body].join('\n')}\n`;
}
