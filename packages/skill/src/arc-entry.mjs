import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL, fileURLToPath } from 'node:url';

import { exportArcSnapshot } from '../../../scripts/arc-export.mjs';

const HASH = /^[a-f0-9]{40}$/u;
const DIFF_SET = /^[1-9]\d*$/u;
const ENTRY_NAME = 'devflow-diff-explain-arc.mjs';

/** Внешний нативный producer: core-приложение не обращается к PR-провайдеру. */
export async function runArcEntry(argv, deps = {}) {
    const out = deps.out ?? ((value) => process.stdout.write(value));
    const err = deps.err ?? ((value) => process.stderr.write(value));
    const invoke = deps.invoke ?? invokeNative;
    let manifest;
    let imported = false;
    try {
        const options = parseArcEntryArgs(argv);
        if (options.help) {
            out(usage());
            return 0;
        }

        const cwd = path.resolve(options.arcDir ?? deps.cwd ?? process.cwd());
        let info;
        try { info = parseJson(runNative(invoke, 'arc', ['info', '--json'], cwd)); }
        catch (error) {
            throw new Error(`Arc checkout check failed at ${cwd}: ${error instanceof Error ? error.message : String(error)}. Use --arc-dir <narrow project directory inside the intended checkout>.`, { cause: error });
        }
        if (info?.repository !== 'arcadia') throw new Error(`Expected an Arcadia checkout at ${cwd}; got ${String(info?.repository)}.`);

        const pin = resolvePublishedPin(options.prId, options.diffSet, cwd, invoke);
        manifest = await (deps.exportSnapshot ?? exportArcSnapshot)({
            cwd,
            baseCommit: pin.baseCommit,
            headCommit: pin.headCommit,
            project: `arcanum-${options.prId}`,
            diffId: pin.diffId,
            pr: { id: options.prId, url: `https://a.yandex-team.ru/review/${options.prId}` },
        });

        const cli = deps.cliEntry ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'devflow-diff-explain.mjs');
        const args = [cli, 'up', '--snapshot', manifest,
            ...(options.harness === undefined ? [] : ['--harness', options.harness]),
            ...(options.model === undefined ? [] : ['--model', options.model]),
            ...(options.lang === undefined ? [] : ['--lang', options.lang]),
            ...(options.noOpen ? ['--no-open'] : []),
        ];
        const result = invoke(process.execPath, args, cwd);
        if (result.stdout !== '') out(result.stdout);
        if (result.stderr !== '') err(result.stderr);
        imported = result.status === 0;
        if (!imported) err(`Export retained at ${manifest} for a retry.\n`);
        return result.status;
    } catch (error) {
        err(`devflow-diff-explain: ${error instanceof Error ? error.message : String(error)}\n`);
        if (manifest !== undefined) err(`Export retained at ${manifest} for a retry.\n`);
        return 1;
    } finally {
        if (manifest !== undefined && imported) {
            try { await removeTemporaryExport(manifest); }
            catch (error) { err(`Could not remove imported export ${manifest}: ${error instanceof Error ? error.message : String(error)}\n`); }
        }
    }
}

export function parseArcEntryArgs(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            'arc-dir': { type: 'string' },
            'diff-set': { type: 'string' },
            harness: { type: 'string' },
            model: { type: 'string' },
            lang: { type: 'string' },
            'no-open': { type: 'boolean' },
        },
    });
    if (values.help) return { help: true };
    if (positionals.length !== 1) throw new Error(`Pass one PR number or URL.\n${usage()}`);
    const prId = parsePrId(positionals[0]);
    const diffSet = values['diff-set'];
    if (diffSet !== undefined && !DIFF_SET.test(diffSet)) throw new Error('--diff-set expects a positive numeric published diff-set ID.');
    if (values.lang !== undefined && values.lang !== 'ru' && values.lang !== 'en') throw new Error('--lang expects ru or en.');
    if (values['arc-dir'] === '') throw new Error('--arc-dir needs a checkout directory.');
    return {
        prId,
        arcDir: values['arc-dir'],
        diffSet,
        harness: values.harness,
        model: values.model,
        lang: values.lang,
        noOpen: values['no-open'] === true,
    };
}

function parsePrId(value) {
    if (value !== undefined && DIFF_SET.test(value)) return value;
    try {
        const url = new URL(value);
        const match = /^\/review\/([1-9]\d*)(?:\/.*)?$/u.exec(url.pathname);
        if (url.protocol === 'https:' && ['a.yandex-team.ru', 'arcanum.yandex-team.ru'].includes(url.hostname) &&
            url.username === '' && url.password === '' && url.port === '' && match !== null) return match[1];
    } catch { /* Также принимаем числовой PR ID. */ }
    throw new Error(`Expected an Arcanum PR number or https://a.yandex-team.ru/review/<number>.\n${usage()}`);
}

function resolvePublishedPin(prId, requestedDiffSet, cwd, invoke) {
    const rows = parseJson(runNative(invoke, 'ya', ['tool', 'gena-arcanum-cli', '--json', 'pr', 'diffs', prId], cwd));
    if (!Array.isArray(rows)) throw new Error('The native PR diff-set list is invalid.');
    const published = rows.filter((row) => row?.published === true && DIFF_SET.test(String(row.id)) &&
        (row.pull_request_id === undefined || String(row.pull_request_id) === prId));
    const selected = requestedDiffSet === undefined
        ? published.reduce((latest, row) => latest === null || BigInt(row.id) > BigInt(latest.id) ? row : latest, null)
        : published.find((row) => String(row.id) === requestedDiffSet);
    if (selected === null || selected === undefined) throw new Error(`PR ${prId} has no matching published diff-set.`);
    const diffId = String(selected.id);
    const detail = parseJson(runNative(invoke, 'ya', ['tool', 'gena-arcanum-cli', '--json', 'diff', 'get', diffId, '--fields', 'id,commit_ids(base,merge)'], cwd));
    const baseCommit = detail?.commit_ids?.base;
    const headCommit = detail?.commit_ids?.merge;
    if (String(detail?.id) !== diffId || !HASH.test(baseCommit) || !HASH.test(headCommit)) {
        throw new Error(`Published diff-set ${diffId} lacks a valid base/merge commit pair.`);
    }
    return { diffId, baseCommit, headCommit };
}

function runNative(invoke, file, args, cwd) {
    const result = invoke(file, args, cwd);
    if (result.status !== 0) throw new Error(`${file} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || 'no diagnostic output').trim()}`);
    return result.stdout;
}

function invokeNative(file, args, cwd) {
    const result = spawnSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr || result.error?.message || '' };
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { throw new Error('A native CLI returned invalid JSON.'); }
}

async function removeTemporaryExport(manifest) {
    const file = path.resolve(manifest);
    const root = path.dirname(file);
    const realRoot = await fs.realpath(root);
    const temp = await fs.realpath(os.tmpdir());
    if (path.basename(file) === 'manifest.json' && path.dirname(realRoot) === temp && path.basename(realRoot).startsWith('devflow-arc-export-')) {
        await fs.rm(realRoot, { recursive: true, force: true });
    }
}

function usage() {
    return `Usage: node <installed skill>/bin/${ENTRY_NAME} <PR number or Arcanum URL> --arc-dir <narrow Arc checkout directory> [--diff-set <published ID>] [--harness <name>] [--model <ID>] [--lang ru|en] [--no-open]\n`;
}

if (process.argv[1] !== undefined && path.basename(process.argv[1]) === ENTRY_NAME) {
    process.exitCode = await runArcEntry(process.argv.slice(2));
}
