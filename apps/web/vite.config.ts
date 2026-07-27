import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
  optimizeDeps: {
    include: ['@devloop/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared\/dist/],
    },
    rollupOptions: {
      output: {
        manualChunks: {
          graph: ['cytoscape'],
        },
      },
    },
  },
});
