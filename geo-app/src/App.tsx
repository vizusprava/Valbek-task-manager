import { useRef, useState } from 'react'
import { Globe2, Upload, Map as MapIcon } from 'lucide-react'
import { Viewer } from '@core'
import { localViewerAdapter } from './localAdapter'
import { MapView } from './MapView'

type LoadedModel = { url: string; name: string; modelId: string }
type Mode = 'home' | 'editor' | 'map'

async function geoConfirm({ message }: { message: string }) {
  return window.confirm(message)
}

export default function App() {
  const [model, setModel] = useState<LoadedModel | null>(null)
  const [mode, setMode] = useState<Mode>('map')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function openFile(file: File) {
    if (!/\.(glb|gltf)$/i.test(file.name)) return
    setModel({
      url: URL.createObjectURL(file),
      name: file.name.replace(/\.(glb|gltf)$/i, ''),
      // stabilní id podle souboru — vegetace/anotace/kamera přežijí reload
      modelId: `${file.name}_${file.size}`,
    })
    setMode('editor')
  }

  if (mode === 'map') {
    return <MapView onBackToEditor={() => setMode(model ? 'editor' : 'home')} />
  }

  // TODO Fáze 4+: model jako glTF primitiv v mapě + manipulace + footprint clip
  if (mode === 'editor' && model) {
    return (
      <div className="relative h-full">
        <Viewer
          url={model.url}
          name={model.name}
          modelId={model.modelId}
          adapter={localViewerAdapter}
          canEdit
          confirm={geoConfirm}
          onClose={() => {
            URL.revokeObjectURL(model.url)
            setModel(null)
            setMode('home')
          }}
        />
        <button
          onClick={() => setMode('map')}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium shadow-lg"
        >
          <MapIcon size={16} /> Umístit na mapu
        </button>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center">
            <Globe2 size={20} className="text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-100">Geo Viewer</h1>
            <p className="text-xs text-gray-500">Umístění 3D modelů do reálného světa — sdílí jádro vieweru s hlavní aplikací</p>
          </div>
        </div>

        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) openFile(f)
          }}
          className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-emerald-400 bg-emerald-500/10' : 'border-gray-700 hover:border-emerald-500/60 hover:bg-gray-900/60'
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".glb,.gltf"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) openFile(f)
              e.target.value = ''
            }}
          />
          <Upload size={28} className="mx-auto mb-3 text-gray-500" />
          <p className="text-sm text-gray-300 font-medium">Přetáhni sem model, nebo klikni pro výběr</p>
          <p className="text-xs text-gray-600 mt-1.5">.glb / .gltf (vše zůstává lokálně — nic se nikam nenahrává)</p>
        </div>

        <button
          onClick={() => setMode('map')}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium transition-colors"
        >
          <MapIcon size={16} /> Otevřít mapu (Cesium + ČÚZK)
        </button>
      </div>
    </div>
  )
}
