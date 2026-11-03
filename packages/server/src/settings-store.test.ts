import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsPathFor } from './paths.js';
import { SettingsStore } from './settings-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

describe('глобальные настройки UI', () => {
    let sherpaDir: string;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        await removeTempSherpaDir(sherpaDir);
    });

    it('без файла отдаёт дефолты', () => {
        expect(new SettingsStore(sherpaDir).read()).toEqual({
            diffMode: 'unified',
            generationLocale: 'auto',
            locale: 'ru',
            theme: 'dark',
            arcanum: true,
            textSize: 'm',
        });
    });

    it('мигрирует старый язык ответа и сохраняет размер, оформление фиксировано', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify({ locale: 'en', theme: 'light', arcanum: false, textSize: 'l', shipMode: 'ship' }));
        const store = new SettingsStore(sherpaDir);
        expect(store.read()).toMatchObject({ generationLocale: 'en', locale: 'ru', theme: 'dark', arcanum: true, textSize: 'l' });
        const saved = store.patch({ diffMode: 'split' });
        expect(saved).not.toHaveProperty('shipMode');
        expect(new SettingsStore(sherpaDir).read()).toEqual(saved);
    });

    it('битый JSON деградирует в дефолты, а не в ошибку', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), '{ это не json');

        expect(new SettingsStore(sherpaDir).read().diffMode).toBe('unified');
    });

    it.each([{ diffMode: 'three-way' }, { theme: 'arcanum-dark' }])('значение вне схемы деградирует в дефолты: %j', async (settings) => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify(settings));

        expect(new SettingsStore(sherpaDir).read()).toMatchObject({ diffMode: 'unified', theme: 'dark', arcanum: true });
    });

    it('патч одного поля не трогает остальные', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ generationLocale: 'en' });

        const settings = store.patch({ diffMode: 'split' });

        expect(settings).toEqual({
            diffMode: 'split',
            generationLocale: 'en',
            locale: 'ru',
            theme: 'dark',
            arcanum: true,
            textSize: 'm',
        });
        expect(new SettingsStore(sherpaDir).read()).toEqual(settings);
    });

    it('язык генерации меняется независимо от интерфейса и размера текста', () => {
        const store = new SettingsStore(sherpaDir); store.patch({ textSize: 'l' });
        expect(store.patch({ generationLocale: 'en' })).toMatchObject({ locale: 'ru', generationLocale: 'en', textSize: 'l' });
    });

    it('пустой патч ничего не меняет', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ diffMode: 'split' });

        expect(store.patch({}).diffMode).toBe('split');
    });

    it('два стора над одним файлом не затирают чужие поля', () => {
        const first = new SettingsStore(sherpaDir);
        const second = new SettingsStore(sherpaDir);

        first.patch({ diffMode: 'split' });
        const merged = second.patch({ generationLocale: 'en' });

        expect(merged).toMatchObject({ diffMode: 'split', generationLocale: 'en' });
        expect(first.read()).toEqual(merged);
    });

    it('режим Comment сплит-кнопки сохраняется и читается заново', () => {
        new SettingsStore(sherpaDir).patch({ generationLocale: 'ru' });

        expect(new SettingsStore(sherpaDir).read().generationLocale).toBe('ru');
    });

    it('неизвестные поля файла не переживают запись', async () => {
        const file = settingsPathFor(sherpaDir);
        await fs.writeFile(file, JSON.stringify({ diffMode: 'split', pizza: 'ананасовая' }));

        new SettingsStore(sherpaDir).patch({ generationLocale: 'en' });

        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
            diffMode: 'split',
            generationLocale: 'en',
            locale: 'ru',
            theme: 'dark',
            arcanum: true,
            textSize: 'm',
        });
    });

    it('файл настроек виден только владельцу', async () => {
        new SettingsStore(sherpaDir).patch({ diffMode: 'split' });

        const stats = await fs.stat(settingsPathFor(sherpaDir));

        expect(stats.mode & 0o777).toBe(0o600);
    });

    it('после записи временных файлов не остаётся', async () => {
        new SettingsStore(sherpaDir).patch({ diffMode: 'split' });

        expect((await fs.readdir(sherpaDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
});
