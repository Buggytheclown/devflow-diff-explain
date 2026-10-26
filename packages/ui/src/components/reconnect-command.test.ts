import { describe, expect, it } from 'vitest';

import { reconnectCommand } from './reconnect-command.js';

describe('команда подключения воркера', () => {
    it('строится только из prKey', () => {
        expect(reconnectCommand('arcanum-15138703')).toBe('/sherpa arcanum-15138703');
        expect(reconnectCommand('fixture-medium')).toBe('/sherpa fixture-medium');
    });
});
