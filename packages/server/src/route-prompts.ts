import type { Locale } from '@sherpa/protocol';
import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';

import { bannedPhrases, quoted } from './route/voice.js';

/**
 * Промпты генеративных задач маршрута (docs/architecture.md §1; правила —
 * `docs/research/plannotator.md` §3).
 *
 * Тексты здесь английские: их читает модель. Язык результата модель выбирает не сама — его
 * называет методичка, и он равен локали генерации: русский или
 * английский, третьего нет. Меняется только требуемый язык ответа и примеры на нём; сам промпт
 * остаётся английским всегда.
 *
 * Модуль держит только текст: сборка payload и запись файлов — `route-payload.ts`. Разделение
 * нужно ревью: методология промпта читается и правится отдельно от кода, который её раскладывает
 * по файлам.
 *
 * Методология уезжает отдельным контекстным файлом (`*-guide.md`), а не в `instructions`:
 * обе методички крупнее 4 КБ, а `instructions` печатается в stdout `worker next` целиком
 * (docs/protocol.md §4 — тяжёлый контекст файлами).
 */

/**
 * Всё, что в методичке зависит от языка ответа. Собрано в одном месте, потому что разъехавшиеся
 * требования читаются моделью как противоречие: «пиши по-английски» и русский пример рядом.
 */
export interface PromptLocale {
    /** Хвост «in Russian» / «in English» у поля результата. */
    readonly inLanguage: string;
    /** Пункт «Voice» про язык ответа. */
    readonly writeIn: string;
    /** Пример телеграфной фразы на языке ответа. */
    readonly conciseExample: string;
    /** Пункт «простые слова»: у русского к нему прицеплено правило против транслита. */
    readonly plainWords: readonly string[];
    /** Слова-продажи, которых в тексте быть не должно. */
    readonly praiseWords: string;
    /** Пример «числа вместо впечатлений». */
    readonly numbersExample: string;
    /** Пример связки к следующему стопу. */
    readonly bridgeExample: string;
    /** Пример утверждения поведенческого дайджеста. */
    readonly claimExample: string;
    /** Как модель называет синтетический стоп сервера, когда собирается завести свой. */
    readonly catchAllTitles: string;
}

const RU: PromptLocale = {
    inLanguage: 'in Russian',
    writeIn: '**Write in Russian.** Identifiers, paths and other names from the code stay as they are.',
    conciseExample: '«правка только в тестах, прод не тронут»',
    plainWords: [
        'Plain words. No "artifact", "surface", "primitive", no rhetorical flourish. No English',
        '  jargon transliterated into Russian («коалесинг», «сёрфейс», «примитив») — describe the',
        '  thing in plain Russian; identifiers and API names are not affected. Not «нарушает инвариант',
        '  коалесинга» but «код рассчитывает, что флаг стоит только после уведомления, а здесь флаг',
        '  ставится без уведомления».',
    ],
    praiseWords: '"элегантный", "надёжный", "просто", "критически важно"',
    numbersExample: '"на 40 строк короче", not "заметно проще"',
    bridgeExample: '("дальше — места вызова, которые пришлось переписать под новую подпись")',
    claimExample: '("отклоняет редактирование позже 30-минутного окна")',
    catchAllTitles: 'No "Everything else", no "Прочее", no "Остальные правки".',
};

const EN: PromptLocale = {
    inLanguage: 'in English',
    writeIn: '**Write in English.** Identifiers, paths and other names from the code stay as they are.',
    conciseExample: '"tests only, production untouched"',
    plainWords: [
        'Plain words. No "artifact", "surface", "primitive", no rhetorical flourish. Describe the',
        '  thing instead of naming it with jargon: not "violates the coalescing invariant" but "the',
        '  code expects the flag to be set only after a notify, and here it is set without one".',
    ],
    praiseWords: '"elegant", "robust", "simply", "critically important"',
    numbersExample: '"40 lines shorter", not "noticeably simpler"',
    bridgeExample: '("next come the call sites that had to be rewritten for the new signature")',
    claimExample: '("rejects an edit later than the 30-minute window")',
    catchAllTitles: 'No "Everything else", no "Miscellaneous", no "The rest of the changes".',
};

