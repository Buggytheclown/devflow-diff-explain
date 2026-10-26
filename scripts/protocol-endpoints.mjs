#!/usr/bin/env node
/**
 * Таблица ручек протокола для `docs/protocol.md` §10.
 *
 * Пути и методы читаются из кода: `UI_ENDPOINTS` в `packages/protocol/src/ui.ts` (метод — из JSDoc
 * над ключом) и `WORKER_ENDPOINTS` в `packages/protocol/src/constants.ts` (все POST). Назначение —
 * из карты `DESCRIPTIONS` ниже: JSDoc в `ui.ts` описывает схемы запроса и ответа, а не смысл ручки.
 * Карта обязана совпадать с кодом ключ в ключ — новая ручка без описания и описание без ручки
 * роняют скрипт, чтобы таблица не протухала молча.
 *
 * Использование: `node scripts/protocol-endpoints.mjs` — печать в stdout,
 * `--write` — замена содержимого между маркерами `<!-- endpoints:start -->` и `<!-- endpoints:end -->`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_FILE = path.join(ROOT, 'packages/protocol/src/ui.ts');
const CONSTANTS_FILE = path.join(ROOT, 'packages/protocol/src/constants.ts');
const DOC_FILE = path.join(ROOT, 'docs/protocol.md');

const START_MARKER = '<!-- endpoints:start -->';
const END_MARKER = '<!-- endpoints:end -->';

/** Назначение ручки — одна фраза. Ключи повторяют `UI_ENDPOINTS` и `WORKER_ENDPOINTS`. */
const DESCRIPTIONS = {
    ui: {
        state: 'снимок состояния PR для первой отрисовки',
        enqueue: 'постановка задачи из UI (только `echo`, дев-демо петли)',
        cancel: 'снятие поставленной задачи',
        events: 'SSE-поток: снимок состояния и ревизии ревью, прогресса, маршрута, чата',
        reviewDiff: 'дифф итерации PR',
        reviewThreads: 'треды комментариев PR',
        reviewLenses: 'линзы фильтра файлов',
        reviewFileContent: 'содержимое файла для разворота контекста',
        reviewBlob: 'байты картинки по `blobId`',
        reviewProgress: 'прогресс чтения по итерации',
        reviewFileViewed: 'отметка файла прочитанным',
        reviewStopViewed: 'отметка прочитанных диапазонов остановки',
        reviewStopFileViewed: 'отметка прочитанных строк файла в одной остановке',
        reviewViewedMirror: 'зеркалирование отметки «файл прочитан» в хост',
        reviewSaveDraft: 'сохранение черновика комментария',
        reviewUpdateDraft: 'правка черновика комментария',
        reviewDraftBuffer: 'буфер черновиков, которые хост не принял',
        reviewDraftBufferRetry: 'повтор записи черновика из буфера',
        reviewDraftBufferDiscard: 'выброс черновика из буфера',
        reviewDeleteDraft: 'удаление черновика комментария',
        reviewThreadResolved: 'пометка треда решённым',
        reviewCommentResolved: 'пометка issue комментария закрытым',
        reviewUpdateComment: 'правка своего опубликованного комментария',
        reviewDeleteComment: 'удаление своего опубликованного комментария',
        reviewPublish: 'публикация черновиков вердиктом',
        reviewRoute: 'маршрут снапшота',
        reviewSnapshots: 'список снапшотов маршрута',
        reviewRouteGenerate: 'запуск и перезапуск генерации маршрута',
        reviewRouteFillStop: 'перезаполнение одной остановки',
        reviewChat: 'история чата и заметки агента',
        reviewChatAsk: 'вопрос агенту',
        reviewChatCancel: 'отмена заданного вопроса',
        reviewChatRetry: 'повтор провалившегося вопроса',
        reviewChatNoteDelete: 'удаление заметки агента',
        feedback: 'отзыв ревьюера тикетом в Трекер',
        updateCheck: 'проверка новой версии дистрибутива по требованию',
        settings: 'настройки ревьюера: чтение и правка',
        prState: 'состояние UI этого PR: свёрнутые узлы, недавние команды палитры',
    },
    worker: {
        register: 'регистрация сессии воркером PR',
        next: 'long-poll за следующей задачей',
        complete: 'сдача результата задачи',
        progress: 'статусная отметка по задаче',
        fail: 'отказ от задачи с причиной',
    },
};

/** Воркерские ручки метода в JSDoc не несут: он объявлен на объекте разом. */
const WORKER_METHOD = 'POST';

function main() {
    const ui = parseEndpoints(read(UI_FILE), 'UI_ENDPOINTS', UI_FILE);
    const worker = parseEndpoints(read(CONSTANTS_FILE), 'WORKER_ENDPOINTS', CONSTANTS_FILE);

    assertWorkerMethod(worker);

    const markdown = [
        '### UI-ручки',
        '',
        renderTable(ui.entries, DESCRIPTIONS.ui, 'UI_ENDPOINTS', (entry) => methodsOf(entry, UI_FILE)),
        '',
        '### Воркерские ручки',
        '',
        renderTable(worker.entries, DESCRIPTIONS.worker, 'WORKER_ENDPOINTS', () => WORKER_METHOD),
    ].join('\n');

    if (process.argv.includes('--write')) {
        write(markdown);
        return;
    }
    process.stdout.write(`${markdown}\n`);
}

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        fail(`не читается ${file}: ${error.message}`);
    }
}

