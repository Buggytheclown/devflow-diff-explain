import type { AgentNote, ChatAnchor, ChatExchange, ChatExchangeStatus, Locale } from '@sherpa/protocol';
import { agentNoteSchema, chatExchangeSchema } from '@sherpa/protocol';

import { makeFileId } from '../patch.js';
import type { FixtureName } from './index.js';
import { MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT } from './medium.js';

/** История чата и локальные ИИ-заметки для галереи и сквозных тестов. */
export interface ChatFixtures {
    exchanges: ChatExchange[];
    notes: AgentNote[];
    /**
     * Те же заметки после переезда на вторую итерацию (`docs/design/SPEC-elements.md §2.16`): диапазоны неизменённых
     * файлов переехали по интердиффу, заметка на затронутом диапазоне якорь потеряла.
     */
    notesAfterPush: AgentNote[];
}

const P = {
    editWindow: 'services/orders/src/domain/edit-window.ts',
    editPolicy: 'services/orders/src/domain/policies/edit-policy.ts',
    handlers: 'services/orders/src/api/handlers.ts',
} as const;

const ANSWER_SELECTION = [
    'Статус `409` здесь соответствует двум состояниям, в которых запланированную доставку уже нельзя менять:',
    '',
    '- `edit-window-closed` — истекло 30 минут после оформления;',
    '- `already-dispatched` — курьер забрал заказ раньше дедлайна.',
    '',
    'Оба кода выбираются через `REJECTION_STATUS`, а тело ответа сохраняет машинную причину и остаток времени:',
    '',
    '```ts',
    'res.status(REJECTION_STATUS[decision.reason]).json({',
    '    error: decision.reason,',
    '    remainingMs: policy.remainingMs(order),',
    '});',
    '```',
    '',
    'Для `not-scheduled` остаётся `400`: у экспресс-доставки окно редактирования не закрывалось, оно к ней неприменимо.',
].join('\n');

const ANSWER_PR = [
    'PR переносит правило 30 минут из разрозненных проверок в доменную модель.',
    '',
    '1. `domain/edit-window.ts` вычисляет дедлайн, досрочное закрытие после отправки и сокращённые окна для свежих продуктов и аптеки.',
    '2. `domain/policies/edit-policy.ts` возвращает машинные причины отказа вместо свободного текста.',
    '3. `api/handlers.ts` отображает причины в `409` или `400`, возвращает `remainingMs` и пишет аудит.',
    '4. Тесты фиксируют границу 30 минут, отправку, экспресс-доставку и категорийные окна.',
    '',
    'Ключевой поток после правки:',
    '',
    '```text',
    'Order → EditWindow.state → EditPolicy.decide → HTTP status + audit',
    '```',
    '',
    'В диффе не видно конфигурации выката за пределами `docs/edit-window.md` и `.github/workflows/ci.yml`, поэтому подтвердить фактические значения флага по окружениям нельзя.',
].join('\n');

const ANSWER_CLASS = [
    'Класс нужен не ради хранения состояния, а ради явной зависимости от времени.',
    '',
    '- `Clock` подменяется на `FrozenClock` в тестах;',
    '- вычисление окна сосредоточено в одном месте;',
    '- вызывающий не передаёт `now` вручную по всей цепочке.',
    '',
    '```ts',
    'const window = new EditWindow(clock);',
    'const state = window.state({ order, slot });',
    '```',
    '',
    'Цена решения — зависимость от времени видна в конструкторе `EditWindow`, но не в сигнатуре `state`.',
].join('\n');

const ANSWER_DISPATCH = [
    'Отправка закрывает окно только если случилась раньше расчётного дедлайна.',
    '',
    '```ts',
    'if (slot.dispatchedAt !== null && slot.dispatchedAt < closesAt) {',
    '    return { kind: "closed", closedAt: slot.dispatchedAt, cause: "dispatch" };',
    '}',
    '```',
    '',
    'Если `dispatchedAt` позже дедлайна, причиной остаётся `deadline`. Это сохраняет первый фактический момент, после которого правка была запрещена.',
].join('\n');

const ANSWER_EXPLAIN = [
    'Метод `explain` отдаёт формулировку для экрана покупателя, а не для API.',
    '',
    '- API возвращает машинный код отказа и статус;',
    '- текст берётся из `describeState` и может меняться без версии контракта.',
    '',
    '```ts',
    'return describeState(this.window.state({ order, slot: order.slot }));',
    '```',
    '',
    'Из-за этого формулировку можно править отдельно от контракта — тестами она почти не закрыта.',
].join('\n');

