import { describe, expect, it } from 'vitest';

import { describeFetchError } from './errors.js';

describe('describeFetchError', () => {
    it('раскрывает причину «fetch failed»: код и сообщение из cause', () => {
        const cause = Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
        });
        expect(describeFetchError(new TypeError('fetch failed', { cause }))).toBe(
            'fetch failed: SELF_SIGNED_CERT_IN_CHAIN self-signed certificate in certificate chain',
        );
    });

    it('без cause — само сообщение; таймаут — своя формулировка', () => {
        expect(describeFetchError(new Error('boom'))).toBe('boom');
        expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('таймаут');
        expect(describeFetchError('строка')).toBe('строка');
    });
});
