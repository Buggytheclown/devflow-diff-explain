import { formatCount, formatDecimal, plural } from './format.js';
import type { Dictionary } from './ru.js';
import type { preparationRu, overviewRu } from './ru.js';

export const overviewEn: Record<keyof typeof overviewRu, string> = { sourcesHint: 'These sources support the overview. Find every changed file in the route and “All changes”.', diagramLimited: 'Part of the flow is unconfirmed by the available code. See the diagram sources for limitations.', legacyDetails: 'Overall readiness was not measured for this format. Saved materials are readable; updates start manually.', revision: 'Code revision' };

export const preparationEn: Record<keyof typeof preparationRu, string> = { title: 'Explanation preparation', planning: 'Reading changes, preparing the overview and block order', preparing: 'Preparing explanations', ready: 'Explanation ready', partial: 'Explanation partially ready', failed: 'Preparation failed', cancelled: 'Preparation stopped', idle: 'No explanation yet', legacy: 'Saved explanation · overall progress unavailable', previous: 'Previous explanation', latest: 'Open new explanation', offline: 'Agent disconnected. Ready materials remain available; preparation resumes on connection.', blocks: 'Blocks', files: 'Files', diagram: 'Diagram', description: 'Overview', pending: 'pending', unavailable: 'unavailable', not_applicable: 'not needed', done: 'ready', cancel: 'Stop', stage: 'Overview and diagram first, then file explanations', missing: 'Remaining', units: 'parts', overviewTitle: 'PR overview', overviewPending: 'Preparing the problem and solution overview', diagramTitle: 'Data flow', diagramPending: 'The diagram follows the overview, before file explanations', routeTitle: 'Route through changes', routePending: 'Organizing blocks and files for understanding', diagramNotNeeded: 'Diagram not needed: ', retryDiagram: 'Retry diagram', connectToRetry: 'Connect the agent to retry the diagram.', overviewSources: 'Overview sources', fileCount: 'files' };

/**
 * Английский словарь. Подписи элементов взяты из `docs/design/SPEC-elements.md` там, где он их
 * называет: спека — английский оригинал продукта, а не перевод с русского.
 */

const num = (value: number): string => formatCount(value, 'en');
/** Дробное число: килобайты и мегабайты размера картинки. */
const dec = (value: number): string => formatDecimal(value, 'en');
/** Английские словоформы: `one` и всё остальное. */
const form = (value: number, one: string, other: string): string => plural(value, { one, other }, 'en');

