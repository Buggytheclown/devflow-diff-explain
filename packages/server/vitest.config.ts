import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Сервер-бандл нужен bundle.test.ts — собираем его до всех файлов, один раз на прогон.
        globalSetup: ['./src/bundle.global-setup.ts'],
    },
});
