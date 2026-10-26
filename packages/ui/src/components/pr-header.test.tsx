import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FileFilter } from '../filters/lens-filters.js';
import { PrHeader, prHeaderCounts } from './pr-header.tsx';

const DATA = fixtureIteration('medium');
const PCI: FileFilter = {
    id: 'pci',
    label: 'Файлы PCI DSS',
    shortLabel: 'PCI',
    count: 3,
    available: true,
    note: null,
    fileIds: new Set(DATA.diff.files.slice(0, 3).map((file) => file.fileId)),
};

function render(pci: FileFilter | null, pr = DATA.pr): string {
    return renderToStaticMarkup(
        <PrHeader
            pr={pr}
            counts={prHeaderCounts(DATA.diff)}
            pci={pci}
            pciActive={false}
            onTogglePci={() => undefined}
        />,
    );
}

describe('обычная шапка PR', () => {
    it('чип PCI скрыт при нуле или недоступности линзы', () => {
        expect(render(PCI)).toContain('pr-header__pci');
        expect(render({ ...PCI, count: 0, fileIds: new Set() })).not.toContain('pr-header__pci');
        expect(render({ ...PCI, available: false })).not.toContain('pr-header__pci');
        expect(render(null)).not.toContain('pr-header__pci');
    });

    it('аватар автора без фото: однословный логин — две буквы', () => {
        const author = { login: 'nolan', displayName: null, bot: false, avatarUrl: null };

        expect(render(null, { ...DATA.pr, author })).toContain(
            '<span class="avatar pr-header__avatar" aria-hidden="true">NO</span>',
        );
    });
});
