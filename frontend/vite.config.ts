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
      '/api': 'http://localhost:8082',
      '/v1': 'http://localhost:8082',
      '/ws': {
        target: 'ws://localhost:8082',
        ws: true,
      },
    },
  },
})