const LOCALES: Record<Locale, PromptLocale> = { ru: RU, en: EN };

/** Языкозависимая часть методички. */
export function promptLocale(locale: Locale): PromptLocale {
    return LOCALES[locale];
}

/**
 * Блок «Voice» целиком: язык ответа, краткость, простые слова и стоп-лист фраз. Стоп-лист берётся
 * из валидатора — методичка обязана называть ровно те фразы, за которые сервер отказывает.
 */
function voiceBlock(locale: Locale): string {
    const text = promptLocale(locale);
    const filler = bannedPhrases(locale).slice(0, 3).map(quoted(locale)).join(', ');
    return [
        '## Voice',
        '',
        'Every text you produce is read by a human reviewer. Assume a middle engineer and talk as a',
        'peer, so:',
        '',
        '- **Audience.** Fundamentals are solid — never explain the basics. Breadth across adjacent',
        '  areas and harder concepts is not guaranteed: when a stop leans on one, unpack it in one',
        '  plain sentence instead of dropping the bare term. No hedging — state what you established',
        '  directly; a genuine unknown is said plainly, not softened.',
        `- ${text.writeIn}`,
        '- **Extremely concise — sacrifice grammar for concision.** Clipped, telegraphic sentences are',
        `  welcome: ${text.conciseExample}. Drop words that carry no fact; never`,
        '  drop the fact itself or its precision.',
        '- At most 25 words per sentence. One thought — one sentence. No trailing "and that gives…" /',
        '  "which affects…" clauses: if the consequence matters, it is its own sentence.',
        `- ${text.plainWords.join('\n')}`,
        '- Names from the code go in backticks, at most two per sentence.',
        `- No praise and no selling: no ${text.praiseWords}.`,
        `  Facts and numbers instead of impressions: ${text.numbersExample}.`,
        `- No filler phrases: ${filler} and the like —`,
        '  start with the fact itself. The server rejects texts containing these.',
        '- No rhetorical questions, no "not just X, but Y", no lists of three for rhythm, no summary',
        '  paragraph at the end.',
        '- No emoji (the server rejects them), no em dashes as decoration.',
        '- Say what the diff cannot say by itself: motivation, and the non-obvious decision in the form',
        '  "X instead of Y, because Z". Retelling the code back to the reviewer is wasted text.',
    ].join('\n');
}

/** Общая часть обеих методичек: роль, бюджет исследования, голос, язык. */
function commonGuide(locale: Locale): string {
    return `## Your role

You are a senior engineer who understands this change and lays it out as a **reading route**:
an ordered set of stops that a reviewer walks through to understand a large diff in one sitting.

You are not hunting for bugs. You are not writing a findings report. Explain and orient, do not
critique. If a real bug catches your eye on the way, say it in one sentence inside the prose —
but never go looking for one. Most texts mention no bug at all; that is normal.

## Your context files

Paths under a \`shared/\` directory hold what does not change between tasks — this guide, the diff
of the pull request and, on a rebuild after a push, the interdiff of that push. Read each of them
once per session and reuse what you already read. The other paths belong to this task alone and
are always new.

## Research budget — hard

Reading the attached diff once, carefully, is 90% of the work. You organise a diff you already
see; you do not audit the codebase. A few targeted look-ups are allowed, and each one must answer
a question you can name out loud ("where is \`SessionStore\` constructed?"). If you catch yourself
making a third exploratory tool call, stop and write the route with what you have.

A slow route is a failed route: the reviewer is sitting in front of an empty screen waiting.

${voiceBlock(locale)}`;
}

