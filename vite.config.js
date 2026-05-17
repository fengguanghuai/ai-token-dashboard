import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          echarts: ['echarts']
        }
      }
    },
    chunkSizeWarningLimit: 1500
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4173'
    }
  }
});
