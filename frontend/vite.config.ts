import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8087',
      '/v1': 'http://localhost:8087',
      '/ws': {
        target: 'ws://localhost:8087',
        ws: true,
      },
    },
  },
})