/**
 * Объектный литерал вида `export const NAME = { key: '/path', ... } as const;` вместе с JSDoc
 * над каждым ключом. Разбор построчный: полноценный парсер TS ради пяти десятков строк не нужен,
 * но форма литерала фиксирована — отклонение от неё роняет скрипт, а не молча теряет ручку.
 */
function parseEndpoints(source, name, file) {
    const header = new RegExp(`export const ${name} = \\{\\r?\\n`).exec(source);
    if (header === null) {
        fail(`в ${file} не найден объект ${name} — проверь имя`);
    }

    const bodyStart = header.index + header[0].length;
    const bodyEnd = source.indexOf('\n} as const;', bodyStart);
    if (bodyEnd === -1) {
        fail(`в ${file} не найден конец объекта ${name} (строка \`} as const;\`)`);
    }

    const entries = [];
    let doc = null;
    let insideDoc = false;
    for (const raw of source.slice(bodyStart, bodyEnd).split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        if (line.startsWith('/**')) {
            doc = line;
            insideDoc = !line.endsWith('*/');
            continue;
        }
        if (insideDoc) {
            doc += ` ${line}`;
            insideDoc = !line.endsWith('*/');
            continue;
        }

        const entry = /^(\w+):\s*'([^']+)',$/.exec(line);
        if (entry === null) {
            fail(`в ${file} строка объекта ${name} не разобрана: ${line}`);
        }
        entries.push({ key: entry[1], path: entry[2], doc: doc ?? '', object: name });
        doc = null;
    }

    if (entries.length === 0) {
        fail(`в ${file} объект ${name} пуст`);
    }
    return { entries };
}

/** HTTP-методы ручки в порядке появления в её JSDoc. */
function methodsOf(entry, file) {
    const found = [...entry.doc.matchAll(/\b(GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1]);
    const unique = [...new Set(found)];
    if (unique.length === 0) {
        fail(
            `у ручки \`${entry.key}\` в ${file} нет метода в JSDoc — ` +
                'начни комментарий с `GET`/`POST`/`PATCH`, из него берётся колонка таблицы',
        );
    }
    return unique.join(', ');
}

/** Метод воркерских ручек объявлен один на весь объект — проверяем, что он всё ещё POST. */
function assertWorkerMethod(worker) {
    const source = read(CONSTANTS_FILE);
    const docStart = source.lastIndexOf('/**', source.indexOf('export const WORKER_ENDPOINTS'));
    const doc = source.slice(docStart, source.indexOf('export const WORKER_ENDPOINTS'));
    if (!doc.includes(WORKER_METHOD)) {
        fail(
            `JSDoc над WORKER_ENDPOINTS больше не говорит про ${WORKER_METHOD} — ` +
                'метод воркерских ручек изменился, поправь скрипт',
        );
    }
    if (worker.entries.some((entry) => !entry.path.startsWith('/api/'))) {
        fail('путь воркерской ручки не начинается с /api/ — проверь WORKER_ENDPOINTS');
    }
}

function renderTable(entries, descriptions, object, methodOf) {
    assertDescriptions(entries, descriptions, object);

    const rows = entries.map(
        (entry) => `| \`${entry.key}\` | \`${methodOf(entry)} ${entry.path}\` | ${descriptions[entry.key]} |`,
    );
    return ['| Ключ | Метод и путь | Назначение |', '|---|---|---|', ...rows].join('\n');
}

/** Карта описаний обязана совпадать с кодом ключ в ключ — иначе таблица тихо разъедется. */
function assertDescriptions(entries, descriptions, object) {
    const keys = new Set(entries.map((entry) => entry.key));
    const missing = [...keys].filter((key) => descriptions[key] === undefined);
    if (missing.length > 0) {
        fail(
            `в ${object} появились ручки без описания: ${missing.join(', ')}.\n` +
                'Добавь их в DESCRIPTIONS в scripts/protocol-endpoints.mjs — одной фразой.',
        );
    }

    const extra = Object.keys(descriptions).filter((key) => !keys.has(key));
    if (extra.length > 0) {
        fail(
            `в DESCRIPTIONS есть ключи, которых больше нет в ${object}: ${extra.join(', ')}.\n` +
                'Удали их из scripts/protocol-endpoints.mjs.',
        );
    }
}

function write(markdown) {
    const doc = read(DOC_FILE);
    const start = doc.indexOf(START_MARKER);
    const end = doc.indexOf(END_MARKER);
    if (start === -1 || end === -1 || end < start) {
        fail(`в ${DOC_FILE} нет маркеров ${START_MARKER} … ${END_MARKER}`);
    }

    const updated = `${doc.slice(0, start + START_MARKER.length)}\n${markdown}\n${doc.slice(end)}`;
    if (updated === doc) {
        process.stdout.write('Таблица ручек не изменилась.\n');
        return;
    }
    fs.writeFileSync(DOC_FILE, updated);
    process.stdout.write(`Таблица ручек обновлена: ${DOC_FILE}\n`);
}

function fail(message) {
    process.stderr.write(`protocol-endpoints: ${message}\n`);
    process.exit(1);
}

main();
