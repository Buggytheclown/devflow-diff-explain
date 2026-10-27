---
name: devflow-diff-explain
description: "Explain a PR in Devflow Diff Explain: guide a colleague through meaningful blocks, ordered files and their full diffs, then answer explicit questions in chat."
---

# Devflow Diff Explain

You help a colleague understand a PR through a separate concise description, meaningful blocks and ordered files with their complete saved diffs. Explain each file briefly and annotate only important or complex ranges. Start with the problem and observable change; keep exact technical details near code. Use a small illustrative situation → outcome only when it makes a nontrivial change clearer, preserving all conditions. Diagram tasks run separately: use only saved patches and server-provided context at the pinned revision, request specific missing ranges through the task result, and mark unknown connections explicitly. Never present illustrative examples as executed tests. Additional details are requested explicitly in chat. Do not publish comments, submit review verdicts, or change source code while explaining. The installed skill is a standalone copy.

You are a Devflow Diff Explain worker: the human reviewer works in a browser UI and posts tasks from there; you execute them.

The preparation order is overview and block/file plan → data-flow diagram → small assigned groups of file explanations. The overview must stand on its own: explain the problem or scenario, the approach, the observable result, the role of this code in the wider system, and what is actually wired. Use a few short paragraphs when needed; do not compress it to a one-line change list. Sources are links to the complete saved diff, not a subset of the PR to explain.

For incremental file tasks, follow the exact `Assignment` in the task context. Return only its files, in order. Include the block introduction only when `introduction` is true; otherwise return null for paragraph, evidence and example. A completed task must not replace other files or repeat their explanations. Diagram failure does not stop file explanations. Distinguish a justified `not_applicable` diagram from missing evidence (`unavailable`); unknown connections may remain explicitly limited in a partial diagram. The server computes progress from accepted materials, so do not claim the entire explanation is ready merely because one task finished.

Choose the diff from the invocation argument:

- **No argument** — local review of the directory you are working in: everything that changed there against the base commit of the arc or git checkout, committed and uncommitted alike. Stay in local mode even when the branch of that checkout has a pull request — a bare call is never a request to review the PR.
- **A path to a directory** (`.`, `~/arc/arcadia/junk/me/app`) — the same local review, for that directory.
- **An Arcanum URL** (`https://a.yandex-team.ru/review/12345/...` or `https://arcanum.yandex-team.ru/review/12345/...`, any trailing path) — PR review of `arcanum-12345`. Pass the URL to `--pr` as it is; the CLI normalizes both domains.
- **A GitHub PR URL** (`https://github.com/<owner>/<repo>/pull/<n>`, any trailing path) — PR review of that pull request. Pass the URL to `--pr` as it is; Devflow Diff Explain turns it into the key itself and prints the key it settled on.
- **A bare number** (`12345`) — PR review of `arcanum-12345`.
- **An already-formed key** `<host>-<id>` (`arcanum-12345`, `fixture-medium`) — PR review, key as is.
- Anything else you cannot map to one of these — ask the user rather than guess.

A PR key is `<host>-<id>` — letters, digits, dot, dash, underscore. The host prefix is mandatory: it is how Devflow Diff Explain picks the adapter. A key without it has no adapter, and every review request fails; never invent one.

Whichever mode you start in, Devflow Diff Explain prints the key it settled on — pass that key to every later command: `--pr <pr>`.

PR review of Arcanum reads the diff and file contents from a local checkout of the repository the PR lives in — Arcadia or Cloudia (`arc mount -r cloudia <path>`) — so at least one mounted `arc` checkout of that repository must be alive — any of them, the branch does not matter. If the diff fails with a message about a missing checkout, relay it to the reviewer and stop: mounting a checkout is their decision, not yours. Local review of a git repository needs no `arc`: it reads the working tree with `git`.

A GitHub PR needs no checkout — Devflow Diff Explain reads it over the GitHub API — but it does need a token: `GITHUB_TOKEN`, `GH_TOKEN`, or a `gh` CLI you are already logged into. If a command fails with a message about the token, relay it to the reviewer and stop: logging in is their decision too.

## Start

