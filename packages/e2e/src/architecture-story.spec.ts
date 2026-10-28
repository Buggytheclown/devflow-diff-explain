import fs from 'node:fs/promises';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { test, expect } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
test('два этапа: контрастная вертикальная архитектура → связанные блоки → все файлы и возврат', async ({ page, launchSherpa }) => {
    page.on('console', (message) => { if (message.type() === 'error') process.stdout.write(message.text() + '\n'); });
    const server = await launchSherpa('fixture-medium');
    await fs.writeFile(`${server.sherpaDir}/settings.json`, JSON.stringify({ theme: 'light', arcanum: false, locale: 'en' }));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(server.url);
    await expect(page.locator('[role=progressbar]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'arcanum-dark');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('.story-topbar select')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Стиль Arcanum', exact: true })).toHaveCount(0);
    await server.worker.register('codex', 'en');
    const overview = await server.worker.next(); expect(overview.type).toBe('route.skeleton');
    const styled = { ...fixture.outline, flow: { ...fixture.outline.flow, diagram: { ...fixture.diagram,
        mermaid: fixture.diagram.mermaid + '\nclassDef faint fill:#ffffff,color:#eeeeee,stroke:#ffffff\nclass request,handler,rule,saved,rejected faint\nlinkStyle default stroke:#2d2c33',
        nodes: fixture.diagram.nodes.map((node) => node.id === 'rejected' ? { ...node, change: 'added' as const } : node),
    } } };
    expect((await server.worker.complete(overview.taskId ?? 0, JSON.stringify(styled))).stdout).not.toContain('rejected');
    await expect(page.locator('[data-architecture-node]')).toHaveCount(5);
    await expect(page.locator('.story-architecture-scroll .cluster')).toHaveCount(1);
    await expect(page.locator('.story-architecture-scroll')).toContainText('Да');
    await expect(page.locator('.story-architecture-scroll')).toContainText('Нет');
    await page.locator('.story-overview-route button').nth(1).hover();
    await expect(page.locator('.is-architecture-active')).toHaveCount(3);
    const rule = page.locator('[data-architecture-node="rule"]');
    await rule.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.story-architecture-selection')).toContainText(fixture.outline.stops[0]?.title ?? '');
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.screenshot({ path: test.info().outputPath('architecture-dark.png'), fullPage: true });
    await expect(page.getByRole('button', { name: 'Вертикально', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(async () => {
        const positions = await diagramPositions();
        expect(positions.rule.y).toBeLessThan(positions.saved.y);
        expect(positions.overflow).toBeLessThanOrEqual(1);
        expect(positions.contrast).toBeGreaterThanOrEqual(4.5);
    }).toPass({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Горизонтально', exact: true }).click();
    await expect(async () => { const p = await diagramPositions(); expect(p.rule.x).toBeLessThan(p.saved.x); expect(p.graphWidth).toBeGreaterThan(p.graphHeight); expect(p.overflow).toBeLessThanOrEqual(1); }).toPass({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Вертикально', exact: true }).click();
    await expect(async () => { const p = await diagramPositions(); expect(p.rule.y).toBeLessThan(p.saved.y); }).toPass({ timeout: 10_000 });
    await expect(page.locator('.story-architecture-selection')).toContainText(fixture.outline.stops[0]?.title ?? '');
    async function diagramPositions() {
        return page.locator('.story-architecture-scroll').evaluate((root) => {
            const box = (id: string) => {
                const node = root.querySelector(`[data-architecture-node="${id}"]`);
                if (node === null) throw new Error('Missing node');
                const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            };
            const rgb = (value: string): number[] => value.startsWith('#') ? [1, 3, 5].map((n) => Number.parseInt(value.slice(n, n + 2), 16)) : (value.match(/[\d.]+/g) ?? []).map(Number);
            const base = rgb(getComputedStyle(root).getPropertyValue('--surface-panel').trim());
            const luminance = (value: number[]) => value.slice(0, 3).map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * ([.2126, .7152, .0722][i] ?? 0), 0);
            const ratios = [...root.querySelectorAll<SVGElement>('g.node')].map((node) => {
                const text = node.querySelector('text'), shape = node.querySelector('rect,polygon,circle,ellipse,path');
                if (text === null || shape === null) throw new Error('Missing node label or shape');
                const foreground = rgb(getComputedStyle(text).fill);
                const fill = rgb(getComputedStyle(shape).fill);
                const alpha = fill[3] ?? 1;
                const background = base.map((c, i) => (fill[i] ?? 0) * alpha + c * (1 - alpha));
                const a = luminance(foreground), b = luminance(background);
                return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
            });
            const svg = root.querySelector('svg'); if (svg === null) throw new Error('Missing SVG');
            return { graphWidth: svg.viewBox.baseVal.width, graphHeight: svg.viewBox.baseVal.height, rule: box('rule'), saved: box('saved'), overflow: root.scrollWidth - root.clientWidth, contrast: Math.min(...ratios) };
        });
    }
    await page.locator('.story-architecture-selection button').first().click();
    await expect(page.locator('.story-guided h2')).toHaveText(fixture.outline.stops[0]?.title ?? '');
    await expect(page.locator('.story-guided')).toContainText(fixture.outline.stops[0]?.paragraph ?? '');
    await page.locator('.story-file-list button').first().click();
    await expect(page.locator('.story-code header code')).toHaveText(fixture.first.path);
    await expect(page.locator('.story-code .diff-row')).not.toHaveCount(0);
    const rows = await page.locator('.story-code .diff-row').allTextContents();
    const files = await server.worker.next(); expect(files.type).toBe('route.section');
    const assignment = files.stdout.split('\n').find((line) => line.endsWith('-plan.md'));
    expect(await fs.readFile(assignment?.trim() ?? '', 'utf8')).toContain('Accepted architecture');
    expect((await server.worker.complete(files.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('.story-inline-note')).not.toHaveCount(0);
    expect(await page.locator('.story-code .diff-row').allTextContents()).toEqual(rows);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.story-code header code')).toHaveText(fixture.first.path);
    await page.locator('.story-topbar').getByRole('button', { name: 'Описание ПРа', exact: true }).click();
    await expect(page.locator('[data-architecture-node]')).toHaveCount(5);
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await expect(page.locator('.story-code header code')).toHaveText(fixture.first.path);
});

test('ошибка Mermaid не даёт 100%; повтор схемы сохраняет готовые блоки и файлы', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium'); await page.goto(server.url); await server.worker.register('codex', 'ru');
    const overview = await server.worker.next();
    const broken = { ...fixture.outline, flow: { ...fixture.outline.flow, diagram: { ...fixture.diagram, mermaid: 'flowchart TB\nrequest --> handler --> rule --> saved --> rejected\nrule --> ???' } } };
    await server.worker.complete(overview.taskId ?? 0, JSON.stringify(broken));
    const files = await server.worker.next(); expect(files.type).toBe('route.section');
    await server.worker.complete(files.taskId ?? 0, JSON.stringify(fixture.body));
    await expect(page.locator('.story-preparation')).toContainText('Разбор подготовлен частично');
    await expect(page.locator('[role=progressbar]')).not.toHaveAttribute('aria-valuenow', '100');
    await page.getByRole('button', { name: 'Повторить схему', exact: true }).click();
    const retry = await server.worker.next(); expect(retry.type).toBe('route.diagram');
    expect((await server.worker.complete(retry.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
    await expect(page.locator('[data-architecture-node]')).toHaveCount(5);
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '100');
});
