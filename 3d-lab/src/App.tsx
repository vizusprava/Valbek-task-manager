import { useRef, useState } from 'react'
import { Box, Upload } from 'lucide-react'
import { Viewer } from '@core'
import { localViewerAdapter } from './localAdapter'

type LoadedModel = { url: string; name: string; modelId: string }

async function labConfirm({ message }: { message: string }) {
  return window.confirm(message)
}

export default function App() {
  const [model, setModel] = useState<LoadedModel | null>(null)
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
  }

  if (model) {
    return (
      <Viewer
        url={model.url}
        name={model.name}
        modelId={model.modelId}
        adapter={localViewerAdapter}
        canEdit
        confirm={labConfirm}
        onClose={() => {
          URL.revokeObjectURL(model.url)
          setModel(null)
        }}
      />
    )
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
            <Box size={20} className="text-indigo-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-100">3D Lab</h1>
            <p className="text-xs text-gray-500">Testovací prostředí 3D vieweru — sdílí jádro s hlavní aplikací</p>
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
            dragOver ? 'border-indigo-400 bg-indigo-500/10' : 'border-gray-700 hover:border-indigo-500/60 hover:bg-gray-900/60'
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

        <p className="text-xs text-gray-600 mt-4 text-center">
          Vegetace, anotace, barvy i kamera se ukládají do localStorage — při dalším otevření stejného souboru se obnoví.
        </p>
      </div>
    </div>
  )
}
