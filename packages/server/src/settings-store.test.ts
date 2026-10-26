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
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it.each(['dark', 'light', 'auto'] as const)('тема %s переживает повторное открытие старого файла', async (theme) => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify({ diffMode: 'split', locale: 'en' }));
        const store = new SettingsStore(sherpaDir);
        expect(store.read()).toMatchObject({ theme: 'auto', textSize: 'm', diffMode: 'split', locale: 'en' });
        store.patch({ theme });
        expect(new SettingsStore(sherpaDir).read()).toMatchObject({ theme, arcanum: false, diffMode: 'split', locale: 'en' });
    });

    it('выбор темы и оформление Arcanum сохраняются независимо', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ theme: 'light' });
        expect(store.patch({ arcanum: true })).toMatchObject({ theme: 'light', arcanum: true });
        expect(store.patch({ theme: 'auto' })).toMatchObject({ theme: 'auto', arcanum: true });
        expect(store.patch({ arcanum: false })).toMatchObject({ theme: 'auto', arcanum: false });
        expect(new SettingsStore(sherpaDir).read()).toMatchObject({ theme: 'auto', arcanum: false });
    });

    it('битый JSON деградирует в дефолты, а не в ошибку', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), '{ это не json');

        expect(new SettingsStore(sherpaDir).read().diffMode).toBe('unified');
    });

    it.each([{ diffMode: 'three-way' }, { theme: 'arcanum-dark' }])('значение вне схемы деградирует в дефолты: %j', async (settings) => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify(settings));

        expect(new SettingsStore(sherpaDir).read()).toMatchObject({ diffMode: 'unified', theme: 'auto', arcanum: false });
    });

    it('патч одного поля не трогает остальные', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ shipMode: 'sticky_ship' });

        const settings = store.patch({ diffMode: 'split' });

        expect(settings).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(new SettingsStore(sherpaDir).read()).toEqual(settings);
    });

    it('вложенный объект патча заменяется целиком и не задевает соседние поля', () => {
        const store = new SettingsStore(sherpaDir);

        const settings = store.patch({ onboarding: { completedAt: null, step: 3 } });

        expect(settings.onboarding).toEqual({ completedAt: null, step: 3 });
        expect(settings.locale).toBe('auto');
    });

    it('патч языка не сбрасывает онбординг', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ onboarding: { completedAt: null, step: 3 } });

        const settings = store.patch({ locale: 'en' });

        expect(settings).toMatchObject({ locale: 'en', onboarding: { completedAt: null, step: 3 } });
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
        const merged = second.patch({ shipMode: 'sticky_ship' });

        expect(merged).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
        expect(first.read()).toEqual(merged);
    });

    it('режим Comment сплит-кнопки сохраняется и читается заново', () => {
        new SettingsStore(sherpaDir).patch({ shipMode: 'comment' });

        expect(new SettingsStore(sherpaDir).read().shipMode).toBe('comment');
    });

    it('неизвестные поля файла не переживают запись', async () => {
        const file = settingsPathFor(sherpaDir);
        await fs.writeFile(file, JSON.stringify({ diffMode: 'split', pizza: 'ананасовая' }));

        new SettingsStore(sherpaDir).patch({ shipMode: 'sticky_ship' });

        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
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
