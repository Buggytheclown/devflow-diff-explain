import { VERDICTS_INSTRUCTION_MAX_CHARS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseArgs, sanitizeLabel } from './args.js';
import { CliError } from './errors.js';

describe('разбор аргументов', () => {
    it('служебные команды: версия и справка', () => {
        expect(parseArgs(['--version']).kind).toBe('version');
        expect(parseArgs(['-v']).kind).toBe('version');
        expect(parseArgs([]).kind).toBe('help');
        expect(parseArgs(['--help']).kind).toBe('help');
        // Версия важнее всего остального: её спрашивают, чтобы понять, что вообще установлено.
        expect(parseArgs(['worker', 'next', '--version']).kind).toBe('version');
    });

    it('server: всё после подкоманды уходит серверу как есть', () => {
        expect(parseArgs(['server', '--pr', 'arcanum-1', '--sherpa-dir', '/s', '--version', '-h'])).toEqual({
            kind: 'server',
            argv: ['--pr', 'arcanum-1', '--sherpa-dir', '/s', '--version', '-h'],
        });
        expect(parseArgs(['server'])).toEqual({ kind: 'server', argv: [] });
    });

    it('up: PR, харнес и модель, лишние аргументы отбиваются', () => {
        expect(parseArgs(['up', '--pr', 'arcanum-1', '--harness', 'claude-code', '--model', 'claude-opus-5'])).toEqual(
            {
                kind: 'up',
                prKey: 'arcanum-1',
                local: undefined,
                base: undefined,
                verdicts: undefined,
                harness: 'claude-code',
                model: 'claude-opus-5',
                lang: undefined,
                noOpen: false,
            },
        );
        expect(parseArgs(['up'])).toEqual({
            kind: 'up',
            prKey: undefined,
            local: undefined,
            base: undefined,
            verdicts: undefined,
            harness: undefined,
            model: undefined,
            lang: undefined,
            noOpen: false,
        });
        expect(parseArgs(['up', '--no-open'])).toMatchObject({ kind: 'up', noOpen: true });
        expect(() => parseArgs(['up', '--no-open=true'])).toThrow('does not take a value');
        expect(() => parseArgs(['up', 'server'])).toThrow('devflow-diff-explain up [--pr <pr key> | --local <path>');
    });

    it('up --local: каталог проекта вместо PR, вместе с базой', () => {
        expect(parseArgs(['up', '--local', '.', '--base', 'trunk~3'])).toMatchObject({
            kind: 'up',
            prKey: undefined,
            local: '.',
            base: 'trunk~3',
        });
        expect(parseArgs(['up', '--local=/tmp/app'])).toMatchObject({ local: '/tmp/app', base: undefined });
    });

    it('up --local --verdicts <instruction>: поручение только у локального ревью и только у up', () => {
        expect(parseArgs(['up', '--local', '.', '--verdicts', 'on ship, commit and open a PR'])).toMatchObject({
            local: '.',
            verdicts: 'on ship, commit and open a PR',
        });
        expect(parseArgs(['up', '--local', '.', '--verdicts=  on ship, merge  '])).toMatchObject({
            verdicts: 'on ship, merge',
        });
        expect(parseArgs(['up', '--local', '.'])).toMatchObject({ verdicts: undefined });
        expect(() => parseArgs(['up', '--verdicts', 'on ship, merge'])).toThrow(
            '`--verdicts` only makes sense with `--local`',
        );
        expect(() => parseArgs(['up', '--pr', 'arcanum-1', '--verdicts', 'on ship, merge'])).toThrow(
            '`--verdicts` only makes sense with `--local`',
        );
        expect(() => parseArgs(['worker', 'next', '--verdicts', 'on ship, merge'])).toThrow(
            '--local, --base and --verdicts are only available for `devflow-diff-explain up`',
        );
    });

    it('up --verdicts без поручения, с пустым или слишком длинным — отказ с подсказкой', () => {
        for (const argv of [
            ['up', '--local', '.', '--verdicts'],
            ['up', '--local', '.', '--verdicts', '--no-open'],
            ['up', '--local', '.', '--verdicts='],
            ['up', '--local', '.', '--verdicts', '   '],
        ]) {
            expect(() => parseArgs(argv)).toThrow("`--verdicts` needs the user's instruction");
        }

        const limit = VERDICTS_INSTRUCTION_MAX_CHARS;
        expect(parseArgs(['up', '--local', '.', '--verdicts', 'x'.repeat(limit)])).toMatchObject({
            verdicts: 'x'.repeat(limit),
        });
        expect(() => parseArgs(['up', '--local', '.', '--verdicts', 'x'.repeat(limit + 1)])).toThrow(
            `the \`--verdicts\` instruction is ${String(limit + 1)} characters long, the limit is ${String(limit)}`,
        );
    });

    it('up --local без пути — отказ с подсказкой, а не безымянный «нет значения»', () => {
        // Каталог угадать нельзя: подсказка называет именно его.
        expect(() => parseArgs(['up', '--local'])).toThrow('needs the path of the project directory');
        expect(() => parseArgs(['up', '--local', '--no-open'])).toThrow('needs the path of the project directory');
        expect(() => parseArgs(['up', '--local='])).toThrow('needs the path of the project directory');
    });

    it('up: --local и --pr — разные ревью, --base только с --local', () => {
        expect(() => parseArgs(['up', '--local', '.', '--pr', 'arcanum-1'])).toThrow('pass one of them');
        expect(() => parseArgs(['up', '--base', 'trunk'])).toThrow('only makes sense with `--local`');
        expect(() => parseArgs(['worker', 'next', '--local', '.'])).toThrow(
            'only available for `devflow-diff-explain up`',
        );
        expect(() => parseArgs(['worker', 'next', '--base', 'trunk'])).toThrow(
            'only available for `devflow-diff-explain up`',
        );
    });

    it('worker next, с PR из флага и без него', () => {
        expect(parseArgs(['worker', 'next'])).toEqual({
            kind: 'worker-next',
            prKey: undefined,
        });
        expect(parseArgs(['worker', 'next', '--pr', 'arcanum-1'])).toEqual({
            kind: 'worker-next',
            prKey: 'arcanum-1',
        });
        expect(parseArgs(['--pr=arcanum-1', 'worker', 'next'])).toEqual({
            kind: 'worker-next',
            prKey: 'arcanum-1',
        });
    });

    it('worker register, харнес и модель необязательны', () => {
        expect(parseArgs(['worker', 'register'])).toEqual({
            kind: 'worker-register',
            prKey: undefined,
            harness: undefined,
            model: undefined,
            lang: undefined,
        });
        expect(
            parseArgs(['worker', 'register', '--harness', 'claude-code', '--model', 'gpt-5', '--pr', 'arcanum-1']),
        ).toEqual({
            kind: 'worker-register',
            prKey: 'arcanum-1',
            harness: 'claude-code',
            model: 'gpt-5',
            lang: undefined,
        });
    });

    // Список языков закрыт контрактом: UI выбирает по метке словарь, третьего словаря нет.
    it('--lang: только ru и en, у up и register, иначе — ошибка аргумента', () => {
        expect(parseArgs(['up', '--lang', 'ru'])).toMatchObject({ kind: 'up', lang: 'ru' });
        expect(parseArgs(['up', '--lang=EN'])).toMatchObject({ lang: 'en' });
        expect(parseArgs(['worker', 'register', '--lang', 'en'])).toMatchObject({
            kind: 'worker-register',
            lang: 'en',
        });
        // Обрамление чистится так же, как у меток харнеса и модели.
        expect(parseArgs(['worker', 'register', '--lang', '`ru`'])).toMatchObject({ lang: 'ru' });

        expect(() => parseArgs(['up', '--lang', 'de'])).toThrow(CliError);
        expect(() => parseArgs(['up', '--lang', 'de'])).toThrow('--lang expects `ru` or `en`, got `de`');
        expect(() => parseArgs(['worker', 'register', '--lang=ru-RU'])).toThrow('--lang expects');
    });

    // Значения называет сама модель: она приносит их в бэктиках, в кавычках и с пробелами.
    it('харнес и модель чистятся от обрамления, пустые — как отсутствие параметра', () => {
        expect(sanitizeLabel('`claude-opus-5[1m]`')).toBe('claude-opus-5[1m]');
        expect(sanitizeLabel('"claude-sonnet-5"')).toBe('claude-sonnet-5');
        expect(sanitizeLabel("  'gpt-5'  ")).toBe('gpt-5');
        expect(sanitizeLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
        expect(sanitizeLabel('')).toBeUndefined();
        expect(sanitizeLabel('   ')).toBeUndefined();
        expect(sanitizeLabel('```')).toBeUndefined();
        expect(sanitizeLabel(undefined)).toBeUndefined();
        // Контракт ограничивает метку 64 символами — лишнее режется, а не отбивается ошибкой.
        expect(sanitizeLabel('м'.repeat(100))).toHaveLength(64);
    });

    it('вычищенная до пустоты модель не доезжает до запроса', () => {
        expect(parseArgs(['up', '--model', '``'])).toMatchObject({ model: undefined });
        expect(parseArgs(['up', '--model=`claude-opus-5[1m]`'])).toMatchObject({ model: 'claude-opus-5[1m]' });
    });

    it('три команды задачи со своими обязательными флагами', () => {
        expect(parseArgs(['task', 'complete', '42', '--file', 'ответ.md'])).toEqual({
            kind: 'task-complete',
            prKey: undefined,
            taskId: 42,
            file: 'ответ.md',
        });
        expect(parseArgs(['task', 'progress', '42', '--text', 'читаю дифф'])).toEqual({
            kind: 'task-progress',
            prKey: undefined,
            taskId: 42,
            text: 'читаю дифф',
        });
        expect(parseArgs(['task', 'fail', '42', '--reason', 'нет доступа'])).toEqual({
            kind: 'task-fail',
            prKey: undefined,
            taskId: 42,
            reason: 'нет доступа',
        });
    });

    it('номер задачи принимается и в том виде, в каком он показан модели', () => {
        expect(parseArgs(['task', 'fail', 'sherpa/7', '--reason', 'x'])).toMatchObject({ taskId: 7 });
    });

    it('кривые вызовы объясняют, как звать правильно', () => {
        const cases: { argv: string[]; contains: string }[] = [
            { argv: ['worker'], contains: 'worker next' },
            { argv: ['worker', 'nxt'], contains: 'worker next' },
            { argv: ['task'], contains: 'complete' },
            { argv: ['task', 'done', '1'], contains: 'complete' },
            { argv: ['task', 'complete'], contains: 'no task number' },
            { argv: ['task', 'complete', 'abc', '--file', 'x'], contains: 'must be a positive number' },
            { argv: ['task', 'complete', '0', '--file', 'x'], contains: 'must be a positive number' },
            { argv: ['task', 'complete', '1'], contains: '--file' },
            { argv: ['task', 'progress', '1'], contains: '--text' },
            { argv: ['task', 'fail', '1'], contains: '--reason' },
            { argv: ['task', 'fail', '1', '--reason'], contains: 'has no value' },
            { argv: ['task', 'complete', '1', '2', '--file', 'x'], contains: 'unexpected arguments' },
            { argv: ['worker', 'next', '--force'], contains: 'unknown flag' },
            { argv: ['ревью'], contains: 'unknown command' },
        ];

        for (const { argv, contains } of cases) {
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(CliError);
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(contains);
        }
    });
});