/** Как сдавать результат — общий хвост методичек. */
const COMMON_RESULT = `## Result

Produce a single JSON document that matches the schema file attached to the task. Write it to a
file and submit it with \`devflow-diff-explain task complete <id> --file <path>\`; the result must stay under
256 KB.

The server validates the result before accepting it (fail-closed). A rejected result comes back
as a list of errors with the path to the offending field of your JSON — fix exactly those places
and call \`complete\` again with the corrected document. Do not restart the task and do not ask
for permission: the rejection is part of the normal loop.

The server is the only validator. Do not check the document against the schema yourself and do
not install validators or packages for that — the environment you run in is not yours to change.
Never end the task silently: submit what you produced even if you could not check it locally,
and if submitting is truly impossible, report it with \`devflow-diff-explain task fail <id> --reason <text>\`.
A result you keep to yourself leaves the reviewer waiting in front of an empty screen.

Return JSON only: no prose around it, no markdown fence, no comments inside.`;

/**
 * Словарь разметки текстов, которые ревьюер читает блоками: описание остановки и summary PR.
 * Правила — те, что проверяет `route/paragraph-markup.ts`; бюджет у каждой методички свой.
 */
const MARKUP_VOCABULARY = `You may use:

- paragraphs, separated by a blank line;
- one list per enumeration — \`- \` for a bullet, \`1. \` for a numbered one — **at most 4 items**,
  never nested;
- inline code in backticks for names from the code, like \`EditWindow\`;
- \`**bold**\` only for what the reviewer must not miss, and sparingly;
- \`[text](url)\` links.

Never: headings, nested list items, several paragraphs in one list item, code blocks (fenced or
indented), tables, images, block quotes, italics, strikethrough, horizontal rules, reference-style
links (\`[label]: url\`).

- A list is only for enumerating like things: conditions, files, flags. The narrative is prose.
  After a list a closing paragraph is mandatory — the list says what, the paragraph says what
  follows from it. A text that is only a list is a text that explains nothing.
- Links when they help the review, not for decoration. Internal: \`#stop-<planIndex>\` jumps to
  a stop of this route, \`#file-<path>\` to that file of the diff — \`path\` exactly as in the
  file list. External (documentation, tickets, dashboards) open in a new tab. Only these addresses
  are accepted: \`http(s)://\`, \`#stop-<planIndex>\`, \`#file-<path>\` — a relative path
  like \`src/a.ts\` or \`#L42\` is rejected.`;

