import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests run in plain Node with no DOM.
 *
 * That is a deliberate constraint, not a convenience: if a test in `core/`
 * ever needs jsdom, something has leaked a browser dependency into the
 * simulation and the layering has been violated. The test environment is the
 * enforcement mechanism.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@render': r('./src/render'),
      '@ui': r('./src/ui'),
      '@app': r('./src/app'),
      '@input': r('./src/input'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
