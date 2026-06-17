import { useState, useRef, Suspense, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, GizmoHelper, GizmoViewcube } from '@react-three/drei'
import * as THREE from 'three'
import { Eye, EyeOff, Layers, PanelRight, MessageSquarePlus, Leaf, Camera, Ruler, Grid3x3, X, Sun, Bookmark, Crop, Plus, Pencil, FolderInput, Trash2, ChevronDown, ChevronRight, Palette } from 'lucide-react'
import { toast } from 'sonner'
import type { ViewerAdapter, ConfirmFn, SceneOrg, SceneLayer, SavedView, MaterialAssignment, MaterialDef, ViewerAnnotation } from './adapter'
import { setMeshGlow } from './shared'
import type { SceneNode, CameraState, CameraSaveResult } from './shared'
import { ModelWithReveal } from './ModelWithReveal'
import { Loader, CameraNearFarSync, FocusTarget, FlyCamera, CameraPersist, CameraRig, FlyToAnnotation } from './CameraControls'
import { MeasureTool, ScreenshotCapture } from './ViewerTools'
import type { MeasureApi } from './ViewerTools'
import { AnnotationMarkers } from './AnnotationMarkers'
import { VegetationLayer, VEG_CFG, scatterOnMesh, mulberry32 } from './Vegetation'
import type { VegGroup, VegType } from './Vegetation'
import { HdriSky, StudioLights, GroundPlane, SectionPlane, CameraFlyTo, Effects, ToneMapping } from './Environment3D'
import type { ToneMappingMode, SkyPreset } from './Environment3D'
import { MaterialsPanel } from './MaterialsPanel'
import { ViewsPanel } from './ViewsPanel'
import { getMaterialInstance, applyBoxUV, DEFAULT_GLASS } from './materials'

const VIEW_PRESETS = [
  { id: 'top',    label: 'Vrch' },
  { id: 'bottom', label: 'Dno'  },
  { id: 'front',  label: 'Před' },
  { id: 'back',   label: 'Zad'  },
  { id: 'right',  label: 'Práv' },
  { id: 'left',   label: 'Levo' },
] as const

