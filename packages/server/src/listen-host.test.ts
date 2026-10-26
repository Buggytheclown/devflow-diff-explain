import { describe, expect, it } from 'vitest';

import { DEFAULT_LISTEN_HOST, readListenHost, uiHostForListenHost } from './listen-host.js';

describe('адрес сервера', () => {
    it('пустое и пробельное значение адреса оставляют IPv4 loopback', () => {
        for (const raw of [undefined, '', '   ']) {
            expect(readListenHost({ SHERPA_LISTEN_HOST: raw })).toBe(DEFAULT_LISTEN_HOST);
        }
    });

    it('сохраняет явный адрес и для внешнего слушателя выбирает имя машины в ссылке', () => {
        expect(readListenHost({ SHERPA_LISTEN_HOST: ' :: ' })).toBe('::');
        expect(uiHostForListenHost('::', 'sherpa-vm.example')).toBe('sherpa-vm.example');
        expect(uiHostForListenHost('127.0.0.1', 'sherpa-vm.example')).toBe('127.0.0.1');
        expect(uiHostForListenHost('::1', 'sherpa-vm.example')).toBe('::1');
    });
});
