import { expect, it, vi } from 'vitest';
import { useSystemCertificateAuthorities } from './system-ca.js';

it('добавляет доверенные системные корни, сохраняя default/extra и убирая повторы', () => {
    const get = vi.fn((kind?: 'default' | 'system' | 'bundled' | 'extra') => kind === 'default' ? ['public', 'extra', 'common'] : ['corporate', 'common']);
    const set = vi.fn();
    useSystemCertificateAuthorities({ getCACertificates: get, setDefaultCACertificates: set });
    expect(get.mock.calls).toEqual([['default'], ['system']]);
    expect(set).toHaveBeenCalledWith(['public', 'extra', 'common', 'corporate']);
});
it('сохраняет обычное поведение Node без API системных сертификатов', () => {
    expect(() => { useSystemCertificateAuthorities({}); }).not.toThrow();
});
