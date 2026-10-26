/**
 * Минимальная версия Node: с 22.13 встроенный `node:sqlite` доступен без флага, и на нём стоит
 * сервер Шерпы. Порог общий для всего дистрибутива — CLI и модуль сервера лежат рядом и живут
 * на одном рантайме, поэтому та же проверка продублирована в `@sherpa/server` (`src/runtime.ts`).
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

/**
 * Минорный порог внутри мажорной линейки. Без флага `node:sqlite` появился в 23.4, а в линейку 22
 * его бэкпортировали в 22.13 — то есть 23.0–23.3 старше порога, но модуля там ещё нет.
 * Линейки, которых тут нет, порога не имеют: всё старше 23 приехало с модулем.
 */
const MIN_MINOR_BY_MAJOR: Readonly<Record<number, number | undefined>> = { 22: MIN_NODE_MINOR, 23: 4 };

/**
 * Проверяет версию рантайма. Возвращает текст ошибки для пользователя либо null, если версия годится.
 * Нераспознанная строка версии считается годной: лучше пропустить экзотический рантайм, чем заблокировать его.
 */
export function checkNodeVersion(version: string | undefined): string | null {
    const parts = (version ?? '').replace(/^v/, '').split('.');
    const major = Number.parseInt(parts[0] ?? '', 10);
    const minor = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(major)) {
        return null;
    }

    if (major >= MIN_NODE_MAJOR) {
        const minMinor = MIN_MINOR_BY_MAJOR[major];
        if (minMinor === undefined || !Number.isFinite(minor) || minor >= minMinor) {
            return null;
        }
    }

    const required = `${String(MIN_NODE_MAJOR)}.${String(MIN_NODE_MINOR)}`;

    return [
        `devflow-diff-explain: Node ${required} or newer is required (in the 23 line — from 23.4 on), ` +
            `but Node ${version ?? 'of an unknown version'} is running.`,
        `Update Node (for example, nvm install ${required}) and run the command again.`,
    ].join('\n');
}
