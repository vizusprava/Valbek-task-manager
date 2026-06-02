import { useState, useRef, Suspense, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, GizmoHelper, GizmoViewcube } from '@react-three/drei'
import * as THREE from 'three'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Eye, EyeOff, Layers, PanelRight, MessageSquarePlus, Leaf, Camera, Ruler, Grid3x3, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelAnnotation, ModelObjectColor } from '@/lib/types'
import { BUCKET, setMeshGlow } from './shared'
import type { SceneNode, CameraState, CameraSaveResult } from './shared'
import { ModelWithReveal } from './ModelWithReveal'
import { Loader, CameraNearFarSync, FocusTarget, FlyCamera, CameraPersist, CameraRig, FlyToAnnotation } from './CameraControls'
import { MeasureTool, ScreenshotCapture } from './ViewerTools'
import { AnnotationMarkers } from './AnnotationMarkers'
import { VegetationLayer, VEG_CFG, scatterOnMesh } from './Vegetation'
import type { VegGroup, VegType } from './Vegetation'

const VIEW_PRESETS = [
  { id: 'top',    label: 'Vrch' },
  { id: 'bottom', label: 'Dno'  },
  { id: 'front',  label: 'Před' },
  { id: 'back',   label: 'Zad'  },
  { id: 'right',  label: 'Práv' },
  { id: 'left',   label: 'Levo' },
] as const

