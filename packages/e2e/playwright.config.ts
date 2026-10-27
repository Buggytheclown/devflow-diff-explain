import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './src',
    // Приёмка продукта: desktop-флоу объяснения, включая чтение сохранённых v2/v3.
    globalSetup: './src/global-setup.ts',
    workers: 1,
    fullyParallel: false,
    timeout: 120_000,
    expect: { timeout: 10_000 },
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.SHERPA_E2E_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.SHERPA_E2E_EXECUTABLE_PATH },
        viewport: { width: 1440, height: 900 },
        // Локаль браузера фиксирована: настройка языка UI по умолчанию `auto`, а chromium
        // без этого приходит с `en-US` — спеки ищут русские строки.
        locale: 'ru-RU',
        // Системная тема фиксирована по той же причине: настройка темы по умолчанию `auto`,
        // а спеки сверяют цвета тёмной палитры. Спека темы переключает её сама (`emulateMedia`).
        colorScheme: 'dark',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