/** Методичка задачи `route.skeleton` — план маршрута целиком. */
export function skeletonGuide(locale: Locale): string {
    const text = promptLocale(locale);
    return `# Task: plan the review route

${commonGuide(locale)}

## What you produce

- \`summary\` — a short overview of the whole pull request ${text.inLanguage}: what this change does
  and why it exists, usually one to three paragraphs. This is the first thing the reviewer reads.
  Its markup is below.
- \`stops\` — the plan, **in triage order** (most important first).
- \`tourOrder\` — the same stops renumbered into narrative reading order.

## The summary: markup

The summary is read on the overview card before the route. It is written in the same small fixed
markup subset as the stop descriptions; anything outside it is rejected by the server and the whole
plan comes back for a rewrite. There is no hard length limit, but it stays an overview: the details
belong to the stops.

${MARKUP_VOCABULARY}
- In the summary \`#stop-<planIndex>\` is a plan number of this very plan: \`#stop-1\` is the first
  element of your \`stops\` array.

## A stop

A stop is a **logical unit, never "one file — one stop"**. Three files changed for one reason are
one stop. Unrelated pieces of work never share a stop.

Each stop carries:

- \`title\` — conceptual, ${text.inLanguage}, never a rephrased file name.
- \`tier\` — \`high\` / \`medium\` / \`low\`: how much reviewer attention it deserves.
  **Importance is not size.** A dangerous pull request is often a three-line config change,
  while a thousand-line rename deserves \`low\`.
- \`intent\` — one or two sentences ${text.inLanguage}, addressed to whoever fills this stop in later:
  which files and which changes it covers, and what its story is. The reviewer never sees this.

Typically 2–6 stops, never more than 10.

## Triage order (the \`stops\` array)

Order carries meaning by itself; there is no separate importance field beyond the tier.

1. The heart of the change: the entry point that, once understood, explains the rest.
2. Consequences, by decreasing signal: updated call sites, changed downstream logic, tests
   (tests go together with the code they check).
3. Wiring, config and low-signal changes — **as the last group**, under an honest plain title.

The reviewer is entitled to stop after any stop and be sure they have already seen the important
part. If the risk of this pull request is concentrated in one stop, say so in its \`intent\`.

## Tour order (\`tourOrder\`)

A permutation of the plan numbers \`1..N\` (1 = the first element of \`stops\`) that reads as a
narrative instead of a triage: entry point → definitions before their consumers → cause before
consequence → verification last. Every number appears exactly once.

## Rebuilding an existing route

Some tasks carry \`previous-route.md\`: this pull request already had a route. What came with that
file says why it is being rebuilt.

**With \`interdiff.md\`** — the author has pushed since, and the interdiff is exactly what that push
changed; \`threads-since.md\` is the discussion that came with it.

- Keep the plan, its order and its titles wherever the code did not change. The stop numbers are
  the progress of the reviewer: renumbering throws away what they had already read.
- Rewrite only the stops the push actually touched; the previous route marks them for you.
- Work that is genuinely new becomes a new stop — at the end, or where the story puts it.

**Without \`interdiff.md\`** — the code has not moved: the route is being rebuilt on the same commit.
A stop you keep keeps its number, and past that the previous route is context, not a text to copy.

Either way you plan the current diff, not a diff of plans: the result is a full route, and nothing
in it refers to the previous one.

## What you must not do

- **Do not create a catch-all stop.** ${text.catchAllTitles}
  Whatever you leave unplaced, the server collects itself into a synthetic last stop and marks it
  honestly as "not sorted out". A catch-all stop from you would sit next to that synthetic one as a
  second junk drawer — it adds nothing and steals the reviewer's attention.
- Do not fill the stops in: no prose, no line anchors, no test digest here. Each stop is filled
  by a separate task that gets your \`intent\` as its brief.
- Do not invent stops for files that are not in the diff.

${COMMON_RESULT}`;
}