const ANSWER_CATEGORY = [
    'Метод начинает с общего окна 30 минут и выбирает минимальное переопределение среди позиций заказа.',
    '',
    '- обычный товар — 30 минут;',
    '- `FF-` — 10 минут;',
    '- `PH-` — 5 минут.',
    '',
    '```ts',
    'shortest = Math.min(shortest, override);',
    '```',
    '',
    'В текущем диффе вместо `Math.min` стоит эквивалентная проверка `override < shortest`. Для смешанной корзины с аптечным товаром итог — 5 минут.',
].join('\n');

function anchor(path: string, start: number, end: number): ChatAnchor {
    return {
        diffId: MEDIUM_DIFF_ID,
        fileId: makeFileId(MEDIUM_DIFF_ID, path),
        path,
        side: 'new',
        start,
        end,
    };
}

interface ExchangeSpec {
    id: number;
    question: string;
    anchor: ChatAnchor | null;
    status: ChatExchangeStatus;
    answer?: string;
    progressText?: string;
    error?: string;
    /** Язык ответа; без него — фикстурный обмен русский, как и весь набор `medium`. */
    locale?: Locale;
    createdAt: string;
    updatedAt?: string;
}

function exchange(spec: ExchangeSpec): ChatExchange {
    return {
        id: spec.id,
        question: spec.question,
        anchor: spec.anchor,
        status: spec.status,
        // Фикстурный снапшот задач чат-задач не содержит — связь с очередью здесь ни к чему.
        taskId: null,
        answer: spec.answer ?? null,
        progressText: spec.progressText ?? null,
        error: spec.error ?? null,
        locale: spec.locale ?? 'ru',
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt ?? spec.createdAt,
    };
}

function note(id: number, source: ChatExchange, createdAt: string): AgentNote {
    if (source.anchor === null || source.answer === null) {
        throw new Error(`обмен ${String(source.id)} не годится для заметки`);
    }
    return {
        id,
        exchangeId: source.id,
        anchor: source.anchor,
        text: source.answer,
        lostAnchor: false,
        origin: { commit: MEDIUM_HEAD_COMMIT, anchor: source.anchor },
        createdAt,
    };
}

function exchangeById(exchanges: readonly ChatExchange[], id: number): ChatExchange {
    const found = exchanges.find((item) => item.id === id);
    if (found === undefined) {
        throw new Error(`в чат-фикстуре нет обмена ${String(id)}`);
    }
    return found;
}

