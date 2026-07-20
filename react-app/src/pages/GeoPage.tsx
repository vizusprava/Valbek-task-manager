import { useState } from 'react'
import { Maximize2, Minimize2, ExternalLink, Map as MapIcon } from 'lucide-react'
import { PageLayout } from '@/components/layout/PageLayout'

/**
 * Geo Viewer — 3D modely v reálném světě (Cesium + ČÚZK).
 *
 * Běží jako samostatná appka (geo-app/) vložená přes iframe, ne jako komponenta. Důvod je
 * Cesium: vite-plugin-cesium ho vkládá jako obyčejný <script> do index.html (5,7 MB + 14 MB
 * podkladů) a nejde ho tedy načíst líně. Kdyby byl součástí react-app, stahoval by si ho
 * každý na dashboardu. Takhle se natáhne, až když někdo otevře tuhle záložku.
 *
 * V produkci leží build v dist/geo (viz .github/workflows/deploy.yml), v dev běží geo-app
 * na vlastním portu — pak si cestu přebij přes VITE_GEO_URL v react-app/.env.local.
 */
const GEO_URL = import.meta.env.VITE_GEO_URL || `${import.meta.env.BASE_URL}geo/`

export function GeoPage() {
  const [full, setFull] = useState(false)

  const frame = (
    <iframe
      src={GEO_URL}
      title="Geo Viewer"
      className="w-full h-full border-0"
      // mapa si sahá na WebGL, stahování exportů a fullscreen; jiný původ to není, tak bez sandboxu
      allow="fullscreen"
    />
  )

  // fullscreen: stejný vzor jako viewer v ModelsPage (fixed inset-0)
  if (full) {
    return (
      <div className="fixed inset-0 z-50 bg-gray-950">
        {frame}
        <button
          onClick={() => setFull(false)}
          title="Zpět do stránky"
          className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900/85 border border-gray-700 backdrop-blur text-sm text-gray-200 hover:bg-gray-800"
        >
          <Minimize2 size={15} /> Zmenšit
        </button>
      </div>
    )
  }

  return (
    <PageLayout>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <MapIcon size={20} className="text-indigo-600 dark:text-indigo-400" />
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Geo Viewer</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              3D modely v reálném světě, terén DMR 5G a ortofoto z ČÚZK
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFull(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <Maximize2 size={15} /> Na celou obrazovku
          </button>
          <a
            href={GEO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Otevřít ve vlastní záložce prohlížeče"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <ExternalLink size={15} /> Nové okno
          </a>
        </div>
      </div>

      <div className="h-[calc(100vh-11rem)] min-h-[420px] rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-950">
        {frame}
      </div>
    </PageLayout>
  )
}
