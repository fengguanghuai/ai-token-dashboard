import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom']
        }
      }
    },
    chunkSizeWarningLimit: 1500
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT || '4173'}`,
        // Preserve the browser's Host/Origin pair. Vite's string shorthand
        // enables changeOrigin and makes legitimate local POSTs look cross-site.
        changeOrigin: false
      }
    }
  }
});
