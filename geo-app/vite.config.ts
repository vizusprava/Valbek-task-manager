import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesium from 'vite-plugin-cesium'
import path from 'path'

export default defineConfig(({ command }) => ({
  // Build jde do react-app/dist/geo, odkud ho webovka otevírá v záložce (iframe).
  // RELATIVNÍ base, ne '/Valbek-task-manager/geo/': vite-plugin-cesium kopíruje podklady do
  // `outDir + CESIUM_BASE_URL`, takže absolutní base by je zahrabala do dist/Valbek-task-manager/
  // geo/cesium/ — jinam, než na ně odkazuje index.html (= 404 na Cesium). S './' vyjde
  // CESIUM_BASE_URL na 'cesium/', kopie sedí a build je navíc přenositelný na libovolnou cestu.
  base: command === 'build' ? './' : '/',
  plugins: [react(), tailwindcss(), cesium()],
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
}))