/** Методичка задачи `route.section` — заполнение конкретных стопов плана. */
export function sectionGuide(locale: Locale): string {
    const text = promptLocale(locale);
    return `# Task: fill in stops of the review route

${commonGuide(locale)}

## What you produce

The plan of the route is already fixed and is attached to the task. You fill in **only the target
stops** named in the task; the other stops are there so that you can point at them and not
duplicate them.

For each target stop:

- \`planIndex\` — the stop number from the attached plan, as a plain JSON number: stop 3 is
  \`"planIndex": 3\`. Never a string, never zero-padded, never a number of your own. The \`file #\`
  column of the changed files list is a different numbering — do not take stop numbers from it.
- \`paragraph\` — the stop description, 2 to 4 sentences ${text.inLanguage}, in the shape **"what changed
  → what follows from it"**: what the change actually does, its motivation and the non-obvious
  decisions, and the consequences for behaviour, contracts, performance or operations. Its markup
  and its budget are below.
- \`bridge\` — optional, one sentence ${text.inLanguage}: the link to the next stop in triage order
  ${text.bridgeExample}. Plain text, no markup.
- \`anchors\` — the line ranges this stop covers.
- \`tests\` — the behavioural digest, when this stop changes tested behaviour.

## The stop description: markup and budget

The description is read in a narrow column beside the diff, so its markup is a small fixed subset.
Anything outside it is rejected by the server and the whole section comes back for a rewrite.

${MARKUP_VOCABULARY}
- Never link what the reviewer already has in front of them at this stop.
- **Budget: ${String(STOP_PARAGRAPH_MAX_CHARS)} characters of visible text for the whole description**: what the reviewer
  reads on screen. Link addresses and markup (backticks, \`**\`, list markers) are not counted.
  Over it the section is rejected. The reviewer sees the text in full: it is never cut or folded.

## Anchors

An anchor is a range of **changed lines**, not a file: a file may be split across several stops.

- \`path\` — exactly as it appears in the file list of the attached context.
- \`side\` — \`new\` for added lines, \`old\` for deleted lines. A hunk that both deletes and adds
  needs two anchors.
- \`start\` / \`end\` — inclusive line numbers on that side. **Read them off the gutter** printed in
  front of every patch line (\`old new | line\`): the left column is the old-side number, the right
  one the new-side number, \`.\` means the line does not exist on that side. Those printed numbers
  are the ones the server validates against. Never count lines yourself and never derive a number
  from the \`@@\` header: an anchor off by two lines is a dead anchor.
- \`collapsed: true\` — a display directive "fold this by default": boilerplate, lock files,
  generated code, mechanical renames. The reviewer still sees the fold and its line count.

Rules the server enforces:

- Ranges must consist of changed lines. A range that lands on untouched context is dropped, and
  the reviewer sees a note about it. Anchor the code the diff actually touches.
- One range belongs to exactly one stop. If two of your stops claim the same lines, the later one
  loses them ("range moved").
- Cover the changed lines of every file your stops are about. Whatever no stop anchors ends up in
  the synthetic last stop of the server, which is honest but useless to the reviewer.

## Why this stop changed

Tasks that carry \`interdiff.md\` are a rebuild after a push. For a stop whose lines that push
touched, add \`changeReason\`: 1 to 3 sentences ${text.inLanguage} — what the author changed and why, when
\`threads-since.md\` shows the why. The server classifies the stop itself (\`new\` or \`changed\`)
from your anchors; you never declare the kind, only the reason.

- A reason on a stop the push did not touch is dropped by the server, and the reviewer sees a note
  about it. When in doubt, write nothing: an invented motive is worse than silence.
- Cite a discussion as \`[thread:<id>]\` with an id printed in \`threads-since.md\`, or list the ids
  in \`changeThreadIds\`. The reviewer sees the threads as links next to the reason, and every token
  is removed from your text — put it at the end of a sentence so the prose survives without it.
  Ids the server does not know are dropped.
- Without \`interdiff.md\` the code has not moved since the previous route: there are no reasons
  to write at all.

## Behavioural test digest

Test code is hidden from the reviewer by default: it is machine text, there is nothing to review
there. Instead the stop states the **contract in human language** — one claim per line of
behaviour, ${text.inLanguage}, phrased the way a person would say it out loud
${text.claimExample}.

Each claim has a \`kind\`:

- \`new\` — behaviour that was not asserted before and is asserted now.
- \`changed\` — an existing assertion whose meaning changed.
- \`weakened\` — an assertion removed, loosened, skipped or turned into a weaker check.
  **This is the first-class signal of the whole digest**: in a raw test diff it is invisible, and
  it is exactly what the reviewer must see. Never leave it out to be polite.
- \`uncovered\` — the honest inversion: behaviour that this stop changes and no assertion checks.

\`new\`, \`changed\` and \`weakened\` require \`testPath\` and \`testLine\` pointing at the real
test in this diff — the file path and the line of the case itself. \`testLine\` is read off the
same gutter as anchors: the new-side number for a test that exists after the change, the old-side
number for one that was deleted. A claim without a live anchor is dropped by the server and the
reviewer is told how many were dropped.

\`uncovered\` is anchored the other way round: \`testPath\`/\`testLine\` may point at the changed
code that is left unchecked, or be omitted entirely.

Do not phrase claims as test names, and do not invent tests that are not in the diff.

${COMMON_RESULT}`;
}

/**
 * Какие файлы перегенерации приехали с задачей: инструкция перечисляет контекст по факту,
 * а не описывает то, чего в задаче нет.
 */
export interface RegenerationContextFiles {
    readonly interdiff: boolean;
    readonly previousRoute: boolean;
    readonly threadsSince: boolean;
}