export function Viewer({ url, name, modelId, adapter, canEdit, confirm, onClose, focusAnnotationPos, initialCameraState, onCreateTask }: {
  url: string
  name: string
  modelId: string
  adapter: ViewerAdapter
  canEdit: boolean
  confirm: ConfirmFn
  onClose: () => void
  focusAnnotationPos?: THREE.Vector3 | null
  initialCameraState?: CameraState | null
  /** vytvoření úkolu z anotace — řeší hostitelská appka (mimo viewer-core) */
  onCreateTask?: (annotation: ViewerAnnotation) => void
}) {
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
  const [activePanel,          setActivePanel]          = useState<'veg' | 'env' | 'section' | 'views' | 'materials' | null>(null)
  const [grassCount,           setGrassCount]           = useState(2000)
  const [grassPatched,         setGrassPatched]         = useState(true)
  const [vegPlaceMode,         setVegPlaceMode]         = useState<'scatter' | 'click'>('scatter')
  const [vegSaved,             setVegSaved]             = useState(true)
  const [meshesLoaded,         setMeshesLoaded]         = useState(false)
  const vegLoadedRef  = useRef(false)
  const vegSkipSave   = useRef(true)
  const vegSaveTimer  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [pendingPin,        setPendingPin]        = useState<THREE.Vector3 | null>(null)
  const [pendingText,       setPendingText]       = useState('')
  const [pendingObjectName, setPendingObjectName] = useState('')
  const [addPinFor,         setAddPinFor]         = useState<string | null>(null)
  const [flyMode,     setFlyMode]     = useState(false)
  const [flySpeed,    setFlySpeed]    = useState(10)
  const [measureMode, setMeasureMode] = useState(false)
  const [measureCount, setMeasureCount] = useState(0)
  const measureApiRef = useRef<MeasureApi | null>(null)
  // prostředí
  const [envMode,   setEnvMode]   = useState<'studio' | 'sun'>('studio')
  const [skyPreset, setSkyPreset] = useState<SkyPreset>('afternoon')
  const [skyRotation, setSkyRotation] = useState(0)
  const [groundOn,  setGroundOn]  = useState(false)
  const [groundY,   setGroundY]   = useState(0)
  const [bloomOn,   setBloomOn]   = useState(false)
  const [toneMap,   setToneMap]   = useState<ToneMappingMode>('aces')
  const [exposure,  setExposure]  = useState(1)
  const [shadowSoft, setShadowSoft] = useState(25)
  // řez modelem
  const [sectionOn,     setSectionOn]     = useState(false)
  const [sectionAxis,   setSectionAxis]   = useState<'x' | 'y' | 'z'>('x')
  const [sectionOffset, setSectionOffset] = useState(0.5)
  const [sectionFlip,   setSectionFlip]   = useState(false)
  const [sectionRotA,   setSectionRotA]   = useState(0)
  const [sectionRotB,   setSectionRotB]   = useState(0)
  const [sectionGhost,  setSectionGhost]  = useState(false)
  // organizace scény (přejmenování + vrstvy)
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [layers,  setLayers]  = useState<SceneLayer[]>([])
  const [renamingId,   setRenamingId]   = useState<string | null>(null)
  const [renameDraft,  setRenameDraft]  = useState('')
  const [assignMenuId, setAssignMenuId] = useState<string | null>(null)
  const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set())
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set())
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  // materiály
  const [objMaterials, setObjMaterials] = useState<Record<string, MaterialAssignment>>({})
  const originalMatsRef = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map())
  const orgLoadedRef = useRef(false)
  const orgSkipSave  = useRef(true)
  const orgSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // uložené pohledy + prezentace
  const [flyView,     setFlyView]     = useState<CameraState | null>(null)
  const [flyNonce,    setFlyNonce]    = useState(0)
  const [presIndex,   setPresIndex]   = useState<number | null>(null)
  // index pohledu, jehož anotace jsou právě zobrazené (gate proti probliknutí při skoku šipkou)
  const [presAnnShownIdx, setPresAnnShownIdx] = useState<number | null>(null)
  const presStepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingStepRef = useRef(0)
  const flySpeedRef = useRef(flySpeed)
  const takeFnRef      = useRef<(() => void) | null>(null)
  const cameraSaveRef  = useRef<(() => CameraSaveResult) | null>(null)
  const meshMapRef     = useRef<Map<string, THREE.Mesh>>(new Map())
  const [modelRoot, setModelRoot] = useState<THREE.Object3D | null>(null)
  const cameraCommandRef = useRef<((v: string) => void) | null>(null)
  const boundsRef        = useRef<THREE.Box3 | null>(null)
  const colorSaveTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const annColorTimer    = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queryClient      = useQueryClient()

  const { data: savedColors = [] } = useQuery({
    queryKey: ['model_object_colors', modelId],
    queryFn: () => adapter.fetchObjectColors(modelId),
  })

  const { data: savedVeg } = useQuery({
    queryKey: ['model_vegetation', modelId],
    queryFn: () => adapter.fetchVegetation(modelId),
    refetchOnMount: 'always',
    staleTime: 0,
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
    if (!canEdit) return
    setVegSaved(false)
    clearTimeout(vegSaveTimer.current)
    vegSaveTimer.current = setTimeout(async () => {
      const r = (n: number, d: number) => Math.round(n * d) / d
      const compact = vegGroups.map(g => {
        if (g.type === 'grass' && g.seed !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { instances: _i, ...rest } = g
          return { ...rest, instances: [] }
        }
        return {
          ...g,
          instances: g.instances.map(v => ({
            x: r(v.x, 1000), y: r(v.y, 1000), z: r(v.z, 1000),
            ry: r(v.ry, 100), s: r(v.s, 100),
            rx: v.rx !== undefined ? r(v.rx, 100) : undefined,
            rz: v.rz !== undefined ? r(v.rz, 100) : undefined,
          })),
        }
      })
      try {
        await adapter.saveVegetation(modelId, compact)
        queryClient.setQueryData(['model_vegetation', modelId], compact)
        setVegSaved(true)
      } catch (e: unknown) {
        toast.error('Vegetaci se nepodařilo uložit: ' + (e instanceof Error ? e.message : String(e)))
      }
    }, 1500)
    return () => clearTimeout(vegSaveTimer.current)
  }, [vegGroups]) // eslint-disable-line react-hooks/exhaustive-deps

  // Regenerate seeded grass after model meshes are loaded
  useEffect(() => {
    if (!meshesLoaded) return
    const seeded = vegGroups.filter(g => g.type === 'grass' && g.seed !== undefined && g.instances.length === 0)
    if (!seeded.length) return
    vegSkipSave.current = true
    setVegGroups(prev => prev.map(g => {
      if (g.type !== 'grass' || g.seed === undefined || g.instances.length > 0) return g
      const mesh = [...meshMapRef.current.values()].find(m => m.name === g.targetName)
      if (!mesh) return g
      return { ...g, instances: scatterOnMesh(mesh, g.count ?? 2000, g.patched ?? true, mulberry32(g.seed!)) }
    }))
  }, [meshesLoaded, vegGroups]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: annotations = [], refetch: refetchAnnotations } = useQuery({
    queryKey: ['model_annotations', modelId],
    queryFn: () => adapter.fetchAnnotations(modelId),
  })

  const { data: sceneOrg } = useQuery({
    queryKey: ['model_scene_org', modelId],
    queryFn: () => adapter.fetchSceneOrg(modelId),
    refetchOnMount: 'always',
    staleTime: 0,
  })

  useEffect(() => {
    if (sceneOrg && !orgLoadedRef.current) {
      orgLoadedRef.current = true
      orgSkipSave.current = true
      setRenames(sceneOrg.renames ?? {})
      setLayers(sceneOrg.layers ?? [])
      setObjMaterials(sceneOrg.materials ?? {})
      const s = sceneOrg.settings
      if (s) {
        if (s.env) setEnvMode(s.env)
        if (s.skyPreset) setSkyPreset(s.skyPreset)
        if (s.skyRotation !== undefined) setSkyRotation(s.skyRotation)
        if (s.ground !== undefined) setGroundOn(s.ground)
        if (s.groundY !== undefined) setGroundY(s.groundY)
        if (s.fx !== undefined) setBloomOn(s.fx)
        if (s.toneMapping) setToneMap(s.toneMapping)
        if (s.exposure !== undefined) setExposure(s.exposure)
        if (s.shadowSoftness !== undefined) setShadowSoft(s.shadowSoftness)
      }
    }
  }, [sceneOrg]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (orgSkipSave.current) { orgSkipSave.current = false; return }
    if (!canEdit) return
    clearTimeout(orgSaveTimer.current)
    orgSaveTimer.current = setTimeout(async () => {
      const org: SceneOrg = { renames, layers, materials: objMaterials, settings: { env: envMode, skyPreset, skyRotation, ground: groundOn, groundY, fx: bloomOn, toneMapping: toneMap, exposure, shadowSoftness: shadowSoft } }
      try {
        await adapter.saveSceneOrg(modelId, org)
        queryClient.setQueryData(['model_scene_org', modelId], org)
      } catch (e: unknown) {
        toast.error('Nastavení scény se nepodařilo uložit: ' + (e instanceof Error ? e.message : String(e)))
      }
    }, 1200)
    return () => clearTimeout(orgSaveTimer.current)
  }, [renames, layers, objMaterials, envMode, skyPreset, skyRotation, groundOn, groundY, bloomOn, toneMap, exposure, shadowSoft]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: views = [], refetch: refetchViews } = useQuery({
    queryKey: ['model_views', modelId],
    queryFn: () => adapter.fetchViews(modelId),
  })

  const { data: materialsLib = [], isFetched: materialsFetched, refetch: refetchMaterials } = useQuery({
    queryKey: ['viewer_materials'],
    queryFn: () => adapter.fetchMaterials(),
  })

  // jednorázový seed výchozího skla — po smazání uživatelem se znovu nevnucuje
  const glassSeededRef = useRef(false)
  useEffect(() => {
    if (!materialsFetched || !canEdit || glassSeededRef.current) return
    if (localStorage.getItem('viewer_glass_seeded_v1')) return
    glassSeededRef.current = true
    localStorage.setItem('viewer_glass_seeded_v1', '1')
    if (materialsLib.some(m => m.id === DEFAULT_GLASS.id)) return
    adapter.saveMaterial(DEFAULT_GLASS).then(() => refetchMaterials()).catch(() => {})
  }, [materialsFetched, materialsLib, canEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  // aplikace materiálů na meshe — při změně přiřazení, knihovny nebo po načtení modelu
  useEffect(() => {
    if (!meshesLoaded) return
    let cancelled = false
    const lib = new Map(materialsLib.map(m => [m.id, m]))
    meshMapRef.current.forEach(mesh => {
      const asg = mesh.name ? objMaterials[mesh.name] : undefined
      if ((!asg || !lib.has(asg.materialId)) && originalMatsRef.current.has(mesh.uuid)) {
        mesh.material = originalMatsRef.current.get(mesh.uuid)!
        originalMatsRef.current.delete(mesh.uuid)
      }
    })
    Object.entries(objMaterials).forEach(([objName, asg]) => {
      const def = lib.get(asg.materialId)
      if (!def) return
      meshMapRef.current.forEach(mesh => {
        if (mesh.name !== objName) return
        if (!originalMatsRef.current.has(mesh.uuid)) originalMatsRef.current.set(mesh.uuid, mesh.material)
        applyBoxUV(mesh, asg)
        getMaterialInstance(def, adapter).then(mat => {
          if (!cancelled && objMaterials[objName]?.materialId === asg.materialId) mesh.material = mat
        })
      })
    })
    return () => { cancelled = true }
  }, [objMaterials, materialsLib, meshesLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        if (addPinFor) { setAddPinFor(null); return }
        if (pendingPin) { setPendingPin(null); return }
        if (annotationMode) { setAnnotationMode(false); return }
        if (presIndex !== null) { endPresentation(); return }
        handleClose()
      }
      if (e.key === 'p' || e.key === 'P') {
        if (pendingPin) return
        setAnnotationMode(a => !a)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, pendingPin, annotationMode, presIndex, addPinFor])

  function handleClose() {
    const result = cameraSaveRef.current?.()
    onClose()
    if (result) adapter.onViewerClosed?.(modelId, result)
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
    if (!selectedMesh.name || !canEdit) return
    clearTimeout(colorSaveTimer.current)
    colorSaveTimer.current = setTimeout(() => {
      adapter.saveObjectColor(modelId, selectedMesh.name, hex).catch(() => { /* tichá chyba, jako dřív */ })
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
    setPendingObjectName(objectName ? (renames[objectName] || objectName) : '')
    setAnnotationMode(false)
  }

  async function handleAnnotationSave() {
    if (!pendingPin || !pendingText.trim() || !canEdit) return
    try {
      await adapter.createAnnotation(modelId, {
        x: pendingPin.x, y: pendingPin.y, z: pendingPin.z,
        text: pendingText.trim(), object_name: pendingObjectName || null,
      })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Poznámku se nepodařilo uložit')
      return
    }
    setPendingPin(null); setPendingText('')
    refetchAnnotations()
  }

  async function handleAnnotationDelete(id: string) {
    if (!await confirm({ message: 'Smazat poznámku?', confirmLabel: 'Smazat', variant: 'danger' })) return
    try {
      await adapter.deleteAnnotation(modelId, id)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Poznámku se nepodařilo smazat')
      return
    }
    refetchAnnotations()
  }

  async function handleMoveAnnotationBox(id: string, offsetX: number, offsetY: number) {
    queryClient.setQueryData(['model_annotations', modelId], (old: typeof annotations = []) =>
      old.map(a => a.id === id ? { ...a, offsetX, offsetY } : a))
    try {
      await adapter.updateAnnotationOffset(modelId, id, offsetX, offsetY)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Pozici poznámky se nepodařilo uložit')
    }
  }

  function handleColorAnnotation(id: string, color: string) {
    // živý náhled hned, zápis do úložiště s odstupem (color picker spamuje onChange)
    queryClient.setQueryData(['model_annotations', modelId], (old: typeof annotations = []) =>
      old.map(a => a.id === id ? { ...a, color } : a))
    clearTimeout(annColorTimer.current)
    annColorTimer.current = setTimeout(() => {
      adapter.updateAnnotationColor(modelId, id, color).catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : 'Barvu poznámky se nepodařilo uložit'))
    }, 500)
  }

  async function persistAnnotationPoints(id: string, points: { x: number; y: number; z: number }[]) {
    queryClient.setQueryData(['model_annotations', modelId], (old: typeof annotations = []) =>
      old.map(a => a.id === id ? { ...a, extraPoints: points } : a))
    try {
      await adapter.updateAnnotationPoints(modelId, id, points)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Body poznámky se nepodařilo uložit')
    }
  }

  function handleAddPin(pos: THREE.Vector3) {
    if (!addPinFor) return
    const ann = annotations.find(a => a.id === addPinFor)
    if (!ann) return
    persistAnnotationPoints(addPinFor, [...(ann.extraPoints ?? []), { x: pos.x, y: pos.y, z: pos.z }])
    // režim necháme aktivní — můžeš naklikat víc bodů; Esc nebo tlačítko ho ukončí
  }

  function handleRemovePin(id: string, index: number) {
    const ann = annotations.find(a => a.id === id)
    if (!ann) return
    persistAnnotationPoints(id, (ann.extraPoints ?? []).filter((_, i) => i !== index))
  }

  function handleSow() {
    if (!selectedMesh) return
    const count = vegType === 'grass' ? grassCount : VEG_CFG[vegType].count
    if (vegType === 'grass') {
      const seed = Math.floor(Math.random() * 2 ** 32)
      const instances = scatterOnMesh(selectedMesh, count, grassPatched, mulberry32(seed))
      if (!instances.length) { toast.error('Nepodařilo se umístit vegetaci'); return }
      setVegGroups(prev => [...prev, {
        id: crypto.randomUUID(),
        type: 'grass',
        targetName: selectedMesh.name,
        scaleMult: vegScale,
        instances,
        mode: 'scatter' as const,
        seed,
        count,
        patched: grassPatched,
      }])
    } else {
      const instances = scatterOnMesh(selectedMesh, count, false)
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

  // ── Přejmenování a vrstvy ──────────────────────────────────
  const displayName = (n: string) => renames[n] || n
  const layeredNames = new Set(layers.flatMap(l => l.members))

  // pořadí řádků tak, jak jsou vidět v panelu (pro shift+klik výběr rozsahu)
  const orderedRows: SceneNode[] = []
  layers.forEach(l => { if (!collapsedLayers.has(l.id)) orderedRows.push(...nodes.filter(n => l.members.includes(n.name))) })
  orderedRows.push(...nodes.filter(n => !layeredNames.has(n.name)))
  const rowIndexById = new Map(orderedRows.map((n, i) => [n.id, i]))

  const lastCheckIndexRef = useRef<number | null>(null)
  const paintRef = useRef<{ value: boolean } | null>(null)

  useEffect(() => {
    const endPaint = () => { paintRef.current = null }
    window.addEventListener('pointerup', endPaint)
    return () => window.removeEventListener('pointerup', endPaint)
  }, [])

  function setNamesChecked(names: string[], value: boolean) {
    setCheckedNames(prev => {
      const next = new Set(prev)
      names.forEach(n => { if (value) next.add(n); else next.delete(n) })
      return next
    })
  }

  function rangeNames(a: number, b: number) {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    return orderedRows.slice(lo, hi + 1).map(n => n.name)
  }

  function handleRangeOrToggle(node: SceneNode, shift: boolean) {
    const idx = rowIndexById.get(node.id) ?? null
    if (shift && lastCheckIndexRef.current !== null && idx !== null) {
      setNamesChecked(rangeNames(lastCheckIndexRef.current, idx), true)
    } else {
      setNamesChecked([node.name], !checkedNames.has(node.name))
    }
    lastCheckIndexRef.current = idx
  }

  function startRename(id: string, current: string) {
    setRenamingId(id)
    setRenameDraft(current)
    setAssignMenuId(null)
  }

  function commitRenameNode(node: SceneNode) {
    const v = renameDraft.trim()
    setRenames(prev => {
      const next = { ...prev }
      if (!v || v === node.name) delete next[node.name]
      else next[node.name] = v
      return next
    })
    setRenamingId(null)
  }

  function commitRenameLayer(layer: SceneLayer) {
    const v = renameDraft.trim()
    if (v) setLayers(prev => prev.map(l => l.id === layer.id ? { ...l, name: v } : l))
    setRenamingId(null)
  }

  function assignToLayer(names: string[], layerId: string | null) {
    const nameSet = new Set(names)
    setLayers(prev => {
      const cleaned = prev.map(l => ({ ...l, members: l.members.filter(m => !nameSet.has(m)) }))
      return layerId ? cleaned.map(l => l.id === layerId ? { ...l, members: [...l.members, ...names] } : l) : cleaned
    })
    setAssignMenuId(null)
    setBulkMenuOpen(false)
    setCheckedNames(new Set())
  }

  function createLayer(withNames: string[] = []) {
    const nameSet = new Set(withNames)
    setLayers(prev => [
      ...prev.map(l => ({ ...l, members: l.members.filter(m => !nameSet.has(m)) })),
      { id: crypto.randomUUID(), name: `Vrstva ${prev.length + 1}`, members: withNames },
    ])
    setAssignMenuId(null)
    setBulkMenuOpen(false)
    setCheckedNames(new Set())
  }

  function layerNodes(layer: SceneLayer) {
    return nodes.filter(n => layer.members.includes(n.name))
  }

  function toggleLayerVisibility(layer: SceneLayer) {
    const members = layerNodes(layer)
    const anyVisible = members.some(n => n.object.visible)
    members.forEach(n => { n.object.visible = !anyVisible })
    setHiddenIds(prev => {
      const next = new Set(prev)
      members.forEach(n => { if (anyVisible) next.add(n.id); else next.delete(n.id) })
      return next
    })
  }

  // ── Uložené pohledy + prezentace ───────────────────────────
  async function handleSaveView(name: string) {
    const cam = cameraSaveRef.current?.()
    if (!cam) return
    const view: SavedView = {
      id: crypto.randomUUID(),
      name: name || `Pohled ${views.length + 1}`,
      camera: cam.cameraState,
    }
    try {
      await adapter.createView(modelId, view)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Pohled se nepodařilo uložit')
      return
    }
    refetchViews()
  }

  async function handleDeleteView(id: string) {
    try {
      await adapter.deleteView(modelId, id)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Pohled se nepodařilo smazat')
      return
    }
    refetchViews()
  }

  async function handleRenameView(id: string, name: string) {
    queryClient.setQueryData(['model_views', modelId], (old: SavedView[] = []) =>
      old.map(x => x.id === id ? { ...x, name } : x))
    try {
      await adapter.renameView(modelId, id, name)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Přejmenování selhalo')
    }
    refetchViews()
  }

  async function handleUpdateViewCamera(v: SavedView) {
    const cam = cameraSaveRef.current?.()
    if (!cam) return
    queryClient.setQueryData(['model_views', modelId], (old: SavedView[] = []) =>
      old.map(x => x.id === v.id ? { ...x, camera: cam.cameraState } : x))
    try {
      await adapter.updateViewCamera(modelId, v.id, cam.cameraState)
      toast.success(`Pohled „${v.name}" aktualizován`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Aktualizace pohledu selhala')
    }
    refetchViews()
  }

  async function reorderViews(orderedIds: string[]) {
    const byId = new Map(views.map(v => [v.id, v]))
    const reordered = orderedIds.map(id => byId.get(id)).filter((v): v is SavedView => !!v)
    queryClient.setQueryData(['model_views', modelId], reordered)
    try {
      await adapter.reorderViews(modelId, orderedIds)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Přeřazení selhalo')
    }
    refetchViews()
  }

  async function toggleViewAnnotation(view: SavedView, annId: string) {
    const current = view.annotationIds ?? []
    const next = current.includes(annId) ? current.filter(id => id !== annId) : [...current, annId]
    queryClient.setQueryData(['model_views', modelId], (old: SavedView[] = []) =>
      old.map(v => v.id === view.id ? { ...v, annotationIds: next } : v))
    try {
      await adapter.updateViewAnnotations(modelId, view.id, next)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Uložení anotací pohledu selhalo')
    }
    refetchViews()
  }

  function goToView(view: SavedView) {
    setFlyView(view.camera)
    setFlyNonce(n => n + 1)
  }

  // ── Prezentace ─────────────────────────────────────────────
  function startPresentation() {
    // chrome plynule odjede, prezentace běží v okně (fullscreen si uživatel dá F11)
    setActivePanel(null)
    setPresIndex(0)
  }

  function endPresentation() {
    clearTimeout(presStepTimer.current)
    presStepTimer.current = undefined
    pendingStepRef.current = 0
    setPresIndex(null)
  }

  function presStep(dir: 1 | -1) {
    if (presIndex === null) return
    // anotace nech odmizet a kroky akumuluj — rychlé stisky = jeden plynulý přelet na cíl
    setPresAnnShownIdx(null)
    pendingStepRef.current += dir
    if (presStepTimer.current === undefined) {
      presStepTimer.current = setTimeout(() => {
        const step = pendingStepRef.current
        pendingStepRef.current = 0
        presStepTimer.current = undefined
        setPresIndex(i => i === null ? null : (((i + step) % views.length) + views.length) % views.length)
      }, 650)
    }
  }

  // šipkami během prezentace okamžitě přeskoč na další/předchozí přejezd
  useEffect(() => {
    if (presIndex === null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); presStep(1) }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); presStep(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presIndex, views.length])

  // prezentační krok: přelet → (po příletu) naskákání anotací → výdrž → odmizení → další pohled
  useEffect(() => {
    if (presIndex === null || views.length === 0) return
    const view = views[presIndex % views.length]
    const annCount = view.annotationIds?.length ?? 0
    const idx = presIndex
    setFlyView(view.camera)
    setFlyNonce(n => n + 1)
    setPresAnnShownIdx(null) // schované během přeletu

    const FLY = 2300                              // přílet kamery
    const SHOW = annCount ? annCount * 160 + 500 : 0   // doba naskákání (stagger)
    const HOLD = 3200 + SHOW                       // výdrž na anotacích
    const OUT = annCount ? 700 : 0                 // odmizení před odjezdem

    const tShow = setTimeout(() => setPresAnnShownIdx(idx), FLY)
    const tOut  = setTimeout(() => setPresAnnShownIdx(null), FLY + HOLD)
    const tNext = setTimeout(() => setPresIndex(i => i === null ? null : (i + 1) % views.length), FLY + HOLD + OUT + 300)
    return () => { clearTimeout(tShow); clearTimeout(tOut); clearTimeout(tNext) }
  }, [presIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // id anotací aktivního pohledu během prezentace (null = normální režim)
  const presViewAnnIds = presIndex !== null
    ? new Set(views[presIndex % views.length]?.annotationIds ?? [])
    : null

  // ── Materiály ──────────────────────────────────────────────
  async function handleSaveMaterial(def: MaterialDef) {
    try {
      await adapter.saveMaterial(def)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Materiál se nepodařilo uložit')
      return
    }
    refetchMaterials()
  }

  async function handleDeleteMaterial(id: string) {
    if (!await confirm({ message: 'Smazat materiál z knihovny? Odebere se ze všech objektů.', confirmLabel: 'Smazat', variant: 'danger' })) return
    try {
      await adapter.deleteMaterial(id)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Materiál se nepodařilo smazat')
      return
    }
    setObjMaterials(prev => Object.fromEntries(Object.entries(prev).filter(([, a]) => a.materialId !== id)))
    refetchMaterials()
  }

  const materialTargets = checkedNames.size > 0
    ? [...checkedNames]
    : selectedMesh?.name ? [selectedMesh.name] : []

  function handleAssignMaterial(materialId: string) {
    if (!materialTargets.length) return
    setObjMaterials(prev => {
      const next = { ...prev }
      materialTargets.forEach(nm => {
        next[nm] = prev[nm]?.materialId === materialId
          ? prev[nm]
          : { materialId, tileSize: 1, rotation: 0, offsetX: 0, offsetY: 0 }
      })
      return next
    })
    setCheckedNames(new Set())
  }

  const selectedAssignment = selectedMesh?.name ? objMaterials[selectedMesh.name] ?? null : null

  function handleUpdateAssignment(patch: Partial<MaterialAssignment>) {
    const nm = selectedMesh?.name
    if (!nm) return
    setObjMaterials(prev => prev[nm] ? { ...prev, [nm]: { ...prev[nm], ...patch } } : prev)
  }

  function handleRemoveAssignment() {
    const nm = selectedMesh?.name
    if (!nm) return
    setObjMaterials(prev => {
      const next = { ...prev }
      delete next[nm]
      return next
    })
  }

  function renderNodeRow(node: SceneNode, indent: number) {
    const hidden = hiddenIds.has(node.id)
    const isRenaming = renamingId === node.id
    const inLayer = layeredNames.has(node.name)
    return (
      <div
        key={node.id}
        style={{ paddingLeft: 12 + indent }}
        onClick={e => {
          if (canEdit && e.shiftKey) {
            e.preventDefault()
            handleRangeOrToggle(node, true)
            return
          }
          lastCheckIndexRef.current = rowIndexById.get(node.id) ?? lastCheckIndexRef.current
          const mesh = meshMapRef.current.get(node.id); if (mesh) handleMeshSelect(mesh)
        }}
        onPointerDown={e => {
          if (!canEdit || e.button !== 2) return
          e.preventDefault()
          const value = !checkedNames.has(node.name)
          paintRef.current = { value }
          setNamesChecked([node.name], value)
          lastCheckIndexRef.current = rowIndexById.get(node.id) ?? null
        }}
        onPointerEnter={() => {
          if (canEdit && paintRef.current) setNamesChecked([node.name], paintRef.current.value)
        }}
        onContextMenu={e => { if (canEdit) e.preventDefault() }}
        className={`relative flex items-center gap-1.5 pr-2 py-1 cursor-pointer transition-colors group/row select-none ${hidden ? 'opacity-40' : ''} ${
          node.id === selectedMesh?.uuid ? 'bg-indigo-900/40' : node.id === hoveredId ? 'bg-gray-800' : 'hover:bg-gray-800/50'
        }`}
      >
        {canEdit && (
          <input
            type="checkbox"
            checked={checkedNames.has(node.name)}
            onClick={e => { e.stopPropagation(); handleRangeOrToggle(node, e.shiftKey) }}
            onChange={() => {}}
            className={`w-3 h-3 accent-indigo-500 shrink-0 cursor-pointer transition-opacity ${checkedNames.size > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}
          />
        )}
        <button onClick={e => { e.stopPropagation(); toggleVisibility(node) }} className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors">
          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        {isRenaming ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={e => setRenameDraft(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') commitRenameNode(node); if (e.key === 'Escape') setRenamingId(null) }}
            onBlur={() => commitRenameNode(node)}
            className="flex-1 min-w-0 px-1 py-0 text-xs bg-gray-800 border border-indigo-500 rounded text-gray-100 focus:outline-none"
          />
        ) : (
          <span
            className="text-xs text-gray-300 truncate flex-1"
            title={renames[node.name] ? `${renames[node.name]} (${node.name})` : node.name}
            onDoubleClick={canEdit ? e => { e.stopPropagation(); startRename(node.id, displayName(node.name)) } : undefined}
          >
            {displayName(node.name)}
          </span>
        )}
        {canEdit && !isRenaming && (
          <div className="hidden group-hover/row:flex items-center gap-1 shrink-0">
            <button onClick={e => { e.stopPropagation(); startRename(node.id, displayName(node.name)) }} title="Přejmenovat" className="text-gray-600 hover:text-gray-300 transition-colors"><Pencil size={11} /></button>
            <button onClick={e => { e.stopPropagation(); setAssignMenuId(assignMenuId === node.id ? null : node.id) }} title="Přesunout do vrstvy" className="text-gray-600 hover:text-indigo-400 transition-colors"><FolderInput size={11} /></button>
          </div>
        )}
        {assignMenuId === node.id && (
          <div className="absolute right-1 top-6 z-30 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 w-40" onClick={e => e.stopPropagation()}>
            <p className="px-2.5 pb-0.5 text-[10px] text-gray-500 uppercase tracking-wider">Do vrstvy</p>
            {layers.map(l => (
              <button key={l.id} onClick={() => assignToLayer([node.name], l.id)}
                className="w-full text-left px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 transition-colors">
                {l.name}
              </button>
            ))}
            {inLayer && (
              <button onClick={() => assignToLayer([node.name], null)} className="w-full text-left px-2.5 py-1 text-xs text-gray-400 hover:bg-gray-700 transition-colors">
                Bez vrstvy
              </button>
            )}
            <button onClick={() => createLayer([node.name])} className="w-full text-left px-2.5 py-1 text-xs text-indigo-400 hover:bg-gray-700 transition-colors">
              + Nová vrstva
            </button>
          </div>
        )}
      </div>
    )
  }

  // prezentace = čistá plocha: chrome plynule odjede a canvas se roztáhne
  const presenting = presIndex !== null

  return createPortal(
    <div className="fixed inset-0 z-9999 flex flex-col" style={{ background: '#030712' }}>
      {/* Header */}
      <div className={`relative z-10 flex items-center justify-between px-4 bg-gray-900 border-b border-gray-800 shrink-0 overflow-hidden transition-all duration-700 ease-in-out ${presenting ? 'max-h-0 py-0 opacity-0 border-transparent pointer-events-none' : 'max-h-20 py-3 opacity-100'}`}>
        <span className="text-sm font-medium text-gray-100 truncate flex-1 min-w-0 mr-3">{name}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          {annotations.length > 0 && (
            <button
              onClick={() => setAnnotationsVisible(v => !v)}
              title={annotationsVisible ? 'Skrýt poznámky' : 'Zobrazit poznámky'}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${annotationsVisible ? 'text-gray-400 hover:text-white hover:bg-gray-800' : 'bg-gray-700 text-gray-400'}`}
            >
              {annotationsVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              <span className="hidden lg:inline">Poznámky</span>
            </button>
          )}
          <button
            onClick={() => { setAnnotationMode(a => !a); setPendingPin(null) }}
            title="Přidat poznámku (P)"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${annotationMode ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <MessageSquarePlus size={14} />
            <span className="hidden lg:inline">Poznámka <span style={{ opacity: 0.6, fontSize: 10 }}>(P)</span></span>
          </button>
          <button
            onClick={() => setMeasureMode(m => !m)}
            title="Měřicí nástroj — klikni 2 body na modelu"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${measureMode ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Ruler size={14} />
            <span className="hidden lg:inline">Měřit</span>
          </button>
          <button
            onClick={() => takeFnRef.current?.()}
            title="Uložit screenshot"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <Camera size={14} />
            <span className="hidden lg:inline">Screenshot</span>
          </button>
          <div className="w-px h-5 bg-gray-700 mx-1 self-center" />
          <button
            onClick={() => setActivePanel(p => p === 'veg' ? null : 'veg')}
            title="Vegetace"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activePanel === 'veg' ? 'bg-green-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Leaf size={14} />
            <span className="hidden lg:inline">Vegetace</span>
          </button>
          <button
            onClick={() => setActivePanel(p => p === 'materials' ? null : 'materials')}
            title="Materiály — PBR knihovna a texturování"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activePanel === 'materials' ? 'bg-purple-700 text-white' : Object.keys(objMaterials).length ? 'text-purple-400 hover:text-white hover:bg-gray-800' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Palette size={14} />
            <span className="hidden lg:inline">Materiály</span>
          </button>
          <button
            onClick={() => setActivePanel(p => p === 'env' ? null : 'env')}
            title="Prostředí — obloha, slunce, země, efekty"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activePanel === 'env' ? 'bg-sky-700 text-white' : envMode === 'sun' || groundOn || bloomOn ? 'text-sky-400 hover:text-white hover:bg-gray-800' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Sun size={14} />
            <span className="hidden lg:inline">Prostředí</span>
          </button>
          <button
            onClick={() => {
              setActivePanel(p => {
                if (p === 'section') return null
                if (!sectionOn) setSectionOn(true)
                return 'section'
              })
            }}
            title="Řez modelem"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activePanel === 'section' ? 'bg-orange-700 text-white' : sectionOn ? 'text-orange-400 hover:text-white hover:bg-gray-800' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Crop size={14} />
            <span className="hidden lg:inline">Řez</span>
          </button>
          <div className="w-px h-5 bg-gray-700 mx-1 self-center" />
          <button
            onClick={() => setActivePanel(p => p === 'views' ? null : 'views')}
            title="Uložené pohledy a prezentace"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activePanel === 'views' ? 'bg-indigo-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <Bookmark size={14} />
            <span className="hidden lg:inline">Pohledy</span>
          </button>
          <button
            onClick={() => setPanelOpen(o => !o)}
            title="Scéna"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${panelOpen ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <PanelRight size={14} />
            <span className="hidden lg:inline">Scéna</span>
          </button>
          <div className="w-px h-5 bg-gray-700 mx-1 self-center" />
          <button onClick={handleClose} title="Zavřít prohlížeč" className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-w-0" />
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas overlays (3D plátno je samostatná stabilní vrstva níž, ať se neresizuje) */}
        <div className="flex-1 relative">
          <Canvas
            shadows
            camera={{ position: [9999, 9999, 9999], fov: 45, near: 0.001, far: 1_000_000 }}
            gl={{ preserveDrawingBuffer: true }}
            onPointerMissed={clearSelection}
            style={{ position: 'fixed', inset: 0, zIndex: 0, cursor: annotationMode || measureMode || addPinFor ? 'crosshair' : (activePanel === 'veg' && vegPlaceMode === 'click' && vegType !== 'grass') ? 'cell' : 'default' }}
          >
            {envMode === 'studio' ? (
              <>
                <StudioLights boundsRef={boundsRef} shadows={groundOn} shadowRadius={shadowSoft / 5} />
                <Environment preset="city" />
              </>
            ) : (
              <HdriSky preset={skyPreset} rotation={skyRotation} boundsRef={boundsRef} shadowRadius={shadowSoft / 5} />
            )}
            <Suspense fallback={<Loader />}>
              <ModelWithReveal
                url={url}
                wireframe={wireframe}
                wireframeOnly={wireframeOnly}
                wireframeColor={wireframeColor}
                wireframeMode={wireframeMode}
                selectedUuid={selectedMesh?.uuid ?? null}
                annotationMode={annotationMode}
                vegClickPlace={activePanel === 'veg' && vegPlaceMode === 'click' && vegType !== 'grass'}
                addPinMode={!!addPinFor}
                boundsRef={boundsRef}
                onReady={setNodes}
                onSceneReady={setModelRoot}
                onMeshMap={map => {
                  meshMapRef.current = map
                  setMeshesLoaded(true)
                  savedColors.forEach(sc => {
                    map.forEach(mesh => { if (mesh.name === sc.object_name) applyColor(mesh, sc.color) })
                  })
                }}
                onHover={setHoveredId}
                onSelect={handleMeshSelect}
                onAnnotationPlace={handleAnnotationPlace}
                onVegPlace={handleVegPlace}
                onAddPin={handleAddPin}
              />
            </Suspense>
            <AnnotationMarkers
              annotations={annotations}
              onDelete={handleAnnotationDelete}
              canDelete={canEdit && !presenting}
              visible={presenting ? presAnnShownIdx === presIndex : annotationsVisible}
              hiddenIds={hiddenAnnotationIds}
              forceIds={presViewAnnIds}
              stagger={presenting}
              onMoveBox={handleMoveAnnotationBox}
              onAddPin={canEdit && !presenting ? (id => setAddPinFor(p => p === id ? null : id)) : undefined}
              onRemovePin={handleRemovePin}
              onColorChange={canEdit && !presenting ? handleColorAnnotation : undefined}
              onCreateTask={onCreateTask && !presenting ? onCreateTask : undefined}
            />
            <VegetationLayer groups={vegGroups} />
            {groundOn && <GroundPlane boundsRef={boundsRef} offsetY={groundY} />}
            <SectionPlane active={sectionOn} axis={sectionAxis} offset={sectionOffset} flip={sectionFlip} rotA={sectionRotA} rotB={sectionRotB} ghost={sectionGhost} modelRoot={modelRoot} showHelper={activePanel === 'section'} boundsRef={boundsRef} />
            <CameraFlyTo target={flyView} nonce={flyNonce} />
            <ToneMapping mode={toneMap} exposure={exposure} />
            <Effects bloom={bloomOn} />
            <CameraRig commandRef={cameraCommandRef} boundsRef={boundsRef} />
            <CameraNearFarSync />
            <FocusTarget disabled={flyMode || annotationMode || !!addPinFor || (activePanel === 'veg' && vegPlaceMode === 'click' && vegType !== 'grass')} />
            <FlyCamera speedRef={flySpeedRef} onFlyChange={setFlyMode} />
            <MeasureTool active={measureMode} apiRef={measureApiRef} onCount={setMeasureCount} />
            <FlyToAnnotation pos={focusAnnotationPos ?? null} boundsRef={boundsRef} />
            <ScreenshotCapture takeFnRef={takeFnRef} annotations={annotations} annotationsVisible={annotationsVisible} hiddenAnnotationIds={hiddenAnnotationIds} />
            <CameraPersist modelId={modelId} boundsRef={boundsRef} saveFnRef={cameraSaveRef} initialCameraState={initialCameraState ?? null} />
            {/* GizmoHelper necháváme namountovaný i během prezentace, ať se render pipeline
                (a tím AO/stíny) nepřepíná — kostku jen schováme přes visible */}
            <GizmoHelper alignment="bottom-right" margin={[panelOpen ? 300 : 72, 72]}>
              <group visible={!presenting}>
                <GizmoViewcube />
              </group>
            </GizmoHelper>
            <OrbitControls makeDefault zoomToCursor enableDamping dampingFactor={0.07} enabled={!flyMode} />
          </Canvas>

          {/* View preset buttons + fly speed */}
          <div className={`absolute bottom-12 left-3 flex flex-col gap-1 z-10 transition-all duration-700 ease-in-out ${presenting ? 'opacity-0 -translate-x-[120%] pointer-events-none' : 'opacity-100'}`}>
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
          {activePanel === 'veg' && (
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
                      <input type="range" min={200} max={200000} step={1000} value={grassCount}
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
                    {selectedMesh ? `Zasít na "${displayName(selectedMesh.name)}"` : 'Vyber objekt v modelu'}
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

          {/* Materials panel */}
          {activePanel === 'materials' && (
            <MaterialsPanel
              materials={materialsLib}
              adapter={adapter}
              canEdit={canEdit}
              targetLabel={
                checkedNames.size > 0
                  ? `výběr (${checkedNames.size})`
                  : selectedMesh?.name ? displayName(selectedMesh.name) : null
              }
              targetCount={materialTargets.length}
              selectedObjectLabel={selectedMesh?.name ? displayName(selectedMesh.name) : null}
              assignment={selectedAssignment}
              onSaveMaterial={handleSaveMaterial}
              onDeleteMaterial={handleDeleteMaterial}
              onAssign={handleAssignMaterial}
              onUpdateAssignment={handleUpdateAssignment}
              onRemoveAssignment={handleRemoveAssignment}
              onClose={() => setActivePanel(null)}
            />
          )}

          {/* Environment panel */}
          {activePanel === 'env' && (
            <div className="absolute top-3 left-3 z-10 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><Sun size={12} /> Prostředí</span>
                <button onClick={() => setActivePanel(null)} className="text-gray-600 hover:text-gray-300 transition-colors"><X size={12} /></button>
              </div>
              <div className="p-3 space-y-3">
                <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                  {([['studio', 'Studio'], ['sun', 'Venku']] as const).map(([m, label]) => (
                    <button key={m} onClick={() => setEnvMode(m)}
                      className={`flex-1 py-1 font-medium transition-colors ${envMode === m ? 'bg-sky-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                {envMode === 'sun' && (
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Obloha</p>
                    <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                      {([['morning', 'Ráno'], ['afternoon', 'Odpoledne'], ['evening', 'Večer']] as const).map(([p, label]) => (
                        <button key={p} onClick={() => setSkyPreset(p)}
                          className={`flex-1 py-1 font-medium transition-colors ${skyPreset === p ? 'bg-sky-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="flex justify-between mt-2 mb-1">
                      <p className="text-xs text-gray-500">Otočení oblohy</p>
                      <span className="text-xs text-gray-400">{Math.round(skyRotation)}°</span>
                    </div>
                    <input type="range" min={0} max={360} step={1} value={skyRotation}
                      onChange={e => setSkyRotation(Number(e.target.value))}
                      className="w-full accent-sky-500" />
                  </div>
                )}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={groundOn} onChange={e => setGroundOn(e.target.checked)} className="w-3.5 h-3.5 accent-sky-500" />
                  <span className="text-xs text-gray-400">Terén pod modelem</span>
                </label>
                {groundOn && (
                  <div>
                    <div className="flex justify-between mb-1">
                      <p className="text-xs text-gray-500">Výška terénu</p>
                      <button onClick={() => setGroundY(0)} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors" title="Vrátit na nejspodnější bod modelu">reset</button>
                    </div>
                    <input type="range" min={-1} max={1} step={0.005} value={groundY}
                      onChange={e => setGroundY(Number(e.target.value))}
                      className="w-full accent-sky-500" />
                  </div>
                )}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={bloomOn} onChange={e => setBloomOn(e.target.checked)} className="w-3.5 h-3.5 accent-sky-500" />
                  <span className="text-xs text-gray-400">Bloom (záře světel)</span>
                </label>
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500" title="PCSS — stín se rozmazává se vzdáleností od objektu">Měkkost stínů</p>
                    <span className="text-xs text-gray-400">{shadowSoft === 0 ? 'ostré' : shadowSoft}</span>
                  </div>
                  <input type="range" min={0} max={100} step={1} value={shadowSoft}
                    onChange={e => setShadowSoft(Number(e.target.value))}
                    className="w-full accent-sky-500" />
                </div>
                <div className="pt-2 border-t border-gray-800 space-y-2.5">
                  <div>
                    <p className="text-xs text-gray-500 mb-1" title="Způsob převodu HDR světla na barvy obrazovky">Tone mapping</p>
                    <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                      {([['agx', 'AgX'], ['aces', 'ACES'], ['neutral', 'Neutral']] as const).map(([m, label]) => (
                        <button key={m} onClick={() => setToneMap(m)}
                          className={`flex-1 py-1 font-medium transition-colors ${toneMap === m ? 'bg-sky-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <p className="text-xs text-gray-500">Expozice</p>
                      <div className="flex items-center gap-1.5">
                        {exposure !== 1 && (
                          <button onClick={() => setExposure(1)} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors">reset</button>
                        )}
                        <span className="text-xs text-gray-400">{exposure.toFixed(2)}</span>
                      </div>
                    </div>
                    <input type="range" min={0.2} max={2.5} step={0.05} value={exposure}
                      onChange={e => setExposure(Number(e.target.value))}
                      className="w-full accent-sky-500" />
                  </div>
                </div>
                <p className="text-[10px] text-gray-600 leading-relaxed">Venku = obloha a slunce se stíny. AgX = filmový look bez přepalů, Neutral = věrné barvy. Efekty mohou snížit FPS u velkých modelů.</p>
              </div>
            </div>
          )}

          {/* Section panel */}
          {activePanel === 'section' && (
            <div className="absolute top-3 left-3 z-10 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><Crop size={12} /> Řez modelem</span>
                <button onClick={() => setActivePanel(null)} className="text-gray-600 hover:text-gray-300 transition-colors"><X size={12} /></button>
              </div>
              <div className="p-3 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={sectionOn} onChange={e => setSectionOn(e.target.checked)} className="w-3.5 h-3.5 accent-orange-500" />
                  <span className="text-xs text-gray-400">Řez aktivní</span>
                </label>
                <div className="flex rounded-md overflow-hidden border border-gray-700 text-xs">
                  {(['x', 'y', 'z'] as const).map(a => (
                    <button key={a} onClick={() => setSectionAxis(a)}
                      className={`flex-1 py-1 font-medium uppercase transition-colors ${sectionAxis === a ? 'bg-orange-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                      {a}
                    </button>
                  ))}
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500">Pozice řezu</p>
                    <span className="text-xs text-gray-400">{Math.round(sectionOffset * 100)} %</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.005} value={sectionOffset}
                    onChange={e => setSectionOffset(Number(e.target.value))}
                    className="w-full accent-orange-500" />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500">Natočení A</p>
                    <span className="text-xs text-gray-400">{sectionRotA}°</span>
                  </div>
                  <input type="range" min={-80} max={80} step={1} value={sectionRotA}
                    onChange={e => setSectionRotA(Number(e.target.value))}
                    className="w-full accent-orange-500" />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500">Natočení B</p>
                    <span className="text-xs text-gray-400">{sectionRotB}°</span>
                  </div>
                  <input type="range" min={-80} max={80} step={1} value={sectionRotB}
                    onChange={e => setSectionRotB(Number(e.target.value))}
                    className="w-full accent-orange-500" />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={sectionFlip} onChange={e => setSectionFlip(e.target.checked)} className="w-3.5 h-3.5 accent-orange-500" />
                    <span className="text-xs text-gray-400">Otočit stranu</span>
                  </label>
                  {(sectionRotA !== 0 || sectionRotB !== 0) && (
                    <button onClick={() => { setSectionRotA(0); setSectionRotB(0) }} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors">reset rotace</button>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={sectionGhost} onChange={e => setSectionGhost(e.target.checked)} className="w-3.5 h-3.5 accent-orange-500" />
                  <span className="text-xs text-gray-400">Odříznutou část zobrazit průhledně</span>
                </label>
              </div>
            </div>
          )}

          {/* Pohledy + prezentace */}
          <ViewsPanel
            open={activePanel === 'views'}
            onClose={() => setActivePanel(null)}
            canEdit={canEdit}
            views={views}
            annotations={annotations}
            presIndex={presIndex}
            onSaveView={handleSaveView}
            onRenameView={handleRenameView}
            onDeleteView={handleDeleteView}
            onUpdateViewCamera={handleUpdateViewCamera}
            onReorder={reorderViews}
            onGoToView={goToView}
            onToggleViewAnnotation={toggleViewAnnotation}
            onStartPresentation={startPresentation}
            onStep={presStep}
            onEndPresentation={endPresentation}
          />

          {/* Measure control */}
          {(measureMode || measureCount > 0) && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-gray-900/95 backdrop-blur border border-orange-600/40 rounded-full px-3 py-1.5 shadow-lg pointer-events-auto">
              <span className="text-xs text-orange-300 font-medium flex items-center gap-1.5">
                <Ruler size={12} /> Měření{measureCount > 0 ? ` · ${measureCount}` : ''}
              </span>
              {measureMode && <span className="text-[10px] text-gray-500 hidden sm:inline">klikni 2 body</span>}
              {measureCount > 0 && (
                <>
                  <div className="w-px h-3.5 bg-gray-700" />
                  <button onClick={() => measureApiRef.current?.undo()} className="text-xs text-gray-400 hover:text-white transition-colors">Zpět</button>
                  <button onClick={() => measureApiRef.current?.reset()} className="text-xs text-red-400 hover:text-red-300 transition-colors">Vymazat</button>
                </>
              )}
            </div>
          )}

          {/* Annotation mode hint */}
          {annotationMode && !pendingPin && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-600/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
              Klikni na model pro umístění poznámky · Esc pro zrušení
            </div>
          )}

          {/* Add-pin mode hint */}
          {addPinFor && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-indigo-600/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
              Klikni na model pro přidání dalšího bodu k poznámce · klik na tečku ji odebere · Esc pro konec
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
              <span className="text-xs text-gray-300 font-medium max-w-32 truncate">{selectedMesh.name ? displayName(selectedMesh.name) : 'Objekt'}</span>
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
          <div className={`relative z-10 max-w-[75vw] bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 overflow-hidden transition-all duration-700 ease-in-out ${presenting ? 'w-0 opacity-0 translate-x-full border-transparent pointer-events-none' : 'w-56 opacity-100'}`}>
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
              ) : (
                <>
                  {canEdit && checkedNames.size > 0 && (
                    <div className="sticky top-0 z-20 mx-2 mb-1 px-2 py-1.5 bg-indigo-950/95 backdrop-blur border border-indigo-800 rounded-lg flex items-center gap-1.5">
                      <span className="text-xs text-indigo-300 flex-1">{checkedNames.size} vybráno</span>
                      <div className="relative">
                        <button onClick={() => setBulkMenuOpen(o => !o)}
                          className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-indigo-700 hover:bg-indigo-600 text-white rounded transition-colors">
                          <FolderInput size={11} /> Do vrstvy
                        </button>
                        {bulkMenuOpen && (
                          <div className="absolute right-0 top-6 z-30 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 w-40">
                            {layers.map(l => (
                              <button key={l.id} onClick={() => assignToLayer([...checkedNames], l.id)}
                                className="w-full text-left px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 transition-colors">
                                {l.name}
                              </button>
                            ))}
                            <button onClick={() => assignToLayer([...checkedNames], null)}
                              className="w-full text-left px-2.5 py-1 text-xs text-gray-400 hover:bg-gray-700 transition-colors">
                              Bez vrstvy
                            </button>
                            <button onClick={() => createLayer([...checkedNames])}
                              className="w-full text-left px-2.5 py-1 text-xs text-indigo-400 hover:bg-gray-700 transition-colors">
                              + Nová vrstva
                            </button>
                          </div>
                        )}
                      </div>
                      <button onClick={() => { setCheckedNames(new Set()); setBulkMenuOpen(false) }}
                        className="text-gray-500 hover:text-gray-300 transition-colors">
                        <X size={12} />
                      </button>
                    </div>
                  )}
                  {(layers.length > 0 || canEdit) && (
                    <div className="px-3 pt-1 pb-0.5 flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Vrstvy</span>
                      {canEdit && (
                        <button onClick={() => createLayer()} title="Nová vrstva" className="text-gray-500 hover:text-indigo-400 transition-colors">
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                  )}
                  {layers.length === 0 && canEdit && (
                    <p className="px-3 pb-1 text-[10px] text-gray-600">Výběr: checkbox, Shift+klik vybere rozsah, tažení pravým tlačítkem maluje výběr.</p>
                  )}
                  {layers.map(layer => {
                    const members = layerNodes(layer)
                    const collapsed = collapsedLayers.has(layer.id)
                    const allHidden = members.length > 0 && members.every(n => hiddenIds.has(n.id))
                    const isRenamingLayer = renamingId === `layer:${layer.id}`
                    return (
                      <div key={layer.id}>
                        <div className="flex items-center gap-1 px-3 py-1 group/layer">
                          <button
                            onClick={() => setCollapsedLayers(prev => {
                              const next = new Set(prev)
                              if (collapsed) next.delete(layer.id); else next.add(layer.id)
                              return next
                            })}
                            className="shrink-0 text-gray-600 hover:text-gray-300 transition-colors"
                          >
                            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          </button>
                          <button onClick={() => toggleLayerVisibility(layer)} className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors">
                            {allHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          {isRenamingLayer ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={e => setRenameDraft(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') commitRenameLayer(layer); if (e.key === 'Escape') setRenamingId(null) }}
                              onBlur={() => commitRenameLayer(layer)}
                              className="flex-1 min-w-0 px-1 py-0 text-xs bg-gray-800 border border-indigo-500 rounded text-gray-100 focus:outline-none"
                            />
                          ) : (
                            <span
                              className="text-xs font-medium text-indigo-300 truncate flex-1"
                              onDoubleClick={canEdit ? () => startRename(`layer:${layer.id}`, layer.name) : undefined}
                            >
                              {layer.name} <span className="text-gray-600 font-normal">({members.length})</span>
                            </span>
                          )}
                          {canEdit && !isRenamingLayer && (
                            <div className="hidden group-hover/layer:flex items-center gap-1 shrink-0">
                              <button onClick={() => startRename(`layer:${layer.id}`, layer.name)} title="Přejmenovat vrstvu" className="text-gray-600 hover:text-gray-300 transition-colors"><Pencil size={11} /></button>
                              <button onClick={() => setLayers(prev => prev.filter(l => l.id !== layer.id))} title="Zrušit vrstvu (objekty zůstanou)" className="text-gray-600 hover:text-red-400 transition-colors"><Trash2 size={11} /></button>
                            </div>
                          )}
                        </div>
                        {!collapsed && members.map(node => renderNodeRow(node, 14))}
                      </div>
                    )
                  })}
                  {layers.length > 0 && (
                    <div className="px-3 pt-2 pb-0.5">
                      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Model</span>
                    </div>
                  )}
                  {nodes.filter(n => !layeredNames.has(n.name)).map(node => renderNodeRow(node, indentPx(node.depth)))}
                </>
              )}
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
                        {canEdit && (
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
      <div className={`relative z-10 px-4 bg-gray-900 border-t border-gray-800 text-xs text-gray-500 shrink-0 text-center overflow-hidden transition-all duration-700 ease-in-out ${presenting ? 'max-h-0 py-0 opacity-0 border-transparent pointer-events-none' : 'max-h-12 py-2 opacity-100'}`}>
        Levé tlačítko: otočit · Pravé tlačítko: posunout · Kolečko: přiblížit
      </div>
    </div>,
    document.body
  )
}
