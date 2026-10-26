import type { Comment, PrDiff, RouteSnapshot, RouteStop, Thread } from '@sherpa/protocol';

import type { IterationMap } from './iterations/index.js';
import { byteLength, fitText, unavailableBlock } from './payload-budget.js';

/**
 * Контекстные файлы перегенерации маршрута после пуша: прошлый маршрут и обсуждение,
 * появившееся с тех пор. Интердифф печатается общим печатником патчей (`route-payload.ts`),
 * здесь только то, чего у первой генерации не бывает.
 *
 * Тексты английские: их читает модель. Тексты прошлого маршрута — на его языке, они приезжают как есть.
 */

/** Что сервер знает о прошлом заходе на момент старта генерации. */
export interface RouteRegenerationContext {
    /** Снапшот, бывший текущим на старте генерации. */
    readonly previous: RouteSnapshot;
    /** Срез «итерация прошлого снапшота → итерация генерации»; null — та же итерация или срез не добыт. */
    readonly interdiff: PrDiff | null;
    /** Отображение строк того же среза; null — классификации и пометок «затронуто» не будет. */
    readonly map: IterationMap | null;
    /** Треды PR; null — хост их не отдал (или контекст восстановлен после рестарта). */
    readonly threads: readonly Thread[] | null;
}

/** Имена файлов каталога генерации: по ним же они опознаются после рестарта сервера. */
export const PREVIOUS_ROUTE_FILE = 'previous-route.md';
export const THREADS_SINCE_FILE = 'threads-since.md';

/**
 * Прошлый маршрут для задачи перегенерации: чем он был, чтобы модель сохранила номера и порядок
 * там, где код не менялся. Абзацы стопов — самое дорогое и самое ненужное при нехватке бюджета:
 * режутся первыми, с конца плана; таблица и выжимка уходят последними.
 *
 * Текст ветвится по наличию среза: без него пуша не было (перегенерация на той же итерации), и
 * говорить про «затронутое пушем» нечего.
 */
export function previousRouteContext(context: RouteRegenerationContext, budgetBytes: number): string {
    const { previous, map, interdiff } = context;
    const pushed = interdiff !== null;
    const stops = [...previous.stops].sort((left, right) => left.planIndex - right.planIndex);
    const head = [
        headBlock(previous, pushed),
        summaryBlock(previous),
        stopTableBlock(stops, map, pushed),
        textsHeading(pushed),
    ].join('\n\n');
    const texts = stops.filter((stop) => stop.paragraph !== null).map((stop) => stopTextBlock(stop));
    const render = (kept: number): string =>
        `${[head, ...texts.slice(0, kept), ...(kept === texts.length ? [] : [DROPPED_TEXTS_NOTE])].join('\n\n')}\n`;

    let kept = texts.length;
    while (kept > 0 && byteLength(render(kept)) > budgetBytes) {
        kept -= 1;
    }
    return fitText(render(kept), budgetBytes, unavailableBlock('Previous route', PREVIOUS_ROUTE_UNAVAILABLE));
}

const PREVIOUS_ROUTE_UNAVAILABLE = 'the previous route did not fit in the payload budget.';
const DROPPED_TEXTS_NOTE =
    '[TRUNCATED: the remaining stop texts of the previous route were omitted by the payload budget; ' +
    'the plan table above is complete.]';

function textsHeading(pushed: boolean): string {
    return [
        '## What each stop said',
        '',
        pushed
            ? 'The prose is what the reviewer already read. Reuse the parts the push did not invalidate.'
            : 'The prose is what the reviewer already read.',
    ].join('\n');
}

function headBlock(previous: RouteSnapshot, pushed: boolean): string {
    const { harness, model } = previous.provenance;
    const by = harness === null && model === null ? 'unknown agent' : `${harness ?? 'unknown'} / ${model ?? 'unknown'}`;
    const lead = pushed
        ? [
              'The route this pull request already had, built before the push you see in the interdiff.',
              'Stop numbers carry the progress of the reviewer: keep the plan, its order and its titles wherever',
              'the code did not change, and rewrite only what the push touched.',
          ]
        : [
              'The route this pull request already had. The code has not moved since it was built: this run',
              'rebuilds the route on the same commit, and there is no push to account for.',
              'Stop numbers carry the progress of the reviewer, so a stop you keep keeps its number. Past that,',
              'the previous route is here for the numbering, not as a template to copy.',
          ];
    return [
        '# Previous route',
        '',
        ...lead,
        '',
        `- Built for commit: ${previous.commit} (base ${previous.baseCommit})`,
        `- Built at: ${previous.createdAt}`,
        `- Built by: ${by}`,
        `- Stops: ${String(previous.stops.length)}`,
    ].join('\n');
}