export function Viewer({ url, name, modelId, onClose, focusAnnotationPos, initialCameraState }: {
  url: string
  name: string
  modelId: string
  onClose: () => void
  focusAnnotationPos?: THREE.Vector3 | null
  initialCameraState?: CameraState | null
}) {
  const { profile } = useAuthStore()
  const confirm = useConfirm()

  const [wireframe,      setWireframe]      = useState(false)
  const [wireframeOnly,  setWireframeOnly]  = useState(false)
  const [wireframeColor, setWireframeColor] = useState('#818cf8')
  const [wireframeMode,  setWireframeMode]  = useState<'wireframe' | 'edges'>('wireframe')
  const [panelOpen,      setPanelOpen]      = useState(() => window.innerWidth >= 768)
  const [nodes,          setNodes]          = useState<SceneNode[]>([])
  const [hiddenIds,      setHiddenIds]      = useState<Set<string>>(new Set())
  const [hoveredId,      setHoveredId]      = useState<string | null>(null)
  const [selectedMesh,   setSelectedMesh]   = useState<THREE.Mesh | null>(null)
  const [selectedColor,  setSelectedColor]  = useState('#cccccc')
  const [annotationMode,       setAnnotationMode]       = useState(false)
  const [annotationsVisible,   setAnnotationsVisible]   = useState(true)
  const [hiddenAnnotationIds,  setHiddenAnnotationIds]  = useState<Set<string>>(new Set())
  const [vegGroups,            setVegGroups]            = useState<VegGroup[]>([])
  const [vegType,              setVegType]              = useState<VegType>('grass')
  const [vegScale,             setVegScale]             = useState(1)
  const [vegOpen,              setVegOpen]              = useState(false)
  const [grassCount,           setGrassCount]           = useState(2000)
  const [grassPatched,         setGrassPatched]         = useState(true)
  const [vegPlaceMode,         setVegPlaceMode]         = useState<'scatter' | 'click'>('scatter')
  const [vegSaved,             setVegSaved]             = useState(true)
  const vegLoadedRef  = useRef(false)
  const vegSkipSave   = useRef(true)
  const vegSaveTimer  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [pendingPin,        setPendingPin]        = useState<THREE.Vector3 | null>(null)
  const [pendingText,       setPendingText]       = useState('')
  const [pendingObjectName, setPendingObjectName] = useState('')
  const [flyMode,     setFlyMode]     = useState(false)
  const [flySpeed,    setFlySpeed]    = useState(10)
  const [measureMode, setMeasureMode] = useState(false)
  const flySpeedRef = useRef(flySpeed)
  const takeFnRef      = useRef<(() => void) | null>(null)
  const cameraSaveRef  = useRef<(() => CameraSaveResult) | null>(null)
  const meshMapRef     = useRef<Map<string, THREE.Mesh>>(new Map())
  const cameraCommandRef = useRef<((v: string) => void) | null>(null)
  const boundsRef        = useRef<THREE.Box3 | null>(null)
  const colorSaveTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queryClient      = useQueryClient()

  const { data: savedColors = [] } = useQuery({
    queryKey: ['model_object_colors', modelId],
    queryFn: async () => {
      const { data, error } = await supabase.from('model_object_colors').select('*').eq('model_id', modelId)
      if (error) throw error
      return data as ModelObjectColor[]
    },
  })

  const { data: savedVeg } = useQuery({
    queryKey: ['model_vegetation', modelId],
    queryFn: async () => {
      const { data } = await supabase.from('model_vegetation').select('data').eq('model_id', modelId).maybeSingle()
      return (data?.data ?? null) as VegGroup[] | null
    },
  })

  useEffect(() => {
    if (savedVeg && savedVeg.length > 0 && !vegLoadedRef.current) {
      vegLoadedRef.current = true
      vegSkipSave.current = true
      setVegGroups(savedVeg)
    }
  }, [savedVeg]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (vegSkipSave.current) { vegSkipSave.current = false; return }
    if (!profile) return
    setVegSaved(false)
    clearTimeout(vegSaveTimer.current)
    vegSaveTimer.current = setTimeout(async () => {
      const r = (n: number, d: number) => Math.round(n * d) / d
      const compact = vegGroups.map(g => ({
        ...g,
        instances: g.instances.map(v => ({
          x: r(v.x, 1000), y: r(v.y, 1000), z: r(v.z, 1000),
          ry: r(v.ry, 100), s: r(v.s, 100),
          rx: v.rx !== undefined ? r(v.rx, 100) : undefined,
          rz: v.rz !== undefined ? r(v.rz, 100) : undefined,
        })),
      }))
      const { error } = await supabase.from('model_vegetation').upsert(
        { model_id: modelId, data: compact, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'model_id' }
      )
      if (error) toast.error('Vegetaci se nepodařilo uložit: ' + error.message)
      else setVegSaved(true)
    }, 1500)
    return () => clearTimeout(vegSaveTimer.current)
  }, [vegGroups]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: annotations = [], refetch: refetchAnnotations } = useQuery({
    queryKey: ['model_annotations', modelId],
    queryFn: async () => {
      const { data, error } = await supabase.from('model_annotations').select('*').eq('model_id', modelId).order('created_at')
      if (error) throw error
      return data as ModelAnnotation[]
    },
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (pendingPin) { setPendingPin(null); return }
        if (annotationMode) { setAnnotationMode(false); return }
        handleClose()
      }
      if (e.key === 'p' || e.key === 'P') {
        if (pendingPin) return
        setAnnotationMode(a => !a)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, pendingPin, annotationMode])

  function handleClose() {
    const result = cameraSaveRef.current?.()
    onClose()
    if (!result) return
    const { canvas, cameraState } = result
    supabase.from('model_files').update({ camera_state: cameraState }).eq('id', modelId).then(() => {
      queryClient.invalidateQueries({ queryKey: ['model_files'] })
    })
    canvas.toBlob(async (blob) => {
      if (!blob) return
      const path = `thumbs/cam_${modelId}.jpg`
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
      if (error) return
      await supabase.from('model_files').update({ thumbnail_path: path }).eq('id', modelId)
      localStorage.setItem(`thumb_v_${modelId}`, Date.now().toString())
      queryClient.invalidateQueries({ queryKey: ['model_files'] })
    }, 'image/jpeg', 0.88)
  }

  function handleMeshSelect(mesh: THREE.Mesh) {
    if (selectedMesh && selectedMesh.uuid !== mesh.uuid)
      setMeshGlow(selectedMesh, hoveredId === selectedMesh.uuid ? 1 : 0)
    setSelectedMesh(mesh)
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const m = mats[0] as THREE.MeshStandardMaterial
    if (m && 'color' in m) setSelectedColor('#' + m.color.getHexString())
  }

  function applyColor(mesh: THREE.Mesh, hex: string) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    mats.forEach(m => { if (m && 'color' in m) (m as THREE.MeshStandardMaterial).color.set(hex) })
  }

  function handleColorChange(hex: string) {
    setSelectedColor(hex)
    if (!selectedMesh) return
    applyColor(selectedMesh, hex)
    if (!selectedMesh.name || !profile) return
    clearTimeout(colorSaveTimer.current)
    colorSaveTimer.current = setTimeout(async () => {
      await supabase.from('model_object_colors').upsert(
        { model_id: modelId, object_name: selectedMesh.name, color: hex, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'model_id,object_name' }
      )
    }, 600)
  }

  function clearSelection() {
    if (selectedMesh) setMeshGlow(selectedMesh, hoveredId === selectedMesh.uuid ? 1 : 0)
    setSelectedMesh(null)
  }

  function toggleVisibility(node: SceneNode) {
    node.object.visible = !node.object.visible
    setHiddenIds(prev => {
      const next = new Set(prev)
      node.object.visible ? next.delete(node.id) : next.add(node.id)
      return next
    })
  }

  function handleAnnotationPlace(pos: THREE.Vector3, objectName: string) {
    setPendingPin(pos)
    setPendingText('')
    setPendingObjectName(objectName)
    setAnnotationMode(false)
  }

  async function handleAnnotationSave() {
    if (!pendingPin || !pendingText.trim() || !profile) return
    const { error } = await supabase.from('model_annotations').insert({
      model_id: modelId, x: pendingPin.x, y: pendingPin.y, z: pendingPin.z,
      text: pendingText.trim(), object_name: pendingObjectName || null, created_by: profile.id,
    })
    if (error) { toast.error(error.message); return }
    setPendingPin(null); setPendingText('')
    refetchAnnotations()
  }

  async function handleAnnotationDelete(id: string) {
    if (!await confirm({ message: 'Smazat poznámku?', confirmLabel: 'Smazat', variant: 'danger' })) return
    const { error } = await supabase.from('model_annotations').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    refetchAnnotations()
  }

  function handleSow() {
    if (!selectedMesh) return
    const count = vegType === 'grass' ? grassCount : VEG_CFG[vegType].count
    const instances = scatterOnMesh(selectedMesh, count, vegType === 'grass' && grassPatched)
    if (!instances.length) { toast.error('Nepodařilo se umístit vegetaci'); return }
    setVegGroups(prev => [...prev, {
      id: crypto.randomUUID(),
      type: vegType,
      targetName: selectedMesh.name,
      scaleMult: vegScale,
      instances,
      mode: 'scatter' as const,
    }])
  }

  function handleVegPlace(pos: THREE.Vector3) {
    const cfg = VEG_CFG[vegType]
    const threshold = cfg.baseH * vegScale * 0.6

    let nearGroupId: string | null = null
    let nearIdx = -1
    for (const g of vegGroups) {
      if (g.type !== vegType) continue
      const idx = g.instances.findIndex(v => Math.hypot(v.x - pos.x, v.z - pos.z) < threshold)
      if (idx >= 0) { nearGroupId = g.id; nearIdx = idx; break }
    }

    if (nearGroupId !== null) {
      setVegGroups(prev =>
        prev
          .map(g => g.id === nearGroupId ? { ...g, instances: g.instances.filter((_, i) => i !== nearIdx) } : g)
          .filter(g => g.instances.length > 0)
      )
      return
    }

    const inst = { x: pos.x, y: pos.y, z: pos.z, ry: Math.random() * Math.PI * 2, s: 0.75 + Math.random() * 0.5, rx: (Math.random() - 0.5) * 0.28, rz: (Math.random() - 0.5) * 0.28 }
    const existing = vegGroups.find(g => g.type === vegType && g.mode === 'click')
    if (existing) {
      setVegGroups(prev => prev.map(g => g.id === existing.id ? { ...g, instances: [...g.instances, inst] } : g))
    } else {
      setVegGroups(prev => [...prev, {
        id: crypto.randomUUID(),
        type: vegType,
        targetName: 'ruční',
        scaleMult: vegScale,
        instances: [inst],
        mode: 'click' as const,
      }])
    }
  }

  const indentPx = (depth: number) => Math.min((depth - 1) * 12, 48)

  return createPortal(
    <div className="fixed inset-0 z-9999 flex flex-col" style={{ background: '#030712' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 shrink-0">
        <span className="text-sm font-medium text-gray-100">{name}</span>
        <div className="flex items-center gap-2">
          {annotations.length > 0 && (
            <button
              onClick={() => setAnnotationsVisible(v => !v)}
              title={annotationsVisible ? 'Skrýt poznámky' : 'Zobrazit poznámky'}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${annotationsVisible ? 'text-gray-400 hover:text-white hover:bg-gray-800' : 'bg-gray-700 text-gray-400'}`}
            >
              {annotationsVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              <span className="hidden sm:inline">Poznámky</span>
            </button>
          )}
          <button
            onClick={() => { setAnnotationMode(a => !a); setPendingPin(null) }}
            title="Přidat poznámku (P)"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${annotationMode ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <MessageSquarePlus size={14} />
            <span className="hidden sm:inline">Poznámka <span style={{ opacity: 0.6, fontSize: 10 }}>(P)</span></span>
          </button>
          <button
            onClick={() => setMeasureMode(m => !m)}
            title="Měřicí nástroj — klikni 2 body na modelu"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${measureMode ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Ruler size={14} />
            <span className="hidden sm:inline">Měřit</span>
          </button>
          <button
            onClick={() => takeFnRef.current?.()}
            title="Uložit screenshot"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <Camera size={14} />
            <span className="hidden sm:inline">Screenshot</span>
          </button>
          <button
            onClick={() => setVegOpen(o => !o)}
            title="Vegetace"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${vegOpen ? 'bg-green-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Leaf size={14} />
            <span className="hidden sm:inline">Vegetace</span>
          </button>
          <button
            onClick={() => setPanelOpen(o => !o)}
            title="Scéna"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${panelOpen ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <PanelRight size={14} />
            <span className="hidden sm:inline">Scéna</span>
          </button>
          <button onClick={handleClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 relative" style={{ cursor: annotationMode || measureMode ? 'crosshair' : (vegOpen && vegPlaceMode === 'click' && vegType !== 'grass') ? 'cell' : 'default' }}>
          <Canvas
            camera={{ position: [9999, 9999, 9999], fov: 45, near: 0.001, far: 1_000_000 }}
            gl={{ preserveDrawingBuffer: true }}
            onPointerMissed={clearSelection}
          >
            <ambientLight intensity={0.6} />
            <directionalLight position={[10, 20, 10]} intensity={1.4} />
            <directionalLight position={[-8, -4, -8]} intensity={0.35} />
            <Environment preset="city" />
            <Suspense fallback={<Loader />}>
              <ModelWithReveal
                url={url}
                wireframe={wireframe}
                wireframeOnly={wireframeOnly}
                wireframeColor={wireframeColor}
                wireframeMode={wireframeMode}
                selectedUuid={selectedMesh?.uuid ?? null}
                annotationMode={annotationMode}
                vegClickPlace={vegOpen && vegPlaceMode === 'click' && vegType !== 'grass'}
                boundsRef={boundsRef}
                onReady={setNodes}
                onMeshMap={map => {
                  meshMapRef.current = map
                  savedColors.forEach(sc => {
                    map.forEach(mesh => { if (mesh.name === sc.object_name) applyColor(mesh, sc.color) })
                  })
                }}
                onHover={setHoveredId}
                onSelect={handleMeshSelect}
                onAnnotationPlace={handleAnnotationPlace}
                onVegPlace={handleVegPlace}
              />
            </Suspense>
            <AnnotationMarkers
              annotations={annotations}
              onDelete={handleAnnotationDelete}
              canDelete={!!profile}
              visible={annotationsVisible}
              hiddenIds={hiddenAnnotationIds}
            />
            <VegetationLayer groups={vegGroups} />
            <CameraRig commandRef={cameraCommandRef} boundsRef={boundsRef} />
            <CameraNearFarSync />
            <FocusTarget disabled={flyMode || annotationMode || (vegOpen && vegPlaceMode === 'click' && vegType !== 'grass')} />
            <FlyCamera speedRef={flySpeedRef} onFlyChange={setFlyMode} />
            <MeasureTool active={measureMode} />
            <FlyToAnnotation pos={focusAnnotationPos ?? null} boundsRef={boundsRef} />
            <ScreenshotCapture takeFnRef={takeFnRef} annotations={annotations} annotationsVisible={annotationsVisible} hiddenAnnotationIds={hiddenAnnotationIds} />
            <CameraPersist modelId={modelId} boundsRef={boundsRef} saveFnRef={cameraSaveRef} initialCameraState={initialCameraState ?? null} />
            <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
              <GizmoViewcube />
            </GizmoHelper>
            <OrbitControls makeDefault zoomToCursor enableDamping dampingFactor={0.07} enabled={!flyMode} />
          </Canvas>

          {/* View preset buttons + fly speed */}
          <div className="absolute bottom-12 left-3 flex flex-col gap-1 z-10">
            {VIEW_PRESETS.map(v => (
              <button
                key={v.id}
                onClick={() => cameraCommandRef.current?.(v.id)}
                className="w-10 h-6 text-[10px] font-semibold bg-gray-900/80 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 rounded transition-colors"
              >
                {v.label}
              </button>
            ))}
            <div className={`mt-1 flex flex-col gap-0.5 px-1 py-1.5 bg-gray-900/80 border rounded transition-colors ${flyMode ? 'border-indigo-500' : 'border-gray-700'}`}>
              <span className={`text-[9px] font-semibold text-center ${flyMode ? 'text-indigo-400' : 'text-gray-500'}`}>
                {flyMode ? 'FLY' : 'spd'}
              </span>
              <input
                type="range" min={0.5} max={100} step={0.5} value={flySpeed}
                onChange={e => { const v = Number(e.target.value); setFlySpeed(v); flySpeedRef.current = v }}
                className="w-8 accent-indigo-500"
                title={`Rychlost letu: ${flySpeed} m/s`}
              />
              <span className="text-[9px] text-gray-400 text-center">{flySpeed}</span>
            </div>
          </div>

          {/* Vegetation panel */}
          {vegOpen && (
            <div className="absolute top-3 left-3 z-10 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><Leaf size={12} /> Vegetace</span>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] transition-colors ${vegSaved ? 'text-green-600' : 'text-amber-500'}`}>
                    {vegSaved ? '● uloženo' : '● ukládám…'}
                  </span>
                  {vegGroups.length > 0 && (
                    <button onClick={() => setVegGroups([])} className="text-xs text-red-400 hover:text-red-300 transition-colors">Smazat vše</button>
                  )}
                </div>
              </div>
              <div className="p-3 space-y-3">
                <div>
                  <p className="text-xs text-gray-500 mb-1.5">Typ</p>
                  <div className="grid grid-cols-2 gap-1">
                    {(Object.keys(VEG_CFG) as VegType[]).map(t => (
                      <button
                        key={t}
                        onClick={() => { setVegType(t); if (t === 'grass') setVegPlaceMode('scatter') }}
                        className={`px-2 py-1 text-xs rounded font-medium transition-colors ${vegType === t ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'}`}
                      >
                        {VEG_CFG[t].label}
                      </button>
                    ))}
                  </div>
                </div>
                {vegType === 'grass' && (
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between mb-1">
                        <p className="text-xs text-gray-500">Hustota</p>
                        <span className="text-xs text-gray-400">{grassCount.toLocaleString()}</span>
                      </div>
                      <input type="range" min={200} max={10000} step={100} value={grassCount}
                        onChange={e => setGrassCount(Number(e.target.value))}
                        className="w-full accent-green-500" />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={grassPatched} onChange={e => setGrassPatched(e.target.checked)} className="w-3.5 h-3.5 accent-green-500" />
                      <span className="text-xs text-gray-400">Shluky (patches)</span>
                    </label>
                  </div>
                )}
                {vegType !== 'grass' && (
                  <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                    {(['scatter', 'click'] as const).map(m => (
                      <button key={m} onClick={() => setVegPlaceMode(m)}
                        className={`flex-1 py-1 font-medium transition-colors ${vegPlaceMode === m ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                        {m === 'scatter' ? 'Náhodně' : 'Klikem'}
                      </button>
                    ))}
                  </div>
                )}
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500">Měřítko</p>
                    <span className="text-xs text-gray-400">{vegScale.toFixed(2)}×</span>
                  </div>
                  <input type="range" min={0.1} max={5} step={0.05} value={vegScale}
                    onChange={e => setVegScale(Number(e.target.value))}
                    className="w-full accent-green-500" />
                </div>
                {(vegType === 'grass' || vegPlaceMode === 'scatter') ? (
                  <button
                    onClick={handleSow}
                    disabled={!selectedMesh}
                    className="w-full py-1.5 text-xs font-semibold bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                  >
                    {selectedMesh ? `Zasít na "${selectedMesh.name}"` : 'Vyber objekt v modelu'}
                  </button>
                ) : (
                  <p className="text-xs text-center text-green-400/80 bg-green-900/20 rounded-lg py-1.5 px-2">
                    Klikni na plochu · klikni na existující pro smazání
                  </p>
                )}
                {vegGroups.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 mb-1">{vegGroups.length} vrst{vegGroups.length === 1 ? 'va' : 'ev'}</p>
                    <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
                      {vegGroups.map(g => (
                        <div key={g.id} className="flex items-center justify-between bg-gray-800 rounded px-2 py-1">
                          <span className="text-xs text-gray-300 truncate">
                            {VEG_CFG[g.type].label}
                            <span className="text-gray-600"> · {g.targetName}</span>
                          </span>
                          <button onClick={() => setVegGroups(prev => prev.filter(x => x.id !== g.id))} className="text-gray-600 hover:text-red-400 transition-colors ml-1 shrink-0">
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Annotation mode hint */}
          {annotationMode && !pendingPin && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-600/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
              Klikni na model pro umístění poznámky · Esc pro zrušení
            </div>
          )}

          {/* Pending annotation input */}
          {pendingPin && (
            <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/30">
              <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 shadow-2xl w-72 max-w-[calc(100vw-2rem)]">
                <p className="text-xs text-gray-400 mb-2 font-medium">Nová poznámka</p>
                <textarea
                  autoFocus
                  value={pendingText}
                  onChange={e => setPendingText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAnnotationSave() }
                    if (e.key === 'Escape') setPendingPin(null)
                  }}
                  placeholder="Text poznámky…"
                  rows={2}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleAnnotationSave}
                    disabled={!pendingText.trim()}
                    className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >
                    Uložit
                  </button>
                  <button onClick={() => setPendingPin(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">
                    Zrušit
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Selected mesh color bar */}
          {selectedMesh && !pendingPin && (
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl px-4 py-3 flex items-center gap-3 shadow-2xl z-10">
              <span className="text-xs text-gray-300 font-medium max-w-32 truncate">{selectedMesh.name || 'Objekt'}</span>
              <div className="w-px h-4 bg-gray-700" />
              <label className="cursor-pointer" title="Barva objektu">
                <input type="color" value={selectedColor} onChange={e => handleColorChange(e.target.value)} className="sr-only" />
                <div className="w-7 h-7 rounded-md border-2 border-gray-600 hover:border-gray-400 transition-colors" style={{ backgroundColor: selectedColor }} />
              </label>
              <button onClick={clearSelection} className="text-gray-500 hover:text-gray-300 transition-colors">
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Scene panel */}
        {panelOpen && (
          <div className="w-56 max-w-[75vw] bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
            <div className="px-3 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={13} /> Objekty
              </span>
            </div>
            <div className="px-3 py-2.5 border-b border-gray-800 space-y-2">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setWireframe(w => !w)}
                  className={`flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${wireframe ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                >
                  <Grid3x3 size={13} /> Wireframe
                </button>
                <label className="relative cursor-pointer shrink-0" title="Barva wireframe">
                  <input type="color" value={wireframeColor} onChange={e => setWireframeColor(e.target.value)} className="sr-only" />
                  <div className="w-7 h-7 rounded-md border-2 border-gray-700 hover:border-gray-400 transition-colors" style={{ backgroundColor: wireframeColor }} />
                </label>
              </div>
              {wireframe && (
                <>
                  <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                    {(['wireframe', 'edges'] as const).map(mode => (
                      <button key={mode} onClick={() => setWireframeMode(mode)}
                        className={`flex-1 py-1 font-medium transition-colors ${wireframeMode === mode ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                        {mode === 'wireframe' ? 'Síť' : 'Obrysy'}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={wireframeOnly} onChange={e => setWireframeOnly(e.target.checked)} className="w-3.5 h-3.5 accent-indigo-500" />
                    <span className="text-xs text-gray-400">Pouze síť</span>
                  </label>
                </>
              )}
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {nodes.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-4">Načítám…</p>
              ) : nodes.map(node => {
                const hidden = hiddenIds.has(node.id)
                return (
                  <div
                    key={node.id}
                    style={{ paddingLeft: 12 + indentPx(node.depth) }}
                    onClick={() => { const mesh = meshMapRef.current.get(node.id); if (mesh) handleMeshSelect(mesh) }}
                    className={`flex items-center gap-1.5 pr-2 py-1 cursor-pointer transition-colors ${hidden ? 'opacity-40' : ''} ${
                      node.id === selectedMesh?.uuid ? 'bg-indigo-900/40' : node.id === hoveredId ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                    }`}
                  >
                    <button onClick={e => { e.stopPropagation(); toggleVisibility(node) }} className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors">
                      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <span className="text-xs text-gray-300 truncate flex-1" title={node.name}>{node.name}</span>
                  </div>
                )
              })}
            </div>
            {annotations.length > 0 && (
              <div className="border-t border-gray-800">
                <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <MessageSquarePlus size={12} /> Poznámky
                </div>
                <div className="max-h-40 overflow-y-auto pb-1">
                  {annotations.map(ann => {
                    const annHidden = hiddenAnnotationIds.has(ann.id)
                    return (
                      <div key={ann.id} className={`flex items-start gap-1.5 px-3 py-1.5 hover:bg-gray-800/50 group transition-colors ${annHidden ? 'opacity-40' : ''}`}>
                        <button
                          onClick={() => setHiddenAnnotationIds(prev => {
                            const next = new Set(prev)
                            annHidden ? next.delete(ann.id) : next.add(ann.id)
                            return next
                          })}
                          className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors mt-0.5"
                        >
                          {annHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                        <span className="text-xs text-gray-300 flex-1 wrap-break-word">{ann.text}</span>
                        {profile && (
                          <button onClick={() => handleAnnotationDelete(ann.id)} className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 shrink-0 transition-all mt-0.5">
                            <X size={11} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-500 shrink-0 text-center">
        Levé tlačítko: otočit · Pravé tlačítko: posunout · Kolečko: přiblížit
      </div>
    </div>,
    document.body
  )
}
