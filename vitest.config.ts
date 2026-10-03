import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@oosr/core': src('core'),
      '@oosr/hub': src('hub'),
      '@oosr/sim': src('sim'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
