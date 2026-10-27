import type { CodeLocation } from '@sherpa/protocol';

interface GuideAddress { kind: 'guide'; snapshotId: string; page: string }
interface DiffAddress { kind: 'diff'; diffId: string; fileId: string }
export interface ReaderNavigation {
    address: GuideAddress | DiffAddress | null;
    guide: GuideAddress | null;
    returnTo: GuideAddress | null;
    resume: GuideAddress | null;
    location: (CodeLocation & { diffId: string }) | null;
    epoch: number;
}
export const initialNavigation: ReaderNavigation = { address: null, guide: null, returnTo: null, resume: null, location: null, epoch: 0 };
export type ReaderVisit =
    | { kind: 'guide'; address: GuideAddress; epoch: number; location: ReaderNavigation['location']; remember: boolean }
    | { kind: 'diff'; address: DiffAddress; epoch: number; location: ReaderNavigation['location'] }
    | { kind: 'return'; epoch: number };

/** Адрес и переход к строкам меняются вместе, после проверки актуальности загрузки. */
export function visitReader(state: ReaderNavigation, visit: ReaderVisit): ReaderNavigation {
    if (visit.kind === 'return') return { ...state, address: state.guide, location: null, epoch: visit.epoch };
    if (visit.kind === 'diff') return { ...state, address: visit.address, location: visit.location, epoch: visit.epoch };
    const sameSnapshot = state.guide?.snapshotId === visit.address.snapshotId;
    return {
        address: visit.address, guide: visit.address,
        returnTo: visit.remember ? sameSnapshot ? state.guide : { ...visit.address, page: 'intro' } : null,
        resume: visit.address.page !== 'intro' ? visit.address : sameSnapshot ? state.resume : null,
        location: visit.location, epoch: visit.epoch,
    };
}
