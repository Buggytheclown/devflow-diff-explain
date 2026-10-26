import type { z } from 'zod';

import type { RouteValidation } from './types.js';

/**
 * Первый шаг приёмки: сырой текст файла результата (`devflow-diff-explain task complete --file`) → JSON → схема.
 * Fail-closed: всё, что не разобралось, возвращается списком английских ошибок для модели.
 */

/** Разрешённый язык markdown-фенса вокруг результата: модели заворачивают JSON привычкой. */
const FENCE_TAG = /^[a-zA-Z0-9_-]*$/;

/**
 * Снятие обёртки ```json … ```. Срезается только честный фенс: тройные кавычки в начале,
 * тег языка без пробелов и закрывающие кавычки дальше по тексту.
 */
export function stripCodeFence(rawText: string): string {
    const text = rawText.trim();
    if (!text.startsWith('```')) {
        return text;
    }
    const firstBreak = text.indexOf('\n');
    if (firstBreak === -1 || !FENCE_TAG.test(text.slice(3, firstBreak).trim())) {
        return text;
    }
    const closing = text.lastIndexOf('```');
    if (closing <= firstBreak) {
        return text;
    }
    return text.slice(firstBreak + 1, closing);
}

/**
 * Разбор результата задачи по схеме протокола. `label` — имя корня в текстах ошибок,
 * чтобы модель видела путь к полю целиком (`stops[0].anchors[1].start`).
 */
export function parseResult<T>(rawText: string, schema: z.ZodType<T>, label: string): RouteValidation<T> {
    const text = stripCodeFence(rawText);
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            errors: [
                `Result is not valid JSON: ${reason}. Return a single JSON object matching the ${label} schema; a \`\`\`json fence around it is allowed.`,
            ],
        };
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        return { ok: false, errors: schemaErrors(parsed.error, label) };
    }
    return { ok: true, value: parsed.data };
}

/** Ошибки схемы в том же формате, что и семантические: `путь: что не так`. */
function schemaErrors(error: z.ZodError, label: string): string[] {
    return error.issues.map((issue) => `${label}${formatPath(issue.path)}: ${issue.message}`);
}

function formatPath(path: readonly PropertyKey[]): string {
    return path
        .map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`))
        .join('');
}
