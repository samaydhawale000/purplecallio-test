import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3002,
    proxy: {
      '/api': 'http://localhost:3003',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3002,
  },
})