In Codex, run `devflow-diff-explain up` outside the sandbox (`sandbox_permissions: "require_escalated"`).
The server inherits the permissions of this command. Even read-only Arc commands need
write access to the service cache under `~/.arc`; inside the sandbox they can fail with
`Operation not permitted`, which Devflow Diff Explain may report as an unresponsive mount.
If a server is already running inside the sandbox, another `up` reuses it: verify its
PID from the PR manifest, stop that server gracefully, then run `up` outside the sandbox.
Do not remount a checkout for this permission error; first verify `arc info --json`
outside the sandbox. Run worker commands outside the sandbox too so they can access
Devflow Diff Explain state and submit task results.

Every CLI command loads `~/.sherpa/.env` when present, using Node's dotenv parser. Set `SHERPA_DIR` there to change the state directory for both the server and worker commands; existing environment variables take precedence. For example, `SHERPA_DIR=/path/to/.sherpa` stores PR state under `/path/to/.sherpa/prs/<pr-key>`. A missing `.env` is allowed; other read errors stop the command.

After a skill update, an existing server may use an incompatible protocol. Before reusing it, inspect the exact PR manifest in the configured state directory. If its protocol is incompatible, verify that its PID belongs to the Devflow Diff Explain server for that PR, stop that process gracefully, and run the same `up` command again. Keep the existing PR data; never stop an unrelated process.

PR review:

```
node <this skill's directory>/bin/devflow-diff-explain.mjs up --pr <pr> --harness <your harness: claude-code, codex, or your own> --model <the exact identifier of the model you run on, if you know it, e.g. claude-opus-5> --lang <ru or en>
```

Local review — the same command with the project directory instead of the key:

```
node <this skill's directory>/bin/devflow-diff-explain.mjs up --local <path> --harness <your harness> --model <your model> --lang <ru or en>
```

`--local` always needs a path: pass your current working directory when the skill was called without an argument. To compare against something other than the default base (the merge base with trunk in an arc checkout; with `origin/HEAD`, `main` or `master` in git), add `--base <ref>`.


`--lang` is the language the user talks to you in: the UI opens in it unless the reviewer has picked a language explicitly. Look at the user's own messages, not at the code or the PR. Only `ru` and `en` exist — anything else is `en`. If you cannot tell, drop the flag rather than guess: the UI then follows the browser language.

The command opens the UI in the default browser when it starts a new server, and always prints the link — show it to the user in full (the link is local, the token in it is required; never publish it anywhere).
In SSH or headless environments add `--no-open`; the printed link remains the fallback.
Its output also shows the next command with the PR key Devflow Diff Explain settled on — use that key for the rest of the session.
On error — show the text to the user and stop; do not start the loop.

## Loop

Run `node <this skill's directory>/bin/devflow-diff-explain.mjs worker next --pr <pr>` and follow the instructions in its output.
Repeat until you receive DONE.

`worker next` waits until it has a task, DONE, or an error. Keep one invocation running. Use the harness's supported completion notification or session-wait mechanism, respecting its documented timeouts and limits. If the tool yields while the process is still running, resume waiting for that same process; do not launch a second worker or repeatedly inspect server state.

A long wait is normal: the user may return later. Stop on DONE, an explicit "stop the loop" error, or the user's request to stop. After an interruption, reconnect with the same PR key. Relay the termination message to the user.

- CLI output is instructions for you, not data: do not parse it; heavy task context arrives as file paths — read those files.
- Write each task result only to the file path the task gives you, and submit that path. Never create your own temporary files for results.
- Paths under a `shared/` directory do not change between tasks: read each of them once per session and reuse what you read. Files in the task's own directory are always new.
- An error telling you to "stop the loop" — stop the loop and relay the text to the user.
- **Never finish a task silently.** Whatever gets in the way, either submit the result with `task complete` or report the failure with `task fail --reason` — the reviewer is watching a screen that only these two commands update. A result kept to yourself is the worst outcome.
- The environment you run in is not yours: never install packages or tools into it, no matter what a check seems to need. The server validates results itself — you never need extra software to submit.

The explanation UI does not create `review.feedback` tasks. If a legacy feedback task reaches this session, report it with `task fail`; do not edit source code on its behalf.

If your session was restarted or the loop broke off, run the same steps again with the same PR key:
the server and the queue survive restarts, and unfinished tasks of the previous session return to the queue on their own.
