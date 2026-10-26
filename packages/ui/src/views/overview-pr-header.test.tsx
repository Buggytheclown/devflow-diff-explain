import { fixtureIteration } from '@sherpa/fixtures';
import type { Lens, PrChecks, PrMeta } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * Шапка PR на Обзоре (прототип `docs/design/Sherpa.dc.html`, экран Overview): номер и счётчики
 * диффа в мета-строке, автор со временем, ветками и статусом проверок.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function render(
    options: {
        pr?: PrMeta | null;
        checks?: PrChecks | null;
        withDiff?: boolean;
        extraLenses?: Lens[];
    } = {},
): string {
    const pr =
        options.pr === undefined
            ? { ...DATA.pr, ...(options.checks === undefined ? {} : { checks: options.checks }) }
            : options.pr;
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            pr={pr}
            diff={options.withDiff === false ? null : DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: options.extraLenses ?? DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={NOW}
            reviewHostAvailable
        />,
    );
}

describe('шапка PR на Обзоре', () => {
    it('мета-строка: номер PR, счётчики диффа и чип аудит-скоупа', () => {
        const html = render();

        expect(html).toContain('PR 4821');
        expect(html).toContain(`+${String(sum('additions'))}`);
        expect(html).toContain(`−${String(sum('deletions'))}`);
        expect(html).toContain(`${String(DATA.diff.files.length)} файл`);
        expect(html).toContain('PCI DSS');
    });

    it('без диффа в мета-строке остаётся только номер PR', () => {
        const html = render({ withDiff: false });

        expect(html).toContain('PR 4821');
        expect(html).not.toContain(`${String(DATA.diff.files.length)} файлов`);
        expect(html).not.toContain('PCI DSS');
    });

    it('чипа аудит-скоупа нет, когда PR его не задел или линза не работает', () => {
        const pci = DATA.extraLenses.find((lens) => lens.id === 'pci');
        if (pci === undefined) {
            throw new Error('в фикстуре medium нет линзы pci');
        }

        expect(render()).toContain('pr-header__pci-tag');
        expect(render({ extraLenses: [{ ...pci, paths: [] }] })).not.toContain('pr-header__pci-tag');
        expect(render({ extraLenses: [{ ...pci, available: false }] })).not.toContain('pr-header__pci-tag');
    });

    it('строка автора: логин, относительное время, ветки и статус проверок', () => {
        const html = render({ checks: 'passed' });

        expect(html).toContain(DATA.pr.author.login);
        expect(html).toContain('назад');
        expect(html).toContain(`${DATA.pr.toBranch} ← ${DATA.pr.fromBranch}`);
        expect(html).toContain('проверки пройдены');
        // Аватарки на Обзоре нет — она осталась в шапке Маршрута и Полного диффа.
        expect(html).not.toContain('pr-header__avatar');
    });

    it('провалившиеся и идущие проверки называются своими словами', () => {
        expect(render({ checks: 'failed' })).toContain('проверки провалены');
        expect(render({ checks: 'pending' })).toContain('проверки идут');
    });

    it('без статуса проверок сегмент не рендерится', () => {
        const html = render({ checks: null });

        expect(html).not.toContain('pr-header__checks');
        expect(html).toContain(`${DATA.pr.toBranch} ← ${DATA.pr.fromBranch}`);
    });

    it('до прихода меты шапки нет вовсе', () => {
        const html = render({ pr: null });

        expect(html).not.toContain('pr-header');
        // Остальной Обзор при этом рисуется как раньше.
        expect(html).toContain('Файлы по зонам ответственности');
    });
});

function sum(key: 'additions' | 'deletions'): number {
    return DATA.diff.files.reduce((total, file) => total + file[key], 0);
}
