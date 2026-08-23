import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 3003, host: '0.0.0.0' },
  preview: { port: 3003, host: '0.0.0.0' },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1000,
  },
})
