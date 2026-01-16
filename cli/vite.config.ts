import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'lrag.ts'),
      name: 'lrag',
      fileName: () => 'lrag.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['http', 'child_process', 'readline'],
      output: {
        banner: '#!/usr/bin/env node',
        inlineDynamicImports: true,
      },
    },
    outDir: '.',
    emptyOutDir: false,
    minify: false,
    target: 'node18',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