export const en: Dictionary = {
    'app.name': 'Devflow Diff Explain',
    'app.noToken.text': 'Open the UI with the link printed by the Devflow Diff Explain skill or server — it carries the token.',
    'app.noToken.hint': 'http://127.0.0.1:<port>/#t=<token>',
    'app.closeChat': 'Close chat',

    'command.hint': 'Run it in any harness — that session becomes the worker.',
    'command.copy': 'Copy',
    'command.copied': 'Copied',
    'command.copied.status': 'Command copied',
    'command.manual': 'The command is selected — copy it manually',
    'command.aria': 'Sherpa launch command',

    'chat.aria': 'Chat with the agent',
    'chat.notes': (notes: number) => `Notes ${num(notes)}`,
    'chat.history.loading': 'Loading the chat history…',
    'chat.history.failed': (error: string) => `Could not load the chat history: ${error}. Retrying…`,
    'chat.disconnected': 'Agent disconnected. New questions are unavailable.',
    'chat.anchor.remove': 'Remove the range from the context',
    'chat.composer.aria': 'Question to the agent',
    'chat.composer.placeholder': 'Ask the agent',
    'chat.composer.hint.send': 'Enter — send',
    'chat.composer.hint.newline': 'Shift+Enter — new line',
    'chat.composer.send': 'Send',
    'chat.queue.route': 'Generating the route · your question is next',
    'chat.queue.busy': 'Agent busy · your question is next',
    'chat.queue.feedback': 'Addressing review comments · your question is next',
    'chat.note.pinned': (anchor: string) => `◆ Pinned by a note at ${anchor}`,
    'chat.note.lostAnchor': (anchor: string) => `anchor lost after the push · ${anchor}`,
    'chat.answering': 'Answering',
    'chat.answering.long': 'Still working',
    'chat.stop': 'Stop',
    'chat.retry': 'Retry',
    'chat.answer.missing': 'No answer came back.',
    'chat.answer.cancelled': 'Question cancelled.',
    'chat.cancelledLease': 'The agent is still busy with the cancelled task — it learns about the cancel on its next call',
    'chat.empty': 'Ask about the PR or select lines and ask about them',
    'chat.worker.never': 'not connected',

    'chat.ask.placeRanges':
        'Place the ranges the model left unplaced into the route stops. For each one — which stop it belongs to and why, or that it is a separate topic.',
    'chat.ask.placeRanges.listed': (list: string) =>
        `Place the ranges the model left unplaced into the route stops: ${list}. For each one — which stop it belongs to and why, or that it is a separate topic.`,
    'chat.ask.rangesRest': (listed: string, rest: number) => `${listed} and ${num(rest)} more`,
    'chat.ask.placeRange.line': (numbers: string, path: string) =>
        `Which route stop does line ${numbers} in ${path} belong to? The model did not place it.`,
    'chat.ask.placeRange.lineRemoved': (numbers: string, path: string) =>
        `Which route stop does removed line ${numbers} in ${path} belong to? The model did not place it.`,
    'chat.ask.placeRange.lines': (numbers: string, path: string) =>
        `Which route stop do lines ${numbers} in ${path} belong to? The model did not place them.`,
    'chat.ask.placeRange.linesRemoved': (numbers: string, path: string) =>
        `Which route stop do removed lines ${numbers} in ${path} belong to? The model did not place them.`,
    'chat.ask.rangeRemoved': (numbers: string) => `${numbers} (removed)`,
    'chat.example.risky': 'What are the riskiest changes here?',
    'chat.example.manual': 'What should I check by hand before shipping?',
    'chat.example.edgeCases': 'Are there edge cases missed in this diff?',
    'chat.ask.selectionDisabled': 'Reconnect the agent to ask about a selection',
    'chat.ask.rangesDisabled': 'Reconnect the agent to ask about these lines',
    'chat.ask.answerInChat': 'the answer lands in the chat, the route does not change',
    'thread.note.lostDraft': 'anchor lost — there is nothing to attach the comment to',
    'thread.note.lostAnchor': 'anchor lost — the note has no code in this iteration',
    'diff.worker.closed': 'the diff worker is closed',
    'diff.worker.crashed': 'the diff worker crashed',
    'diff.worker.cloneFailed': 'the diff worker reply failed structured clone',
    'diff.elsewhere': (changed: number) =>
        `${num(changed)} changed ${form(changed, 'line', 'lines')} — in other stops`,
    'diff.oneSided': (kind: string) => `shown full width — this file is only ${kind}`,
    'diff.oneSided.additions': 'additions',
    'diff.oneSided.deletions': 'deletions',
    'diff.gap.toEndOfFile': 'unchanged to the end of the file',
    'diff.gap.unchanged': (hidden: number) =>
        `${num(hidden)} unchanged ${form(hidden, 'line', 'lines')}`,
    'diff.gap.both': (unchanged: string, elsewhere: string) => `${unchanged} and ${elsewhere}`,
    'diff.gap.expandFailed': 'could not load · retry',
    'diff.gap.loading': 'loading…',
    'diff.gap.expandUp': (step: number, base: string) => `+${num(step)} ${form(step, 'line', 'lines')} up · ${base}`,
    'diff.gap.expandDown': (step: number, base: string) => `+${num(step)} ${form(step, 'line', 'lines')} down · ${base}`,
    'diff.gap.aria': 'direction to expand the hidden context',
    'diff.gap.hiddenToEnd': 'lines hidden to the end of the file',
    'diff.gap.hiddenCount': (hidden: number) => `${num(hidden)} ${form(hidden, 'line', 'lines')} hidden`,
    'diff.gap.loadAll': (amount: number, hidden: string) => `load ${num(amount)} ${form(amount, 'line', 'lines')}, ${hidden}`,
    'diff.gap.loadUp': (amount: number, hidden: string) => `load ${num(amount)} ${form(amount, 'line', 'lines')} up, ${hidden}`,
    'diff.gap.loadDown': (amount: number, hidden: string) => `load ${num(amount)} ${form(amount, 'line', 'lines')} down, ${hidden}`,
    'diff.row.tabs': 'tabs are shown as four spaces',
    'diff.row.noNewline': ' ⏎ no newline at the end of the file',

    'image.mode.aria': 'How to show the image',
    'image.mode.twoUp': '2-up',
    'image.mode.swipe': 'Swipe',
    'image.mode.onion': 'Onion Skin',
    'image.mode.diff': 'Diff',
    'image.mode.text': 'Text',
    'image.mode.needBothSides': 'both sides are needed',
    'image.mode.noSize': 'the image has no intrinsic size',
    'image.fit.toActual': '1:1',
    'image.fit.toFit': 'Fit',
    'image.fit.toActualTitle': 'show at 1:1 scale',
    'image.fit.toFitTitle': 'fit into the column width',
    'image.side.before': 'Before',
    'image.side.after': 'After',
    'image.side.empty': 'none',
    'image.download': 'Download',
    'image.dimensions': (width: number, height: number) => `${num(width)} × ${num(height)}`,
    'image.size.bytes': (value: number) => `${num(value)} B`,
    'image.size.kilobytes': (value: number) => `${dec(value)} KB`,
    'image.size.megabytes': (value: number) => `${dec(value)} MB`,
    'image.loading': 'loading…',
    'image.missing': 'the image is unavailable',
    'image.failed': (reason: string) => `failed to load: ${reason}`,
    'image.retry': 'Retry',
    'image.tooLarge': (size: string) => `too large: ${size}`,
    'image.openAtHost': 'Open in Arcanum',
    'image.alt.before': (path: string) => `${path} — before`,
    'image.alt.after': (path: string) => `${path} — after`,
    'image.swipe.aria': 'Comparison divider',
    'image.onion.label': 'Opacity',
    'image.onion.value': (percent: number) => `${num(percent)} %`,
    'image.diff.alt': (path: string) => `${path} — pixel diff`,
    'image.diff.busy': 'computing the difference…',
    'image.diff.noCanvas': 'the browser gave no canvas to rasterize into',
    'image.diff.failed': (reason: string) => `could not compute the difference: ${reason}`,
    'image.diff.summary': (percent: number, changed: number, total: number) =>
        `${dec(percent)} % of pixels changed (${num(changed)} of ${num(total)})`,
    'image.diff.sizeMismatch': (
        beforeWidth: number,
        beforeHeight: number,
        afterWidth: number,
        afterHeight: number,
    ) =>
        `sizes differ: ${num(beforeWidth)} × ${num(beforeHeight)} → ${num(afterWidth)} × ${num(afterHeight)}`,

    'error.serverDown': 'The Devflow Diff Explain server is not responding. Check that it is still running and retry.',
    'error.contract': 'The server response failed contract validation — update Sherpa.',
    'error.unknown': 'The server returned an error with no readable description. Check its terminal output.',
    'error.invalidState':
        'The server sent a state this UI does not understand. Update Sherpa — the skill, the server and the UI ship together.',

    'time.justNow': 'just now',
};

