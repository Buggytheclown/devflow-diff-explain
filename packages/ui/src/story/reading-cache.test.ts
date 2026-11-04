// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { readReader, setReadingCacheScope, writeCache } from './reading-cache.js';

afterEach(() => { sessionStorage.clear(); setReadingCacheScope(null, null); });

it('разделяет черновики разных закреплённых версий в одной вкладке', () => {
    const navigation = { address: null, guide: null, returnTo: null, resume: null, location: null, epoch: 0 };
    setReadingCacheScope('code-a', 'review-a');
    writeCache('reader', { snapshotId: 'review-a', draft: 'Вопрос об A', navigation });
    setReadingCacheScope('code-b', 'review-b');
    expect(readReader()).toBeUndefined();
    writeCache('reader', { snapshotId: 'review-b', draft: 'Вопрос о B', navigation });
    setReadingCacheScope('code-a', 'review-a');
    expect(readReader()?.draft).toBe('Вопрос об A');
});

it('хранит состояние чтения в памяти вкладки', () => {
    setReadingCacheScope('code-a', null);
    writeCache('reader', { snapshotId: null, draft: 'Черновик', navigation: { address: null, guide: null, returnTo: null, resume: null, location: null, epoch: 0 } });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
});
