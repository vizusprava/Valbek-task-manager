import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, '../react-app/src/viewer-core'),
    },
    // jádro leží v react-app/ — bez dedupe by se three/react natáhly dvakrát
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'postprocessing', 'n8ao', '@tanstack/react-query', 'sonner', 'lucide-react', 'utif'],
  },
  server: {
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
})
