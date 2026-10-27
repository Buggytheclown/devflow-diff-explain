import type { Task } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { formatCompleteResponse, formatDone, formatOversizedResult, formatRpcError, formatTask, formatUiUrl, formatUpReady } from './format.js';

const task: Task = {
    id: 42,
    type: 'echo',
    priority: 'interactive',
    attempt: 1,
    instructions: 'Return the contents of the file as is.',
    contextFiles: ['/tmp/sherpa/task-42-context.md'],
};

const RESULT_FILE = '/tmp/sherpa/arcanum-1/42-1.md';

describe('ссылка UI', () => {
    it('использует короткое имя параметра фрагмента и loopback по умолчанию', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12')).toBe('http://127.0.0.1:4317/#t=Ab_cd-12');
    });

    it('экранирует IPv6-адрес в URL', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12', '::1')).toBe('http://[::1]:4317/#t=Ab_cd-12');
    });
});

describe('итог up на локальном ревью', () => {
    const uiUrl = 'http://127.0.0.1:4317/#t=token';

    it('база по умолчанию называется словами своей VCS', () => {
        const arc = formatUpReady(uiUrl, 'local-arc-app-0badc0de', {
            vcs: 'arc',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,

        });
        const git = formatUpReady(uiUrl, 'local-git-app-0badc0de', {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,

        });

        expect(arc).toContain('on branch feature, base merge-base with trunk.');
        expect(git).toContain('on branch feature, base merge-base with the default branch.');
    });

    it('явная база печатается как есть', () => {
        const ready = formatUpReady(uiUrl, 'local-git-app-0badc0de', {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: 'origin/main~2',

        });

        expect(ready).toContain('base origin/main~2.');
        expect(ready).not.toContain('Ship');
    });
});

describe('промпт-формат задачи', () => {
    it('содержит заголовок, инструкцию, контекст и команды сдачи', () => {
        const output = formatTask(task, RESULT_FILE, 'arcanum-1');

        expect(output.startsWith('TASK sherpa/42 (echo), attempt 1')).toBe(true);
        expect(output).toContain('Return the contents of the file as is.');
        expect(output).toContain('Context: /tmp/sherpa/task-42-context.md');
        expect(output).toContain(`Write the result to ${RESULT_FILE} and submit it:`);
        expect(output).toContain(`  devflow-diff-explain task complete 42 --file ${RESULT_FILE}`);
        expect(output).not.toContain('<path>');
        expect(output.match(/--pr arcanum-1/g)).toHaveLength(3);
        expect(output).toContain('devflow-diff-explain task progress 42 --text');
        expect(output).toContain('devflow-diff-explain task fail 42 --reason');
    });

    it('без контекстных файлов пишет «none», схему результата — только когда она есть', () => {
        expect(formatTask({ ...task, contextFiles: [] }, RESULT_FILE, 'arcanum-1')).toContain('Context: none');
        expect(formatTask(task, RESULT_FILE, 'arcanum-1')).not.toContain('Result schema');
        expect(formatTask({ ...task, resultSchemaFile: '/tmp/schema.json' }, RESULT_FILE, 'arcanum-1')).toContain(
            'Result schema: /tmp/schema.json — the result is validated against it.',
        );
    });

    it('DONE выводится отдельным словом — по нему сессия завершается', () => {
        expect(formatDone('There is no more work.').split('\n')).toContain('DONE');
    });
});

describe('ответы на complete', () => {
    it('accepted зовёт за следующей задачей', () => {
        const output = formatCompleteResponse(
            { kind: 'accepted', message: 'The result is accepted.' },
            42,
            RESULT_FILE,
            'arcanum-1',
        );

        expect(output).toContain('The result is accepted.');
        expect(output).toContain('devflow-diff-explain worker next');
    });

    it('rejected перечисляет ошибки пунктами и просит вызвать complete снова с тем же файлом', () => {
        const output = formatCompleteResponse(
            { kind: 'rejected', errors: ['empty', 'no summary section'] },
            42,
            '/work/answer.md',
            'arcanum-1',
        );

        expect(output).toContain('1. empty');
        expect(output).toContain('2. no summary section');
        expect(output).toContain('devflow-diff-explain task complete 42 --file /work/answer.md');
    });

    it('noop печатает сообщение сервера', () => {
        const output = formatCompleteResponse(
            { kind: 'noop', message: 'Task sherpa/42 is already finished.' },
            42,
            RESULT_FILE,
            'arcanum-1',
        );

        expect(output).toContain('is already finished');
    });
});

/** Текст сервера при `worker_conflict` (worker-registry): факт без следующего шага. */
const CONFLICT_MESSAGE =
    'Another live session (w-1) is the worker of this PR — two sessions per PR are not supported, ' +
    'and the slot belongs to the session that started last. This one is not it.';

describe('ошибки', () => {
    it('печатает сообщение сервера и детали списком', () => {
        const output = formatRpcError(
            {
                code: 'bad_request',
                message: 'The request failed contract validation.',
                details: ['taskId: a number is expected'],
            },
            'worker',
        );

        expect(output).toContain('The request failed contract validation.');
        expect(output).toContain('- taskId: a number is expected');
        expect(output).not.toContain('bad_request');
    });

    it('не дублирует подсказку там, где сервер уже сказал, что делать', () => {
        const message = 'The CLI protocol version 9.9.9 is incompatible. Update the skill together with the CLI.';

        expect(formatRpcError({ code: 'version_incompatible', message }, 'worker')).toBe(`devflow-diff-explain: ${message}`);
    });

    it('конфликт воркеров в петле — терминальная инструкция остановиться', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'worker');

        expect(output).toContain(CONFLICT_MESSAGE);
        expect(output).toContain('stop the loop');
    });

    // Регистрация конфликтом больше не отбивается (сервер перехватывает слот), но роль вызова
    // остаётся: чужой сервер прежней версии всё ещё способен ответить конфликтом на register.
    it('конфликт при регистрации оставляет только текст сервера: воркером эта сессия не была', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'register');

        expect(output).toBe(`devflow-diff-explain: ${CONFLICT_MESSAGE}`);
        expect(output).not.toContain('stop the loop');
    });

    it('перебор лимита объясняется в килобайтах и оставляет задачу за воркером', () => {
        const output = formatOversizedResult(42, '/tmp/answer.md', RESULT_MAX_BYTES * 2, 'arcanum-1');

        expect(output).toContain('512 KB');
        expect(output).toContain('256 KB');
        expect(output).toContain('devflow-diff-explain task complete 42 --file /tmp/answer.md');
        expect(output).toContain('The task stays yours');
    });
});