function summaryBlock(previous: RouteSnapshot): string {
    return ['## Summary of the previous route', '', previous.summary].join('\n');
}

/**
 * План прошлого захода: номер, тир, заголовок, якоря и — когда пуш был — пометка «этот стоп он
 * задел». Пометка считается сервером по интердиффу, модель её читает, а не выводит. Без пуша
 * колонки нет: сплошное «no» модель прочла бы как «не трогай ничего».
 */
function stopTableBlock(stops: readonly RouteStop[], map: IterationMap | null, pushed: boolean): string {
    const rows = stops.map((stop) => {
        const cells = [String(stop.planIndex), stop.tier, stop.title, anchorList(stop)];
        return row(pushed ? [...cells, map === null ? '—' : yesNo(touchedByPush(stop, map))] : cells);
    });
    const lead = pushed
        ? [
              map === null
                  ? 'The server could not compute which stops the push touched: judge by the interdiff yourself.'
                  : 'The last column is the verdict of the server on whether the push touched the lines of that stop.',
              '',
              '| stop # | tier | title | anchors | touched by the push |',
              '|---|---|---|---|---|',
          ]
        : ['| stop # | tier | title | anchors |', '|---|---|---|---|'];
    return ['## Stops of the previous route', '', ...lead, ...rows].join('\n');
}

function stopTextBlock(stop: RouteStop): string {
    const bridge = stop.bridge === null ? [] : ['', `Bridge to the next stop: ${stop.bridge}`];
    return [
        `### Stop ${String(stop.planIndex)} — ${stop.tier} — ${stop.title}`,
        '',
        stop.paragraph ?? '',
        ...bridge,
    ].join('\n');
}

function touchedByPush(stop: RouteStop, map: IterationMap): boolean {
    return stop.anchors.some(
        (anchor) => map.touchedInA(anchor.path, anchor.side, { start: anchor.start, end: anchor.end }).length > 0,
    );
}

/** Якоря стопа в том виде, в каком их читает человек: `path:side:start-end`. */
function anchorList(stop: RouteStop): string {
    if (stop.anchors.length === 0) {
        return '—';
    }
    return stop.anchors
        .map((anchor) => `\`${anchor.path}\`:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}`)
        .join('; ');
}

/**
 * Обсуждение, появившееся после прошлого маршрута: треды с новым комментарием на затронутом
 * пушем файле или на уровне PR. Тред печатается целиком — ответ понятен только вместе с тем,
 * на что он отвечает, — а новые комментарии помечены. Черновики не печатаются вовсе.
 *
 * Файл пишется всегда, даже когда ничего не нашлось: иначе инструкция задачи ветвилась бы
 * ещё и по нему. Шапка ветвится по наличию среза: без пуша «на затронутом файле» — не про что.
 */
export function threadsSinceContext(context: RouteRegenerationContext, budgetBytes: number): string {
    const { threads, previous, map, interdiff } = context;
    const heading = threadsHeading(interdiff !== null);
    if (threads === null) {
        return `${[heading, '', THREADS_UNAVAILABLE].join('\n')}\n`;
    }

    const since = Date.parse(previous.createdAt);
    const selected = threads
        .filter((thread) => hasNewComment(thread, since) && onTouchedPlace(thread, map))
        .map((thread) => ({ thread, freshest: freshestAt(thread) }))
        .sort((left, right) => right.freshest - left.freshest);
    if (selected.length === 0) {
        return `${[heading, '', THREADS_EMPTY].join('\n')}\n`;
    }

    const blocks = selected.map((entry) => threadBlock(entry.thread, since));
    const render = (kept: number): string =>
        `${[heading, ...blocks.slice(0, kept), ...(kept === blocks.length ? [] : [droppedThreadsNote(blocks.length - kept)])].join('\n\n')}\n`;

    let kept = blocks.length;
    while (kept > 0 && byteLength(render(kept)) > budgetBytes) {
        kept -= 1;
    }
    return fitText(render(kept), budgetBytes, unavailableBlock('New comments', THREADS_UNAVAILABLE_BUDGET));
}