function makeMediumChatFixtures(): ChatFixtures {
    const exchanges = [
        exchange({
            id: 1,
            question: 'Почему закрытое окно отвечает 409, а не 400?',
            anchor: anchor(P.handlers, 48, 54),
            status: 'done',
            answer: ANSWER_SELECTION,
            createdAt: '2026-08-20T09:12:00.000Z',
            updatedAt: '2026-08-20T09:12:18.000Z',
        }),
        exchange({
            id: 2,
            question: 'Разложи изменение этого PR по механике и рискам.',
            anchor: null,
            status: 'done',
            answer: ANSWER_PR,
            createdAt: '2026-08-20T09:15:00.000Z',
            updatedAt: '2026-08-20T09:15:31.000Z',
        }),
        exchange({
            id: 3,
            question: 'Какие строки маршрут может оставить без объяснения?',
            anchor: null,
            status: 'queued',
            createdAt: '2026-08-20T09:16:00.000Z',
        }),
        exchange({
            id: 4,
            question: 'Проверь, согласованы ли HTTP-статусы с доменными причинами отказа.',
            anchor: anchor(P.editPolicy, 30, 43),
            status: 'running',
            progressText: 'Сверяю причины отказа с обработчиками API',
            createdAt: '2026-08-20T09:17:00.000Z',
            updatedAt: '2026-08-20T09:17:09.000Z',
        }),
        exchange({
            id: 5,
            question: 'Есть ли в PR незакрытый риск утечки платёжных данных?',
            anchor: null,
            status: 'failed',
            error: 'Агент завершил задачу без ответа после трёх попыток проверки.',
            createdAt: '2026-08-20T09:18:00.000Z',
            updatedAt: '2026-08-20T09:19:04.000Z',
        }),
        exchange({
            id: 6,
            question: 'Сравни новый контракт с прежним поведением клиента.',
            anchor: null,
            status: 'cancelled',
            createdAt: '2026-08-20T09:20:00.000Z',
            updatedAt: '2026-08-20T09:20:07.000Z',
        }),
        exchange({
            id: 7,
            question: 'Почему `EditWindow` сделан классом, а не чистой функцией?',
            anchor: anchor(P.editWindow, 24, 32),
            status: 'done',
            answer: ANSWER_CLASS,
            createdAt: '2026-08-20T09:22:00.000Z',
            updatedAt: '2026-08-20T09:22:16.000Z',
        }),
        exchange({
            id: 8,
            question: 'Как выбирается причина закрытия между отправкой и дедлайном?',
            anchor: anchor(P.editWindow, 29, 38),
            status: 'done',
            answer: ANSWER_DISPATCH,
            createdAt: '2026-08-20T09:23:00.000Z',
            updatedAt: '2026-08-20T09:23:14.000Z',
        }),
        exchange({
            id: 10,
            question: 'Зачем политике отдельный `explain`, если API его не возвращает?',
            anchor: anchor(P.editPolicy, 45, 56),
            status: 'done',
            answer: ANSWER_EXPLAIN,
            createdAt: '2026-08-20T09:26:00.000Z',
            updatedAt: '2026-08-20T09:26:11.000Z',
        }),
        exchange({
            id: 9,
            question: 'Как считается окно для смешанной корзины?',
            anchor: anchor(P.editWindow, 31, 43),
            status: 'done',
            answer: ANSWER_CATEGORY,
            createdAt: '2026-08-20T09:24:00.000Z',
            updatedAt: '2026-08-20T09:24:12.000Z',
        }),
    ];

    // Заметки 2–4 стоят на `edit-window.ts`, которого второй пуш не касается, — они переедут;
    // заметка 5 съедет вместе с диапазоном `edit-policy.ts`; заметка 1 стоит на строках,
    // которые пуш переписал, и якорь потеряет.
    const notes = [
        note(1, exchangeById(exchanges, 1), '2026-08-20T09:12:18.000Z'),
        note(2, exchangeById(exchanges, 7), '2026-08-20T09:22:16.000Z'),
        note(3, exchangeById(exchanges, 8), '2026-08-20T09:23:14.000Z'),
        note(4, exchangeById(exchanges, 9), '2026-08-20T09:24:12.000Z'),
        note(5, exchangeById(exchanges, 10), '2026-08-20T09:26:11.000Z'),
    ];

    return { exchanges, notes, notesAfterPush: notes.map(afterPush) };
}

/**
 * Сдвиг диапазона заметки во второй итерации; `lost` — пуш переписал сами строки,
 * и якорь перенести не удалось.
 */
const NOTE_MIGRATION: Record<string, number | 'lost'> = {
    [P.editWindow]: 0,
    [P.editPolicy]: 6,
    [P.handlers]: 'lost',
};

/**
 * Заметка глазами второй итерации. У потерявшей якорь `anchor` остаётся последним удачным
 * (контракт `agentNoteSchema`), `origin` не двигается ни у кого.
 */
function afterPush(source: AgentNote): AgentNote {
    const shift = NOTE_MIGRATION[source.anchor.path];
    if (shift === undefined) {
        throw new Error(`для заметки на ${source.anchor.path} не задан перенос якоря`);
    }
    if (shift === 'lost') {
        return { ...source, lostAnchor: true };
    }
    return {
        ...source,
        anchor: {
            ...source.anchor,
            diffId: MEDIUM_DIFF_ID_V2,
            fileId: makeFileId(MEDIUM_DIFF_ID_V2, source.anchor.path),
            start: source.anchor.start + shift,
            end: source.anchor.end + shift,
        },
    };
}

const BUILDERS: Partial<Record<FixtureName, () => ChatFixtures>> = {
    medium: makeMediumChatFixtures,
};

function validate(fixtures: ChatFixtures): ChatFixtures {
    return {
        exchanges: fixtures.exchanges.map((item) => chatExchangeSchema.parse(item)),
        notes: fixtures.notes.map((item) => agentNoteSchema.parse(item)),
        notesAfterPush: fixtures.notesAfterPush.map((item) => agentNoteSchema.parse(item)),
    };
}

const built = new Map<FixtureName, ChatFixtures | null>();

/** Сборка чат-фикстур с нуля, мимо кэша. */
export function buildChatFixtures(name: FixtureName): ChatFixtures | null {
    const builder = BUILDERS[name];
    return builder === undefined ? null : validate(builder());
}

/** Свежая копия чат-фикстур; сейчас данные есть только у `medium`. */
export function chatFixtures(name: FixtureName): ChatFixtures | null {
    let fixtures = built.get(name);
    if (fixtures === undefined) {
        fixtures = buildChatFixtures(name);
        built.set(name, fixtures);
    }
    return fixtures === null ? null : structuredClone(fixtures);
}