const NO_REGENERATION: RegenerationContextFiles = {
    interdiff: false,
    previousRoute: false,
    threadsSince: false,
};

/**
 * Абзац про контекст перегенерации: что за файлы приехали сверх диффа и что с ними делать.
 * Пусто — маршрут строится впервые.
 */
function regenerationLines(files: RegenerationContextFiles): string[] {
    const named = [
        ...(files.interdiff ? ['`interdiff.md` — what the push changed (also under `shared/`)'] : []),
        ...(files.previousRoute ? ['`previous-route.md` — the route this pull request already had'] : []),
        ...(files.threadsSince ? ['`threads-since.md` — the discussion since that route was built'] : []),
    ];
    if (named.length === 0) {
        return [];
    }
    // Без среза пуша не было: обещать модели «автор запушил» и звать её менять затронутое нельзя.
    return files.interdiff
        ? [
              '',
              'This is a rebuild: the pull request already had a route and the author has pushed since. The',
              `task also carries ${listPhrase(named)}. Keep what the push did not touch, change what it did.`,
          ]
        : [
              '',
              'This is a rebuild on the same commit: the pull request already had a route and the code has not',
              `moved since. The task also carries ${listPhrase(named)}. A stop you keep keeps its number.`,
          ];
}

/**
 * Что из контекста лежит в общем каталоге. Срез — только у перегенерации после пуша, и называть
 * его в первой генерации нельзя: модель пойдёт искать файл, которого нет.
 */
function sharedPhrase(files: RegenerationContextFiles): string {
    return files.interdiff
        ? 'The methodology, the pull request and the interdiff live under `shared/`'
        : 'The methodology and the pull request live under `shared/`';
}

function listPhrase(items: readonly string[]): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Короткая инструкция задачи скелета: что сделать и где лежит остальное. */
export function skeletonInstructions(
    locale: Locale,
    files: RegenerationContextFiles = NO_REGENERATION,
): string {
    return [
        'Plan the review route for this pull request: a summary, the stops in triage order, and the',
        `narrative order of the full tour. Write every reviewer-facing text ${promptLocale(locale).inLanguage}.`,
        '',
        'The first context file is the methodology — read it first, it defines what a stop is, how to',
        'order the stops and how to write. The second one is the pull request itself: metadata, the',
        'complete list of changed files and their patches.',
        ...regenerationLines(files),
        '',
        `${sharedPhrase(files)}: these paths are the same in every task of this session, so read each`,
        'of them once. Files in the task directory are always new.',
        '',
        'Return one JSON document matching the attached schema and submit it with `task complete --file`.',
        'The schema is checked by the server on submit — do not validate the result yourself and do not',
        'install anything for that; always submit what you produced.',
    ].join('\n');
}

/** Короткая инструкция задачи секции: целевые номера плана — здесь, детали — в контексте. */
export function sectionInstructions(
    locale: Locale,
    planIndexes: readonly number[],
    files: RegenerationContextFiles = NO_REGENERATION,
): string {
    const targets = planIndexes.map((index) => String(index)).join(', ');
    const plural = planIndexes.length === 1 ? 'this stop' : 'these stops';
    return [
        `Fill in ${plural} of the review route: ${targets}.`,
        `Write every reviewer-facing text ${promptLocale(locale).inLanguage}.`,
        '',
        'The first context file is the methodology — read it first, it defines the prose, the anchors',
        'and the behavioural test digest. The second one is the pull request itself: metadata, the',
        'complete list of changed files and their patches. The last one carries the fixed route plan,',
        'with your target stops marked and the intent written for each of them.',
        ...regenerationLines(files),
        '',
        `${sharedPhrase(files)}: these paths are the same in every task of this`,
        'session, so read each of them once. The plan belongs to this task alone and is always new.',
        '',
        'Return one JSON document matching the attached schema and submit it with `task complete --file`.',
        'The schema is checked by the server on submit — do not validate the result yourself and do not',
        'install anything for that; always submit what you produced.',
    ].join('\n');
}