export const storyEn = {
        showChange: 'Show change', hideChange: 'Hide change', fragments: 'Code fragments', hideFragments: 'Hide fragments',
        before: 'Before', after: 'After', retrySource: 'Retry loading', loadingSource: 'Loading source…', binary: 'Binary file',
        returnTo: 'Back to explanation', newDiff: 'Open new diff', legacy: 'This explanation has no claim-to-source links. You can update it manually.',
        changeTypes: { add: 'Added', modify: 'Modified', delete: 'Deleted', move: 'Renamed', copy: 'Copied', conflict: 'Conflict' },
        files: 'Files', closeFiles: 'Close files', clearSelection: 'Clear selection', introduction: 'Introduction', unavailable: 'These lines are unavailable in this file version.',
        story: 'Explanation', diff: 'Diff', chat: 'Ask in chat', contents: 'Contents',
        loading: 'Loading PR…', planning: 'Preparing a short explanation…', writing: 'Writing the explanation. The introduction is ready to read.',
        empty: 'No explanation yet.', generate: 'Explain this PR', retry: 'Try again',
        stale: 'The PR has changed. This explanation refers to the previous version.',
        refresh: 'Update explanation', open: 'Open in diff', askSection: 'Ask about this',
        askLines: 'Ask about these lines', fileSearch: 'Find a file', noPatch: 'No textual patch.',
        noFiles: 'This PR has no changed files.', noMatch: 'No matching files.',
        offline: 'Agent disconnected. The saved explanation and diff are available to read.',
        pinned: 'Question about the shown version', refreshContext: 'Refresh context', clear: 'Whole explanation', reconnect: 'Run the sherpa skill for this PR.',
        theme: 'Theme', language: 'Language', expand: 'Expand file context', cancel: 'Stop',
        incomplete: 'Part of the diff exceeded the agent context budget. The explanation may be incomplete.',
        unknown: 'Could not load data.', selected: 'Selected lines',
} as const;
export const guidedEn = { blocks: 'Walkthrough', allChanges: 'All changes', arcanum: 'Arcanum style', route: 'Reading route', readingOrder: 'Files in reading order', openFile: 'Open full diff', nextStep: 'Next step', description: 'PR description', start: 'Start walkthrough', next: 'Next', previous: 'Previous', file: 'Complete file diff', pending: 'Explanation is being prepared. The complete diff is available.', failed: 'Explanation is unavailable. The complete diff is available.', related: 'Related files', ask: 'Ask about this', block: 'Back to block', retry: 'Retry explanation', older: 'Older explanation format. Refresh for a file walkthrough.' };

export const flowEn = { continued: 'Continued', title: 'How the flow works', pending: 'Preparing the flow diagram… The explanation is ready to read.', sources: 'Diagram sources', exampleSources: 'Example sources', example: 'For example', illustrative: 'Illustration, not an execution result', data: 'data', control: 'control', existing: 'Unchanged', added: 'Added', modified: 'Modified', unknown: 'Unconfirmed' };
