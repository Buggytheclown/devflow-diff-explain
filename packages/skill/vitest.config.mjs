import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Оба набора пересобирают `dist/` — параллельно они дрались бы за один каталог.
        fileParallelism: false,
    },
});
