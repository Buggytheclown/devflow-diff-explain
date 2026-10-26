import type { Locator, Page } from '@playwright/test';

import { diffOf, expect, test } from './sherpa-fixture.js';

/**
 * Картинки в диффе: вместо нотиса «двоичный файл не показан» — карточка-картинка,
 * байты по-настоящему едут ручкой блобов, а режимы 2-up / Swipe / Onion Skin / Diff переключаются
 * на живой странице. Разница считается в веб-воркере, поэтому её проверка — про экран, а не про
 * чистую функцию: та закрыта юнитами.
 */

const BANNER = 'services/orders/src/ui/assets/edit-window-banner.png';
const ICON = 'services/orders/src/ui/assets/countdown-icon.svg';

/** Карточка файла по пути: в полном диффе их два десятка, а нужна конкретная. */
function fileCard(page: Page, path: string): Locator {
    return page.locator('.file-card').filter({ has: page.locator(`.file-card__path[title="${path}"]`) });
}

/**
 * Список полного диффа виртуализован: карточка появляется в DOM, только когда список к ней
 * доедет. Ведёт его тот же параметр адреса `#file=`, что и ссылка на файл.
 */
async function openFile(page: Page, fileId: string, path: string): Promise<Locator> {
    await page.evaluate((id) => {
        const params = new URLSearchParams(location.hash.slice(1));
        // Сначала снять: повторный переход к тому же файлу не менял бы адрес и не дал бы события.
        params.delete('file');
        location.hash = params.toString();
        params.set('file', id);
        location.hash = params.toString();
    }, fileId);

    const card = fileCard(page, path);
    await expect(card).toHaveCount(1);
    await card.scrollIntoViewIfNeeded();
    return card;
}

function modeButton(card: Locator, label: string): Locator {
    return card.locator('.image-card__modes').getByRole('button', { name: label, exact: true });
}

test('картинки в диффе: режимы, попиксельная разница, скачивание и отметки', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const blobs: { status: number; contentType: string | undefined }[] = [];
    page.on('response', (response) => {
        if (response.url().includes('/api/ui/review/blob')) {
            blobs.push({ status: response.status(), contentType: response.headers()['content-type'] });
        }
    });

    await page.goto(server.url);
    const files = await diffOf(page, server);
    const idOf = (path: string): string => {
        const file = files.find((candidate) => candidate.path === path);
        if (file === undefined) {
            throw new Error(`в фикстуре medium нет файла ${path}`);
        }
        return file.fileId;
    };
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

    let banner = await openFile(page, idOf(BANNER), BANNER);

    await test.step('растровая правка приезжает карточкой-картинкой, а не нотисом', async () => {
        await expect(banner.locator('.image-card__modes')).toBeVisible();
        await expect(banner).not.toContainText('двоичный файл не показан');

        const sides = banner.locator('img.image-card__image');
        await expect(sides).toHaveCount(2);
        // Байты дошли и декодировались: у обеих сторон честные 48 × 32 из фикстуры.
        await expect
            .poll(() => sides.evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth)))
            .toEqual([48, 48]);

        expect(blobs.length).toBeGreaterThan(0);
        expect(blobs.every((blob) => blob.status === 200)).toBe(true);
        expect(blobs.some((blob) => blob.contentType === 'image/png')).toBe(true);
    });

    await test.step('Swipe: разделитель ходит клавиатурой', async () => {
        await modeButton(banner, 'Swipe').click();

        const divider = banner.getByRole('slider', { name: 'Разделитель сравнения' });
        await expect(divider).toHaveAttribute('aria-valuenow', '50');

        await divider.focus();
        await page.keyboard.press('ArrowRight');

        await expect(divider).toHaveAttribute('aria-valuenow', '52');
    });

    await test.step('Onion Skin: непрозрачность верхней стороны на ползунке', async () => {
        await modeButton(banner, 'Onion Skin').click();

        const slider = banner.locator('.image-card__slider input[type="range"]');
        await expect(slider).toHaveValue('50');
        await slider.fill('80');

        await expect(banner.locator('.image-card__clip')).toHaveCSS('opacity', '0.8');
    });

    await test.step('Diff: разница посчиталась и сводка говорит про ненулевой процент', async () => {
        await modeButton(banner, 'Diff').click();

        const canvas = banner.getByRole('img', { name: `${BANNER} — попиксельная разница` });
        await expect(canvas).toBeVisible();
        // Холст размечен под общий прямоугольник сторон — значит `putImageData` дошёл до него.
        await expect(canvas).toHaveAttribute('width', '48');
        await expect(canvas).toHaveAttribute('height', '32');
        // Прямоугольник переехал и сменил цвет — процент обязан быть отличным от нуля.
        await expect(banner.locator('.image-card__overlay .image-card__meta')).toContainText(
            /изменено \d+(?:,\d+)? % пикселей/u,
        );
        await expect(banner.locator('.image-card__overlay .image-card__meta')).not.toContainText('изменено 0 %');
        // Стороны одного размера: пометки про размеры быть не должно.
        await expect(banner).not.toContainText('размеры различаются');
    });

    await test.step('обратно в 2-up: снова две стороны рядом', async () => {
        await modeButton(banner, '2-up').click();

        await expect(banner.locator('img.image-card__image')).toHaveCount(2);
        await expect(banner.getByRole('img', { name: `${BANNER} — попиксельная разница` })).toHaveCount(0);
    });

    await test.step('svg с патчем: режим «Текст» показывает строки, наложения выключены', async () => {
        const icon = await openFile(page, idOf(ICON), ICON);

        for (const label of ['Swipe', 'Onion Skin', 'Diff']) {
            await expect(modeButton(icon, label)).toBeDisabled();
            await expect(modeButton(icon, label)).toHaveAttribute('title', 'нужны обе стороны');
        }

        await modeButton(icon, 'Текст').click();
        await expect(icon.locator('.diff-rows')).toContainText('<svg');
    });

    await test.step('«Скачать» отдаёт файл под его собственным именем', async () => {
        banner = await openFile(page, idOf(BANNER), BANNER);
        const download = page.waitForEvent('download');
        await banner.getByRole('link', { name: 'Скачать', exact: true }).first().click();

        expect((await download).suggestedFilename()).toBe('edit-window-banner.png');
    });

    // Комментарий раньше отметки: «Просмотрено» сворачивает карточку вместе с её меню.
    await test.step('«Комментарий к файлу» открывает композер под шапкой карточки', async () => {
        await banner.getByRole('button', { name: 'Действия с файлом', exact: true }).click();
        await page.getByRole('menu').getByRole('menuitem', { name: 'Комментарий к файлу', exact: true }).click();

        await expect(banner.locator('.thread-composer')).toBeVisible();
        await expect(banner).toContainText('Замечание по файлу целиком — не привязано к строке');
    });

    await test.step('«Просмотрено» на картинке отмечает файл', async () => {
        const toggle = banner.getByRole('button', { name: 'Отметить просмотренным', exact: true });
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');

        await toggle.click();

        await expect(banner.getByRole('button', { name: 'Просмотрено', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(banner.locator('.file-card__collapsed--file')).toContainText('просмотрено');
    });
});
