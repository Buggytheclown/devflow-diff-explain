import { expect, it } from 'vitest';
import { initialNavigation, visitReader } from './navigation.js';

it('переход к источнику помнит место возврата, переход в diff его не подменяет', () => {
    const intro = visitReader(initialNavigation, { kind: 'guide', address: { kind: 'guide', snapshotId: 'one', page: 'intro' }, remember: false, epoch: 1, location: null });
    const file = visitReader(intro, { kind: 'guide', address: { kind: 'guide', snapshotId: 'one', page: 'file:2' }, remember: true, epoch: 2, location: { path: 'a.ts', side: 'new', start: 3, end: 4, diffId: 'diff' } });
    const diff = visitReader(file, { kind: 'diff', address: { kind: 'diff', diffId: 'diff', fileId: 'other' }, epoch: 3, location: null });
    const back = visitReader(diff, { kind: 'return', epoch: 4 });
    expect(back.address).toEqual(file.address); expect(back.returnTo?.page).toBe('intro');
    const fresh = visitReader(back, { kind: 'guide', address: { kind: 'guide', snapshotId: 'two', page: 'intro' }, remember: false, epoch: 5, location: null });
    expect(fresh.resume).toBeNull(); expect(fresh.returnTo).toBeNull(); expect(fresh.location).toBeNull();
});

it('прокрутка из начального обзора отмечает файл без перехода по навигации', () => {
    const next = visitReader(initialNavigation, { kind: 'scroll', snapshotId: 'one', page: 'file:2' });
    expect(next.address).toEqual({ kind: 'guide', snapshotId: 'one', page: 'file:2' });
    expect(next.resume).toEqual(next.address);
    expect(next.returnTo).toBeNull();
    expect(visitReader(next, { kind: 'scroll', snapshotId: 'one', page: 'file:2' })).toBe(next);
});
