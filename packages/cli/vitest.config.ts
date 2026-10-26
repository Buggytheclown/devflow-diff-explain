import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Бандл нужен и build.test.ts, и protocol.scenarios.test.ts — собираем его до всех файлов.
        globalSetup: ['./src/bundle.global-setup.ts'],
    },
});
