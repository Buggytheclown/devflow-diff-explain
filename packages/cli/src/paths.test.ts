import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { taskResultDirFor, taskResultFileFor, taskResultRootFor } from './paths.js';

describe('файл результата задачи', () => {
    it('корень под tmp разведён по пользователям', () => {
        const uid = process.getuid?.();
        expect(taskResultRootFor('/tmp')).toBe(uid === undefined ? '/tmp/sherpa' : `/tmp/sherpa-${String(uid)}`);
    });

    it('каталог — свой у каждой сессии и каждого корня стейта', () => {
        const dir = taskResultDirFor('/tmp', '/home/u/.sherpa', 'arcanum-1', 'worker-a');

        expect(path.dirname(dir)).toBe(path.join(taskResultRootFor('/tmp'), 'arcanum-1'));
        expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
        expect(taskResultDirFor('/tmp', '/home/u/.sherpa', 'arcanum-1', 'worker-a')).toBe(dir);
        expect(taskResultDirFor('/tmp', '/home/u/.sherpa', 'arcanum-1', 'worker-b')).not.toBe(dir);
        expect(taskResultDirFor('/tmp', '/home/u/dev-sherpa', 'arcanum-1', 'worker-a')).not.toBe(dir);
    });

    it('отладочный workerId с разделителями путей из каталога сессии не выводит', () => {
        const dir = taskResultDirFor('/tmp', '/s', 'arcanum-1', '../../etc');
        expect(path.dirname(dir)).toBe(path.join(taskResultRootFor('/tmp'), 'arcanum-1'));
    });

    it('имя — номер и попытка, расширение — по наличию схемы', () => {
        expect(taskResultFileFor('/d', { id: 7, attempt: 2 })).toBe('/d/7-2.md');
        expect(taskResultFileFor('/d', { id: 7, attempt: 1, resultSchemaFile: '/tmp/schema.json' })).toBe('/d/7-1.json');
    });

    it('кривой ключ PR в путь не попадает', () => {
        expect(() => taskResultDirFor('/tmp', '/s', '../etc', 'w')).toThrow(CliError);
    });
});
