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
        // Детерминированное окружение; рабочий UI остаётся русским независимо от браузера.
        locale: 'ru-RU',
        // Рабочий UI всегда Arcanum dark; сценарий схемы дополнительно проверяет светлую ОС.
        colorScheme: 'dark',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