function threadsHeading(pushed: boolean): string {
    const scope = pushed
        ? [
              'Discussions with a comment written after the previous route was built, on a file the push',
              'touched or on the pull request itself.',
          ]
        : [
              'Discussions with a comment written after the previous route was built. The code has not moved',
              'since, so this is the only thing that is new.',
          ];
    return [
        '# New comments since the previous route',
        '',
        ...scope,
        'Threads are printed whole: the new comments are marked `(new)`, the older ones are there so that',
        'the answer makes sense. Unsent drafts of the reviewer are not shown at all.',
        '',
        'Cite a thread as `[thread:<id>]` with the id printed in its header — ids the server does not',
        'know are removed from your text.',
    ].join('\n');
}

const THREADS_EMPTY = 'No new comments since the previous route.';
const THREADS_UNAVAILABLE = '[UNAVAILABLE: the host did not give the discussion of this pull request.]';
const THREADS_UNAVAILABLE_BUDGET = 'the discussion did not fit in the payload budget.';

function droppedThreadsNote(count: number): string {
    return `[TRUNCATED: ${String(count)} older thread(s) omitted by the payload budget.]`;
}

function threadBlock(thread: Thread, since: number): string {
    const anchor = thread.anchor;
    const position = anchor?.position ?? null;
    const place =
        anchor === null
            ? 'PR-level'
            : `\`${anchor.path}\`${position === null ? ' (whole file)' : ` ${position.side}:${lineSpan(position.line, position.size)}`}`;
    const state = [
        thread.resolved ? 'resolved' : 'unresolved',
        ...(thread.outdated ? ['outdated'] : []),
        ...(thread.pinnedTo === null ? [] : [`pinned to ${thread.pinnedTo.commit}`]),
    ].join(', ');

    return [`## [thread:${thread.id}] — ${place}`, '', `State: ${state}`, '', ...commentLines(thread.root, since)].join(
        '\n',
    );
}

/**
 * Комментарии треда сверху вниз. Черновики пропускаются: их не видел даже автор PR, значит
 * причиной его правки они быть не могли, а модель приняла бы их за обычную реплику.
 */
function commentLines(comment: Comment, since: number): string[] {
    const replies = comment.replies.flatMap((reply) => commentLines(reply, since));
    if (comment.draft) {
        return replies;
    }
    const fresh = isNew(comment, since) ? ' (new)' : '';
    const body = comment.body.split('\n').map((line) => `  ${line}`);
    return [`- ${comment.author.login}, ${comment.createdAt}${fresh}:`, ...body, ...replies];
}

function lineSpan(line: number, size: number): string {
    return size <= 1 ? String(line) : `${String(line)}-${String(line + size - 1)}`;
}

/** Есть ли в треде опубликованный комментарий, написанный после прошлого маршрута. */
function hasNewComment(thread: Thread, since: number): boolean {
    return flatten(thread.root).some((comment) => isNew(comment, since));
}

function isNew(comment: Comment, since: number): boolean {
    return !comment.draft && Date.parse(comment.createdAt) > since;
}

/**
 * Место треда интересно ли перегенерации: уровень PR — всегда, файл — только когда пуш его
 * тронул. Карты нет — фильтровать нечем, берём всё, что новое.
 */
function onTouchedPlace(thread: Thread, map: IterationMap | null): boolean {
    const anchor = thread.anchor;
    if (anchor === null || map === null) {
        return true;
    }
    return map.fileStatus(anchor.path) !== 'unchanged';
}

function freshestAt(thread: Thread): number {
    return flatten(thread.root).reduce((latest, comment) => Math.max(latest, Date.parse(comment.createdAt)), 0);
}

function flatten(comment: Comment): Comment[] {
    return [comment, ...comment.replies.flatMap((reply) => flatten(reply))];
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}
