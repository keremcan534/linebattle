import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@render': r('./src/render'),
      '@ui': r('./src/ui'),
      '@app': r('./src/app'),
      '@input': r('./src/input'),
    },
  },
  server: { port: 5173, open: true },
  build: { target: 'es2022', sourcemap: true },
});
