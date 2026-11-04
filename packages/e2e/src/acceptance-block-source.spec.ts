import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { architectureStoryFixture } from '@sherpa/fixtures';

import { startServer } from '../../server/src/server.js';
import { directoryAssets } from '../../server/src/static.js';
import { test, expect, openBlocks } from './sherpa-fixture.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
const uiDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');

test('источник, опубликованный только в блоке, читается из сохранённой БД после удаления экспорта', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-source-e2e-'));
    let server: SherpaServerHandle | null = null;
    try {
        server = await launchSherpa('fixture-medium', { sherpaDir });
        await page.goto(server.url);
        expect((await server.worker.register('codex', 'ru')).code).toBe(0);

        const block = fixture.outline.stops[0];
        if (block === undefined) throw new Error('Missing block');
        const source = { kind: 'lines', path: 'context/caller.ts', side: 'new', start: 2, end: 2 };
        const outline = { ...fixture.outline, stops: [{ ...block, evidence: { claims: [{ quote: block.paragraph, sources: [source], limitation: null }] } }, ...fixture.outline.stops.slice(1)] };
        const overview = await server.worker.next();
        expect((await server.worker.complete(overview.taskId ?? 0, JSON.stringify(outline))).stdout).not.toContain('rejected');
        const files = await server.worker.next();
        expect((await server.worker.complete(files.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
        await openBlocks(page);
        await expect(page.locator('.story-continuous-block').first().locator('.story-evidence-toggle')).toBeVisible();

        await server.stop();
        await rm(path.join(server.sherpaDir, 'dev-export'), { recursive: true, force: true });
        await rm(path.join(server.sherpaDir, 'prs', server.prKey, 'payload'), { recursive: true, force: true });
        const offline = await startServer({ prKey: server.prKey, sherpaDir: server.sherpaDir, assets: directoryAssets(uiDist), idleSeconds: 0 });
        try {
            const writes: string[] = [];
            page.on('request', (request) => { if (request.method() === 'POST') writes.push(request.url()); });
            await page.goto(`http://127.0.0.1:${String(offline.port)}/#t=${offline.token}`);
            await openBlocks(page);
            const disclosure = page.locator('.story-continuous-block').first().locator('.story-evidence-toggle');
            await disclosure.click();
            await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
            const saved = page.locator('.story-continuous-block').first().locator('.story-source');
            await expect(saved).toContainText('context/caller.ts');
            await expect(saved).toContainText('return validate();');
            expect(writes).toEqual([]);
        } finally {
            await offline.close();
        }
    } finally {
        await server?.stop();
        await rm(sherpaDir, { recursive: true, force: true });
    }
});
