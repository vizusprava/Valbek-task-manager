import { useState, useRef, Suspense, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, useGLTF, Environment, Html, useProgress, GizmoHelper, GizmoViewcube } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { PageLayout } from '@/components/layout/PageLayout'
import { setBgModel } from '@/components/layout/BackgroundScene'
import { Upload, X, Box, Trash2, Grid3x3, Eye, EyeOff, Layers, PanelRight, MessageSquarePlus, Leaf, Camera, Ruler, Monitor, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelFile, ModelAnnotation, ModelObjectColor } from '@/lib/types'

const BUCKET = 'models'

interface SceneNode {
  id: string
  name: string
  type: string
  depth: number
  object: THREE.Object3D
}

function collectNodes(obj: THREE.Object3D, depth = 0): SceneNode[] {
  const nodes: SceneNode[] = []
  if (depth > 0 && obj.name) {
    nodes.push({ id: obj.uuid, name: obj.name, type: obj.type, depth, object: obj })
  }
  for (const child of obj.children) {
    nodes.push(...collectNodes(child, depth + 1))
  }
  return nodes
}

async function generateThumbnail(file: File): Promise<Blob> {
  const W = 480, H = 320
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(W, H)
  renderer.setPixelRatio(1)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#111827')

  const ambient = new THREE.AmbientLight(0xffffff, 0.7)
  scene.add(ambient)
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
  dirLight.position.set(5, 10, 7)
  scene.add(dirLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
  fillLight.position.set(-5, -3, -5)
  scene.add(fillLight)

  const camera = new THREE.PerspectiveCamera(45, W / H, 0.001, 10000)

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const loader = new GLTFLoader()
    loader.load(url, (gltf) => {
      scene.add(gltf.scene)

      const box = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.6

      camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist)
      camera.lookAt(center)
      camera.near = dist / 100
      camera.far = dist * 10
      camera.updateProjectionMatrix()

      renderer.render(scene, camera)

      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url)
        renderer.dispose()
        if (blob) resolve(blob)
        else reject(new Error('canvas.toBlob failed'))
      }, 'image/jpeg', 0.88)
    }, undefined, (err) => {
      URL.revokeObjectURL(url)
      renderer.dispose()
      reject(err)
    })
  })
}

// ── Model + wireframe overlay + reveal animation ──────────────

function setMeshGlow(mesh: THREE.Mesh, level: 0 | 1 | 2) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  mats.forEach(m => {
    if (!m || !('emissive' in m)) return
    const sm = m as THREE.MeshStandardMaterial
    if (level === 0) sm.emissive.setRGB(0, 0, 0)
    else if (level === 1) sm.emissive.setRGB(0.07, 0.07, 0.07)   // hover: subtle white
    else sm.emissive.setRGB(0.12, 0.10, 0.02)                    // selected: warm gold
  })
}

interface ModelProps {
  url: string
  wireframe: boolean
  wireframeOnly: boolean
  wireframeColor: string
  wireframeMode: 'wireframe' | 'edges'
  selectedUuid: string | null
  annotationMode: boolean
  vegClickPlace: boolean
  boundsRef: { current: THREE.Box3 | null }
  onReady: (nodes: SceneNode[]) => void
  onMeshMap: (map: Map<string, THREE.Mesh>) => void
  onHover: (uuid: string | null) => void
  onSelect: (mesh: THREE.Mesh) => void
  onAnnotationPlace: (pos: THREE.Vector3, objectName: string) => void
  onVegPlace: (pos: THREE.Vector3) => void
}

function ModelWithReveal({ url, wireframe, wireframeOnly, wireframeColor, wireframeMode, selectedUuid, annotationMode, vegClickPlace, boundsRef, onReady, onMeshMap, onHover, onSelect, onAnnotationPlace, onVegPlace }: ModelProps) {
  const { scene } = useGLTF(url)
  const { camera, controls, gl } = useThree()
  const bounds           = useMemo(() => new THREE.Box3().setFromObject(scene), [scene])
  const startRef         = useRef(performance.now())
  const solidMats        = useRef<THREE.Material[]>([])
  const wireMats         = useRef<THREE.LineBasicMaterial[]>([])
  const edgeMats         = useRef<THREE.LineBasicMaterial[]>([])
  const meshMapRef       = useRef<Map<string, THREE.Mesh>>(new Map())
  const hoveredMeshRef   = useRef<THREE.Mesh | null>(null)
  const isControllingRef = useRef(false)
  const selectedUuidRef  = useRef(selectedUuid)

  // Keep selectedUuidRef in sync so control-end cleanup can read current value
  useEffect(() => { selectedUuidRef.current = selectedUuid }, [selectedUuid])

  // Suppress hover while user is orbiting / panning / zooming
  useEffect(() => {
    const canvas = gl.domElement
    let wheelTimer: ReturnType<typeof setTimeout>

    const clearHover = () => {
      if (hoveredMeshRef.current) {
        setMeshGlow(hoveredMeshRef.current, 0)
        hoveredMeshRef.current = null
        onHover(null)
      }
    }

    const onDown  = () => { isControllingRef.current = true }
    const onUp    = () => { isControllingRef.current = false; clearHover() }
    const onWheel = () => {
      isControllingRef.current = true
      clearHover()
      clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => { isControllingRef.current = false }, 200)
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mouseup',   onUp)
    canvas.addEventListener('wheel',     onWheel)
    return () => {
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mouseup',   onUp)
      canvas.removeEventListener('wheel',     onWheel)
      clearTimeout(wheelTimer)
    }
  }, [gl, onHover])

  // Camera fit
  useEffect(() => {
    const center = bounds.getCenter(new THREE.Vector3())
    const size   = bounds.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    const cam    = camera as THREE.PerspectiveCamera
    const dist   = (maxDim / (2 * Math.tan((cam.fov * Math.PI) / 360))) * 1.6
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.45, center.z + dist * 0.85)
    camera.lookAt(center)
    cam.near = Math.max(dist / 1000, 0.001)
    cam.far  = dist * 25
    cam.updateProjectionMatrix()
    boundsRef.current = bounds
    if (controls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctrl = controls as any
      ctrl.target.copy(center); ctrl.update()
    }
  }, [bounds, camera, controls])

  // Setup materials + both wire/edge overlays on mount
  useEffect(() => {
    startRef.current = performance.now()
    const sMats: THREE.Material[]          = []
    const wMats: THREE.LineBasicMaterial[] = []
    const eMats: THREE.LineBasicMaterial[] = []

    const meshMap = new Map<string, THREE.Mesh>()
    scene.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return
      meshMap.set(child.uuid, child)
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach(m => { if (m) { m.transparent = true; m.opacity = 0; m.side = THREE.DoubleSide } })
      sMats.push(...mats.filter(Boolean))

      const makeLines = (geo: THREE.BufferGeometry) => {
        const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(wireframeColor), transparent: true, opacity: 0, depthTest: false })
        const ls  = new THREE.LineSegments(geo, mat)
        ls.raycast = () => {}   // prevent lines from intercepting pointer events
        child.add(ls)
        return mat
      }

      try { wMats.push(makeLines(new THREE.WireframeGeometry(child.geometry))) } catch { /* skip */ }
      try { eMats.push(makeLines(new THREE.EdgesGeometry(child.geometry, 15)))  } catch { /* skip */ }
    })

    solidMats.current = sMats
    wireMats.current  = wMats
    edgeMats.current  = eMats
    meshMapRef.current = meshMap
    onMeshMap(meshMap)
    onReady(collectNodes(scene))

    return () => {
      scene.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.children.filter(c => c instanceof THREE.LineSegments).forEach(ls => {
            (ls as THREE.LineSegments).geometry.dispose()
            ;((ls as THREE.LineSegments).material as THREE.LineBasicMaterial).dispose()
            child.remove(ls)
          })
        }
      })
      solidMats.current = []; wireMats.current = []; edgeMats.current = []
    }
  }, [scene]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync wireframe color to both sets
  useEffect(() => {
    wireMats.current.forEach(m => m.color.set(wireframeColor))
    edgeMats.current.forEach(m => m.color.set(wireframeColor))
  }, [wireframeColor])

  // Apply selected glow when selectedUuid changes
  useEffect(() => {
    meshMapRef.current.forEach((mesh, uuid) => {
      const isHov = mesh === hoveredMeshRef.current
      if (uuid === selectedUuid) setMeshGlow(mesh, 0)
      else setMeshGlow(mesh, isHov ? 1 : 0)
    })
  }, [selectedUuid])

  // Animation (total 4s) + post-animation state
  // Phase 1 (0–0.6s):  active lines fade in,  model invisible
  // Phase 2 (0.6–2.4s): model fades in,        lines stay
  // Phase 3 (2.4–4.0s): lines fade out
  // After: follows wireframe / wireframeOnly / wireframeMode state
  useFrame(() => {
    const el = performance.now() - startRef.current
    const P1 = 500, P2 = 1000, P3 = 1200, TOTAL = P1 + P2 + P3

    let lineO: number, modelO: number

    if (el < P1) {
      lineO = el / P1; modelO = 0
    } else if (el < P1 + P2) {
      lineO = 1; modelO = (el - P1) / P2
    } else if (el < TOTAL) {
      lineO = 1 - (el - P1 - P2) / P3; modelO = 1
    } else {
      lineO  = wireframe ? 1 : 0
      modelO = wireframeOnly ? 0 : 1
    }

    const activeMats   = wireframeMode === 'wireframe' ? wireMats.current : edgeMats.current
    const inactiveMats = wireframeMode === 'wireframe' ? edgeMats.current : wireMats.current

    solidMats.current.forEach(m  => { m.opacity = modelO })
    activeMats.forEach(m         => { m.opacity = lineO  })
    inactiveMats.forEach(m       => { m.opacity = 0      })
  })

  return (
    <primitive
      object={scene}
      onPointerOver={(e: { object: THREE.Object3D; stopPropagation: () => void }) => {
        e.stopPropagation()
        if (isControllingRef.current) return
        const mesh = e.object as THREE.Mesh
        if (!(mesh instanceof THREE.Mesh)) return
        if (hoveredMeshRef.current && hoveredMeshRef.current !== mesh)
          setMeshGlow(hoveredMeshRef.current, 0)
        hoveredMeshRef.current = mesh
        onHover(mesh.uuid)
        setMeshGlow(mesh, 1)
      }}
      onPointerOut={(e: { object: THREE.Object3D; stopPropagation: () => void }) => {
        e.stopPropagation()
        const mesh = e.object as THREE.Mesh
        if (!(mesh instanceof THREE.Mesh)) return
        setMeshGlow(mesh, 0)
        if (hoveredMeshRef.current === mesh) { hoveredMeshRef.current = null; onHover(null) }
      }}
      onClick={(e: { object: THREE.Object3D; stopPropagation: () => void; point: THREE.Vector3 }) => {
        e.stopPropagation()
        if (annotationMode) { onAnnotationPlace(e.point.clone(), e.object.name || ''); return }
        if (vegClickPlace) { onVegPlace(e.point.clone()); return }
        const mesh = e.object as THREE.Mesh
        if (mesh instanceof THREE.Mesh) onSelect(mesh)
      }}
    />
  )
}

function Loader() {
  const { progress } = useProgress()
  return (
    <Html center>
      <div style={{ textAlign: 'center', color: 'white' }}>
        <div style={{ width: 32, height: 32, border: '3px solid #6366f1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
        <p style={{ fontSize: 12, marginTop: 8, color: '#9ca3af' }}>{Math.round(progress)}%</p>
      </div>
    </Html>
  )
}

// ── Dynamic near/far clipping ─────────────────────────────────

function CameraNearFarSync() {
  const { camera, controls } = useThree()
  useFrame(() => {
    if (!controls) return
    const dist = camera.position.distanceTo((controls as any).target)
    const cam  = camera as THREE.PerspectiveCamera
    const near = Math.max(dist * 0.0005, 0.001)
    const far  = Math.max(dist * 1000, 100)
    if (Math.abs(cam.near - near) / near > 0.05) {
      cam.near = near; cam.far = far; cam.updateProjectionMatrix()
    }
  })
  return null
}

// ── Double-click to set orbit focus ──────────────────────────

function FocusTarget({ disabled }: { disabled: boolean }) {
  const { camera, controls, gl, scene } = useThree()
  const disabledRef = useRef(disabled)
  const controlsRef = useRef<any>(null)
  const animating   = useRef(false)
  const progress    = useRef(0)
  const fromTarget  = useRef(new THREE.Vector3())
  const toTarget    = useRef(new THREE.Vector3())

  // Keep refs in sync without re-registering the listener
  useEffect(() => { disabledRef.current = disabled }, [disabled])
  useEffect(() => { controlsRef.current = controls }, [controls])

  useEffect(() => {
    const canvas = gl.domElement
    const rc = new THREE.Raycaster()

    function onDblClick(e: MouseEvent) {
      if (disabledRef.current || !controlsRef.current) return
      const rect = canvas.getBoundingClientRect()
      const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
      const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
      rc.setFromCamera(new THREE.Vector2(x, y), camera)
      const meshes: THREE.Object3D[] = []
      scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o) })
      const hits = rc.intersectObjects(meshes, false)
      if (hits.length === 0) return
      fromTarget.current.copy(controlsRef.current.target)
      toTarget.current.copy(hits[0].point)
      progress.current = 0
      animating.current = true
    }

    canvas.addEventListener('dblclick', onDblClick)
    return () => canvas.removeEventListener('dblclick', onDblClick)
  }, [camera, gl, scene]) // stable deps only — disabled/controls via refs

  useFrame(() => {
    if (!animating.current || !controlsRef.current) return
    progress.current = Math.min(progress.current + 0.07, 1)
    const t = 1 - Math.pow(1 - progress.current, 3)
    controlsRef.current.target.lerpVectors(fromTarget.current, toTarget.current, t)
    controlsRef.current.update()
    if (progress.current >= 1) animating.current = false
  })

  return null
}

// ── Fly camera (F toggle + WASD, Unreal-style) ───────────────

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _fwd   = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up    = new THREE.Vector3(0, 1, 0)

function FlyCamera({ speedRef, onFlyChange }: {
  speedRef: { current: number }
  onFlyChange: (v: boolean) => void
}) {
  const { camera, controls, gl } = useThree()
  const controlsRef = useRef<any>(null)
  const flyRef  = useRef(false)
  const keysRef = useRef(new Set<string>())

  useEffect(() => { controlsRef.current = controls }, [controls])

  useEffect(() => {
    const canvas = gl.domElement

    function syncOrbitTarget() {
      if (!controlsRef.current) return
      camera.getWorldDirection(_fwd)
      controlsRef.current.target.copy(camera.position).addScaledVector(_fwd, 5)
      controlsRef.current.update()
    }

    function enterFly() {
      flyRef.current = true
      onFlyChange(true)
      canvas.requestPointerLock()
    }

    function exitFly() {
      flyRef.current = false
      onFlyChange(false)
      keysRef.current.clear()
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      syncOrbitTarget()
    }

    function onPointerLockChange() {
      // user pressed Escape → browser exits pointer lock automatically
      if (document.pointerLockElement !== canvas && flyRef.current) exitFly()
    }

    function onKeyDown(e: KeyboardEvent) {
      keysRef.current.add(e.code)
      if (e.code === 'KeyF') {
        flyRef.current ? exitFly() : enterFly()
      }
    }
    function onKeyUp(e: KeyboardEvent) { keysRef.current.delete(e.code) }

    function onMouseMove(e: MouseEvent) {
      if (!flyRef.current) return
      _euler.setFromQuaternion(camera.quaternion)
      _euler.y -= e.movementX * 0.003
      _euler.x  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, _euler.x - e.movementY * 0.003))
      camera.quaternion.setFromEuler(_euler)
    }

    function onWheel(e: WheelEvent) {
      if (!flyRef.current) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.85 : 1.18
      speedRef.current = Math.max(0.5, Math.min(200, speedRef.current * factor))
    }

    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      document.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
    }
  }, [camera, gl, onFlyChange, speedRef])

  useFrame((_, dt) => {
    if (!flyRef.current) return
    const spd = speedRef.current * dt
    camera.getWorldDirection(_fwd)
    _right.crossVectors(_fwd, _up).normalize()
    const keys = keysRef.current
    if (keys.has('KeyW')) camera.position.addScaledVector(_fwd,    spd)
    if (keys.has('KeyS')) camera.position.addScaledVector(_fwd,   -spd)
    if (keys.has('KeyA')) camera.position.addScaledVector(_right,  -spd)
    if (keys.has('KeyD')) camera.position.addScaledVector(_right,   spd)
    if (keys.has('KeyE') || keys.has('Space'))                        camera.position.addScaledVector(_up,  spd)
    if (keys.has('KeyQ') || keys.has('ShiftLeft') || keys.has('ShiftRight')) camera.position.addScaledVector(_up, -spd)
  })

  return null
}

// ── Screenshot capture ────────────────────────────────────────

function ScreenshotCapture({ takeFnRef, annotations, annotationsVisible, hiddenAnnotationIds }: {
  takeFnRef: { current: (() => void) | null }
  annotations: ModelAnnotation[]
  annotationsVisible: boolean
  hiddenAnnotationIds: Set<string>
}) {
  const { gl, camera } = useThree()

  useEffect(() => {
    takeFnRef.current = () => {
      const src = gl.domElement
      const tmp = document.createElement('canvas')
      tmp.width  = src.width
      tmp.height = src.height
      const ctx = tmp.getContext('2d')!
      ctx.drawImage(src, 0, 0)

      if (annotationsVisible && annotations.length > 0) {
        const r = src.width / src.clientWidth // device pixel ratio

        annotations.forEach(ann => {
          if (hiddenAnnotationIds.has(ann.id)) return
          const pos = new THREE.Vector3(ann.x, ann.y, ann.z).project(camera)
          if (pos.z > 1) return // behind camera

          const sx = (pos.x *  0.5 + 0.5) * src.width
          const sy = (pos.y * -0.5 + 0.5) * src.height

          // Dot
          ctx.beginPath()
          ctx.arc(sx, sy, 3.5 * r, 0, Math.PI * 2)
          ctx.fillStyle = '#818cf8'
          ctx.fill()

          // Stem
          const stemH = 16 * r
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(sx, sy - stemH)
          ctx.strokeStyle = 'rgba(129,140,248,0.8)'
          ctx.lineWidth = r
          ctx.stroke()

          // Label box dimensions
          const pad   = 8 * r
          const fs    = 11 * r
          const lh    = fs * 1.45
          const boxW  = 200 * r
          const maxTW = boxW - pad * 2

          ctx.font = `${fs}px system-ui, sans-serif`
          const words = ann.text.split(' ')
          const lines: string[] = []
          let cur = ''
          for (const w of words) {
            const test = cur ? cur + ' ' + w : w
            if (ctx.measureText(test).width > maxTW && cur) { lines.push(cur); cur = w }
            else cur = test
          }
          lines.push(cur)

          const headerH = ann.object_name ? 18 * r : 0
          const textH   = lines.length * lh + pad * 2
          const boxH    = headerH + textH
          const boxX    = sx - boxW / 2
          const boxY    = sy - stemH - boxH
          const rad     = 6 * r

          // Box background
          ctx.fillStyle   = 'rgba(10,12,20,0.95)'
          ctx.strokeStyle = 'rgba(99,102,241,0.5)'
          ctx.lineWidth   = r
          ctx.beginPath()
          ;(ctx as any).roundRect(boxX, boxY, boxW, boxH, rad)
          ctx.fill(); ctx.stroke()

          // Object name header
          if (ann.object_name) {
            ctx.fillStyle = 'rgba(99,102,241,0.25)'
            ctx.beginPath()
            ;(ctx as any).roundRect(boxX, boxY, boxW, headerH, [rad, rad, 0, 0])
            ctx.fill()
            ctx.font          = `${9 * r}px system-ui, sans-serif`
            ctx.fillStyle     = '#a5b4fc'
            ctx.textAlign     = 'center'
            ctx.textBaseline  = 'middle'
            ctx.fillText(ann.object_name.toUpperCase(), sx, boxY + headerH / 2)
          }

          // Main text
          ctx.font         = `${fs}px system-ui, sans-serif`
          ctx.fillStyle    = '#e5e7eb'
          ctx.textAlign    = 'left'
          ctx.textBaseline = 'top'
          lines.forEach((l, i) => ctx.fillText(l, boxX + pad, boxY + headerH + pad + i * lh))
        })
      }

      const a = document.createElement('a')
      a.href = tmp.toDataURL('image/png')
      a.download = `model-${Date.now()}.png`
      a.click()
    }
  }, [gl, camera, annotations, annotationsVisible, hiddenAnnotationIds, takeFnRef])

  return null
}

// ── Camera persist (save / restore per model) ─────────────────

type CameraState = { px: number; py: number; pz: number; tx: number; ty: number; tz: number }
type CameraSaveResult = { canvas: HTMLCanvasElement; cameraState: CameraState }

function CameraPersist({ modelId, boundsRef, saveFnRef, initialCameraState }: {
  modelId: string
  boundsRef: { current: THREE.Box3 | null }
  saveFnRef: { current: (() => CameraSaveResult) | null }
  initialCameraState: CameraState | null
}) {
  const { camera, controls, gl } = useThree()
  const restoredRef = useRef(false)

  useFrame(() => {
    if (restoredRef.current || !boundsRef.current || !controls) return
    restoredRef.current = true
    // DB state takes priority (shared), localStorage as fallback
    const state: CameraState | null = initialCameraState ?? (() => {
      const raw = localStorage.getItem(`model_cam_${modelId}`)
      if (!raw) return null
      try { return JSON.parse(raw) as CameraState } catch { return null }
    })()
    if (!state) return
    camera.position.set(state.px, state.py, state.pz)
    ;(controls as any).target.set(state.tx, state.ty, state.tz)
    ;(controls as any).update()
  })

  useEffect(() => {
    saveFnRef.current = () => {
      const ctrl = controls as any
      const cameraState: CameraState = {
        px: camera.position.x, py: camera.position.y, pz: camera.position.z,
        tx: ctrl?.target?.x ?? 0, ty: ctrl?.target?.y ?? 0, tz: ctrl?.target?.z ?? 0,
      }
      localStorage.setItem(`model_cam_${modelId}`, JSON.stringify(cameraState))
      const src = gl.domElement
      const W = 480, H = Math.round(W * src.height / src.width)
      const tmp = document.createElement('canvas')
      tmp.width = W; tmp.height = H
      tmp.getContext('2d')?.drawImage(src, 0, 0, W, H)
      return { canvas: tmp, cameraState }
    }
    return () => { saveFnRef.current = null }
  }, [camera, controls, gl, modelId, saveFnRef])

  return null
}

// ── Measurement tool ──────────────────────────────────────────

function MeasureTool({ active }: { active: boolean }) {
  const { camera, gl, scene } = useThree()
  const [pts, setPts] = useState<THREE.Vector3[]>([])
  const ptsRef  = useRef<THREE.Vector3[]>([])
  const downXY  = useRef({ x: 0, y: 0 })

  useEffect(() => {
    if (!active) { ptsRef.current = []; setPts([]) }
  }, [active])

  useEffect(() => {
    if (!active) return
    const canvas = gl.domElement
    const rc = new THREE.Raycaster()

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return
      downXY.current = { x: e.clientX, y: e.clientY }
    }

    function onPointerUp(e: PointerEvent) {
      if (e.button !== 0) return
      const dx = e.clientX - downXY.current.x
      const dy = e.clientY - downXY.current.y
      if (dx * dx + dy * dy > 25) return // was a drag
      const rect = canvas.getBoundingClientRect()
      const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
      const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
      rc.setFromCamera(new THREE.Vector2(x, y), camera)
      const meshes: THREE.Object3D[] = []
      scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o) })
      const hits = rc.intersectObjects(meshes, false)
      if (hits.length === 0) return
      const current = ptsRef.current
      const next = current.length >= 2 ? [hits[0].point.clone()] : [...current, hits[0].point.clone()]
      ptsRef.current = next
      setPts([...next])
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup',   onPointerUp)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup',   onPointerUp)
    }
  }, [active, camera, gl, scene])

  // All hooks before any early return
  const dist = pts.length === 2 ? pts[0].distanceTo(pts[1]) : null
  const mid  = dist !== null ? pts[0].clone().lerp(pts[1], 0.5) : null

  const cylinderQuat = useMemo(() => {
    if (pts.length < 2) return new THREE.Quaternion()
    const dir = pts[1].clone().sub(pts[0]).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  }, [pts])

  const radius = dist !== null ? Math.max(dist * 0.006, 0.004) : 0.01

  if (!active || pts.length === 0) return null

  return (
    <group>
      {pts.map((p, i) => (
        <mesh key={i} position={p} renderOrder={999}>
          <sphereGeometry args={[radius * 1.6, 16, 16]} />
          <meshBasicMaterial color="#f97316" depthTest={false} />
        </mesh>
      ))}
      {dist !== null && mid && (
        <mesh position={mid} quaternion={cylinderQuat} renderOrder={999}>
          <cylinderGeometry args={[radius, radius, dist, 6]} />
          <meshBasicMaterial color="#f97316" depthTest={false} />
        </mesh>
      )}
      {mid && dist !== null && (
        <Html position={mid} center>
          <div className="bg-gray-900/90 text-orange-400 text-xs font-mono font-semibold px-2 py-1 rounded border border-orange-500/40 whitespace-nowrap pointer-events-none select-none shadow-lg">
            {dist < 1 ? `${(dist * 100).toFixed(1)} cm` : `${dist.toFixed(3)} m`}
          </div>
        </Html>
      )}
    </group>
  )
}

// ── Fly to annotation on load ────────────────────────────────

function FlyToAnnotation({ pos, boundsRef }: {
  pos: THREE.Vector3 | null
  boundsRef: { current: THREE.Box3 | null }
}) {
  const { camera, controls } = useThree()
  const controlsRef = useRef<any>(null)
  const firedRef    = useRef(false)

  useEffect(() => { controlsRef.current = controls }, [controls])
  useEffect(() => { firedRef.current = false }, [pos])

  useFrame(() => {
    if (firedRef.current || !pos || !boundsRef.current || !controlsRef.current) return
    const size = boundsRef.current.getSize(new THREE.Vector3())
    const dist = Math.max(size.x, size.y, size.z) * 0.2
    camera.position.set(pos.x + dist, pos.y + dist * 0.6, pos.z + dist)
    camera.lookAt(pos)
    ;(camera as THREE.PerspectiveCamera).near = Math.max(dist / 1000, 0.001)
    ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
    controlsRef.current.target.copy(pos)
    controlsRef.current.update()
    firedRef.current = true
  })

  return null
}

// ── Camera rig (preset views) ─────────────────────────────────

function CameraRig({ commandRef, boundsRef }: {
  commandRef: { current: ((v: string) => void) | null }
  boundsRef:  { current: THREE.Box3 | null }
}) {
  const { camera, controls } = useThree()
  useEffect(() => {
    commandRef.current = (view: string) => {
      const b = boundsRef.current; if (!b) return
      const center = b.getCenter(new THREE.Vector3())
      const size   = b.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const cam    = camera as THREE.PerspectiveCamera
      const dist   = (maxDim / (2 * Math.tan((cam.fov * Math.PI) / 360))) * 2
      const dirs: Record<string, [number, number, number]> = {
        top:    [0,  1,  0.001],
        bottom: [0, -1,  0.001],
        front:  [0,  0,  1],
        back:   [0,  0, -1],
        right:  [1,  0,  0],
        left:   [-1, 0,  0],
      }
      const d = dirs[view]; if (!d) return
      camera.position.set(center.x + d[0] * dist, center.y + d[1] * dist, center.z + d[2] * dist)
      camera.lookAt(center)
      cam.near = Math.max(dist / 1000, 0.001); cam.far = dist * 25
      cam.updateProjectionMatrix()
      if (controls) { const c = controls as any; c.target.copy(center); c.update() }
    }
  }, [camera, controls, commandRef, boundsRef])
  return null
}

// ── Annotation markers ────────────────────────────────────────

function AnnotationMarkers({ annotations, onDelete, canDelete, visible, hiddenIds }: {
  annotations: ModelAnnotation[]
  onDelete: (id: string) => void
  canDelete: boolean
  visible: boolean
  hiddenIds: Set<string>
}) {
  return (
    <>
      {annotations.map(ann => (
        <Html key={ann.id} position={[ann.x, ann.y, ann.z]} style={{ pointerEvents: 'none' }}>
          <div style={{
            transform: 'translateX(-50%) translateY(-100%)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            pointerEvents: visible && !hiddenIds.has(ann.id) ? 'auto' : 'none',
            opacity: visible && !hiddenIds.has(ann.id) ? 1 : 0,
            transition: 'opacity 0.9s ease',
          }}>
            {/* Label box */}
            <div style={{
              background: 'rgba(10,12,20,0.95)',
              border: '1px solid rgba(99,102,241,0.5)',
              borderRadius: 6,
              overflow: 'hidden',
              width: 200,
              boxShadow: '0 3px 12px rgba(0,0,0,0.6)',
            }}>
              {ann.object_name && (
                <div style={{
                  background: 'rgba(99,102,241,0.25)',
                  borderBottom: '1px solid rgba(99,102,241,0.3)',
                  padding: '2px 8px',
                  fontSize: 9,
                  color: '#a5b4fc',
                  letterSpacing: '0.03em',
                  textTransform: 'uppercase',
                  overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
                }}>
                  {ann.object_name}
                </div>
              )}
              <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ color: '#e5e7eb', fontSize: 11, flex: 1, wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{ann.text}</span>
                {canDelete && (
                  <button
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onDelete(ann.id) }}
                    style={{ color: '#4b5563', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                  >×</button>
                )}
              </div>
            </div>
            {/* Stem */}
            <div style={{ width: 1, height: 16, background: 'linear-gradient(to bottom, rgba(129,140,248,0.8), rgba(129,140,248,0.3))' }} />
            {/* Dot at exact surface point */}
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#818cf8', boxShadow: '0 0 6px rgba(129,140,248,0.9)', flexShrink: 0 }} />
          </div>
        </Html>
      ))}
    </>
  )
}

// ── Vegetation ───────────────────────────────────────────────

type VegType = 'grass' | 'bush-s' | 'bush-m' | 'bush-l' | 'tree-s' | 'tree-m' | 'tree-l' | 'tree-ds' | 'tree-dm' | 'tree-dl'

interface VegInstance { x: number; y: number; z: number; ry: number; s: number; rx?: number; rz?: number }

interface VegGroup {
  id: string
  type: VegType
  targetName: string
  scaleMult: number
  instances: VegInstance[]
  mode: 'scatter' | 'click'
}

const VEG_CFG: Record<VegType, { label: string; count: number; baseH: number; color: string; trunkColor?: string }> = {
  'grass':   { label: 'Tráva',    count: 2000, baseH: 0.12, color: '#6fcf7c' },
  'bush-s':  { label: 'Keř S',    count: 30,   baseH: 0.50, color: '#4a9e5c' },
  'bush-m':  { label: 'Keř M',    count: 20,   baseH: 1.00, color: '#3a8a4a' },
  'bush-l':  { label: 'Keř L',    count: 12,   baseH: 1.80, color: '#2d7040' },
  'tree-s':  { label: 'Jehlič. S', count: 10,  baseH: 2.50, color: '#4a7c59', trunkColor: '#795548' },
  'tree-m':  { label: 'Jehlič. M', count: 7,   baseH: 5.00, color: '#3d6b4f', trunkColor: '#6d4c41' },
  'tree-l':  { label: 'Jehlič. L', count: 4,   baseH: 8.00, color: '#2d5a3f', trunkColor: '#5d4037' },
  'tree-ds': { label: 'Listnatý S', count: 10,  baseH: 2.50, color: '#6aaa3a', trunkColor: '#8d6e63' },
  'tree-dm': { label: 'Listnatý M', count: 7,   baseH: 5.00, color: '#5a9a2a', trunkColor: '#795548' },
  'tree-dl': { label: 'Listnatý L', count: 4,   baseH: 8.00, color: '#4a8a1a', trunkColor: '#6d4c41' },
}

function scatterOnMesh(mesh: THREE.Mesh, count: number, patched = false): VegInstance[] {
  mesh.updateWorldMatrix(true, false)
  const bbox = new THREE.Box3().setFromObject(mesh)
  const size = bbox.getSize(new THREE.Vector3())
  const ray  = new THREE.Raycaster()
  const dn   = new THREE.Vector3(0, -1, 0)
  const out: VegInstance[] = []

  // Patch centers for non-uniform distribution
  const patchSeeds: { x: number; z: number }[] = []
  if (patched) {
    const nPatches = Math.max(4, Math.round(Math.sqrt(count) * 0.6))
    const patchR   = Math.max(size.x, size.z) * 0.18
    for (let p = 0; p < nPatches * 5 && patchSeeds.length < nPatches; p++) {
      const cx = THREE.MathUtils.lerp(bbox.min.x, bbox.max.x, Math.random())
      const cz = THREE.MathUtils.lerp(bbox.min.z, bbox.max.z, Math.random())
      ray.set(new THREE.Vector3(cx, bbox.max.y + 1, cz), dn)
      if (ray.intersectObject(mesh, true).length) patchSeeds.push({ x: cx, z: cz })
    }
    // eslint-disable-next-line no-param-reassign
    if (!patchSeeds.length) patched = false  // fallback to uniform
    else {
      const r = patchR
      for (let i = 0; i < count * 20 && out.length < count; i++) {
        const seed  = patchSeeds[Math.floor(Math.random() * patchSeeds.length)]
        const angle = Math.random() * Math.PI * 2
        const dist  = Math.sqrt(Math.random()) * r
        const x = seed.x + Math.cos(angle) * dist
        const z = seed.z + Math.sin(angle) * dist
        ray.set(new THREE.Vector3(x, bbox.max.y + 1, z), dn)
        const hits = ray.intersectObject(mesh, true)
        if (hits.length)
          out.push({ x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z, ry: Math.random() * Math.PI * 2, s: 0.75 + Math.random() * 0.5, rx: (Math.random() - 0.5) * 0.28, rz: (Math.random() - 0.5) * 0.28 })
      }
      return out
    }
  }

  for (let i = 0; i < count * 10 && out.length < count; i++) {
    const x = THREE.MathUtils.lerp(bbox.min.x, bbox.max.x, Math.random())
    const z = THREE.MathUtils.lerp(bbox.min.z, bbox.max.z, Math.random())
    ray.set(new THREE.Vector3(x, bbox.max.y + 1, z), dn)
    const hits = ray.intersectObject(mesh, true)
    if (hits.length)
      out.push({ x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z, ry: Math.random() * Math.PI * 2, s: 0.75 + Math.random() * 0.5, rx: (Math.random() - 0.5) * 0.28, rz: (Math.random() - 0.5) * 0.28 })
  }
  return out
}

function GrassLayer({ instances, color, h }: { instances: VegInstance[]; color: string; h: number }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => {
    const w = 0.022 * h / 0.12
    // 3 planes at 0°, 60°, 120° — looks dense from every angle
    const s60 = 0.866
    const pos = new Float32Array([
      -w,      0,  0,       w,      0,  0,       0, h, 0,
      -w*0.5,  0, -w*s60,  w*0.5,  0,  w*s60,   0, h, 0,
       w*0.5,  0, -w*s60, -w*0.5,  0,  w*s60,   0, h, 0,
    ])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return g
  }, [h])
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }), [color])
  useEffect(() => {
    if (!ref.current) return
    const d = new THREE.Object3D()
    instances.forEach((v, i) => {
      d.position.set(v.x, v.y, v.z)
      d.rotation.set(v.rx ?? 0, v.ry, v.rz ?? 0)
      d.scale.setScalar(v.s)
      d.updateMatrix()
      ref.current!.setMatrixAt(i, d.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  }, [instances])
  return <instancedMesh ref={ref} args={[geo, mat, instances.length]} />
}

function BushInst({ v, color, h }: { v: VegInstance; color: string; h: number }) {
  const r = h * 0.45
  return (
    <group position={[v.x, v.y, v.z]} rotation={[0, v.ry, 0]} scale={v.s}>
      <mesh position={[0, r * 0.9, 0]}>
        <icosahedronGeometry args={[r, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  )
}

function TreeInst({ v, color, trunkColor, h }: { v: VegInstance; color: string; trunkColor: string; h: number }) {
  return (
    <group position={[v.x, v.y, v.z]} rotation={[0, v.ry, 0]} scale={v.s}>
      <mesh position={[0, h * 0.18, 0]}>
        <cylinderGeometry args={[h * 0.035, h * 0.06, h * 0.36, 5]} />
        <meshStandardMaterial color={trunkColor} flatShading />
      </mesh>
      <mesh position={[0, h * 0.62, 0]}>
        <coneGeometry args={[h * 0.38, h * 0.55, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh position={[0, h * 0.87, 0]}>
        <coneGeometry args={[h * 0.27, h * 0.42, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  )
}

function TreeDecidInst({ v, color, trunkColor, h }: { v: VegInstance; color: string; trunkColor: string; h: number }) {
  const r = h * 0.38
  return (
    <group position={[v.x, v.y, v.z]} rotation={[0, v.ry, 0]} scale={v.s}>
      <mesh position={[0, h * 0.22, 0]}>
        <cylinderGeometry args={[h * 0.028, h * 0.048, h * 0.44, 5]} />
        <meshStandardMaterial color={trunkColor} flatShading />
      </mesh>
      {/* Main canopy */}
      <mesh position={[0, h * 0.68, 0]}>
        <icosahedronGeometry args={[r, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      {/* Top accent */}
      <mesh position={[h * 0.12, h * 0.88, 0]}>
        <icosahedronGeometry args={[r * 0.55, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh position={[-h * 0.10, h * 0.84, h * 0.08]}>
        <icosahedronGeometry args={[r * 0.48, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  )
}

function VegetationLayer({ groups }: { groups: VegGroup[] }) {
  return (
    <>
      {groups.map(g => {
        const cfg = VEG_CFG[g.type]
        const h   = cfg.baseH * g.scaleMult
        if (g.type === 'grass')
          return <GrassLayer key={g.id} instances={g.instances} color={cfg.color} h={h} />
        if (g.type.startsWith('bush'))
          return <group key={g.id}>{g.instances.map((v, i) => <BushInst key={i} v={v} color={cfg.color} h={h} />)}</group>
        if (g.type.startsWith('tree-d'))
          return <group key={g.id}>{g.instances.map((v, i) => <TreeDecidInst key={i} v={v} color={cfg.color} trunkColor={cfg.trunkColor ?? '#8d6e63'} h={h} />)}</group>
        return <group key={g.id}>{g.instances.map((v, i) => <TreeInst key={i} v={v} color={cfg.color} trunkColor={cfg.trunkColor ?? '#795548'} h={h} />)}</group>
      })}
    </>
  )
}

// ── Viewer ────────────────────────────────────────────────────

const VIEW_PRESETS = [
  { id: 'top',    label: 'Vrch' },
  { id: 'bottom', label: 'Dno'  },
  { id: 'front',  label: 'Před' },
  { id: 'back',   label: 'Zad'  },
  { id: 'right',  label: 'Práv' },
  { id: 'left',   label: 'Levo' },
] as const

function Viewer({ url, name, modelId, onClose, focusAnnotationPos, initialCameraState }: { url: string; name: string; modelId: string; onClose: () => void; focusAnnotationPos?: THREE.Vector3 | null; initialCameraState?: CameraState | null }) {
  const { profile, isAdmin } = useAuthStore()
  const admin = isAdmin()
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
  const vegSkipSave   = useRef(true)   // skip first render + load-triggered change
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
      const { data, error } = await supabase
        .from('model_object_colors').select('*').eq('model_id', modelId)
      if (error) throw error
      return data as ModelObjectColor[]
    },
  })

  const { data: savedVeg } = useQuery({
    queryKey: ['model_vegetation', modelId],
    queryFn: async () => {
      const { data } = await supabase
        .from('model_vegetation').select('data').eq('model_id', modelId).maybeSingle()
      return (data?.data ?? null) as VegGroup[] | null
    },
  })

  // Load saved vegetation once on open
  useEffect(() => {
    if (savedVeg && savedVeg.length > 0 && !vegLoadedRef.current) {
      vegLoadedRef.current = true
      vegSkipSave.current = true
      setVegGroups(savedVeg)
    }
  }, [savedVeg]) // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave vegetation (debounced 1.5 s)
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
      const { data, error } = await supabase
        .from('model_annotations').select('*').eq('model_id', modelId).order('created_at')
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
    // Save camera state to DB (shared across users)
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

    // Find nearby instance of same type to delete
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

    // Add new instance
    const inst: VegInstance = { x: pos.x, y: pos.y, z: pos.z, ry: Math.random() * Math.PI * 2, s: 0.75 + Math.random() * 0.5, rx: (Math.random() - 0.5) * 0.28, rz: (Math.random() - 0.5) * 0.28 }
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
        <div className="flex-1 relative" style={{ cursor: annotationMode ? 'crosshair' : measureMode ? 'crosshair' : (vegOpen && vegPlaceMode === 'click' && vegType !== 'grass') ? 'cell' : 'default' }}>
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
                type="range"
                min={0.5}
                max={100}
                step={0.5}
                value={flySpeed}
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
                {/* Type selector */}
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

                {/* Grass-specific: density + patches */}
                {vegType === 'grass' && (
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between mb-1">
                        <p className="text-xs text-gray-500">Hustota</p>
                        <span className="text-xs text-gray-400">{grassCount.toLocaleString()}</span>
                      </div>
                      <input type="range" min={200} max={10000} step={100} value={grassCount}
                        onChange={e => setGrassCount(Number(e.target.value))}
                        className="w-full accent-green-500"
                      />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={grassPatched} onChange={e => setGrassPatched(e.target.checked)} className="w-3.5 h-3.5 accent-green-500" />
                      <span className="text-xs text-gray-400">Shluky (patches)</span>
                    </label>
                  </div>
                )}

                {/* Non-grass: scatter vs click mode */}
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

                {/* Scale */}
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-xs text-gray-500">Měřítko</p>
                    <span className="text-xs text-gray-400">{vegScale.toFixed(2)}×</span>
                  </div>
                  <input type="range" min={0.1} max={5} step={0.05} value={vegScale}
                    onChange={e => setVegScale(Number(e.target.value))}
                    className="w-full accent-green-500"
                  />
                </div>

                {/* Action */}
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

                {/* Layer list */}
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
            {/* Panel header */}
            <div className="px-3 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={13} /> Objekty
              </span>
            </div>

            {/* Wireframe controls */}
            <div className="px-3 py-2.5 border-b border-gray-800 space-y-2">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setWireframe(w => !w)}
                  className={`flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    wireframe ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
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

            {/* Object list */}
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

            {/* Annotations list */}
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

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ModelsPage() {
  const { profile, isAdmin } = useAuthStore()
  const admin = isAdmin()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [searchParams] = useSearchParams()

  const [viewerModel, setViewerModel] = useState<{ model: ModelFile; url: string } | null>(null)
  const [focusAnnotationPos, setFocusAnnotationPos] = useState<THREE.Vector3 | null>(null)
  const [bgModelId, setBgModelId]         = useState(() => localStorage.getItem('bg_model_id') ?? '')
  const [uploadOpen, setUploadOpen]       = useState(false)
  const [uploading, setUploading]         = useState(false)
  const [uploadName, setUploadName]       = useState('')
  const [uploadDesc, setUploadDesc]       = useState('')
  const [uploadFile, setUploadFile]       = useState<File | null>(null)
  const [assigningModelId, setAssigningModelId] = useState<string | null>(null)
  const [uploadProjectId, setUploadProjectId]   = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: projects = [] } = useQuery({
    queryKey: ['projects_list_for_models'],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name').order('name')
      return (data ?? []) as { id: string; name: string }[]
    },
  })

  const { data: models = [], isLoading } = useQuery({
    queryKey: ['model_files'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('model_files')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as ModelFile[]
    },
  })

  function openViewer(model: ModelFile) {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(model.file_path)
    setViewerModel({ model, url: data.publicUrl })
  }

  async function handleAssignProject(modelId: string, projectId: string | null) {
    const { error } = await supabase.from('model_files').update({ project_id: projectId }).eq('id', modelId)
    if (error) { toast.error('Chyba: ' + error.message); return }
    qc.invalidateQueries({ queryKey: ['model_files'] })
    setAssigningModelId(null)
    toast.success(projectId ? 'Model přiřazen k projektu' : 'Model odebrán z projektu')
  }

  const modelGroups = useMemo(() => {
    const groups: { projectId: string | null; name: string; models: ModelFile[] }[] = []
    const projectsWithModels = projects.filter(p => models.some(m => m.project_id === p.id))
    for (const p of projectsWithModels) {
      groups.push({ projectId: p.id, name: p.name, models: models.filter(m => m.project_id === p.id) })
    }
    const unassigned = models.filter(m => !m.project_id)
    if (unassigned.length > 0 || groups.length === 0) {
      groups.push({ projectId: null, name: 'Bez projektu', models: unassigned })
    }
    return groups
  }, [models, projects])

  // Deep-link: ?model=<id>&annotation=<id>
  useEffect(() => {
    const modelParam      = searchParams.get('model')
    const annotationParam = searchParams.get('annotation')
    if (!modelParam || models.length === 0) return
    const found = models.find(m => m.id === modelParam)
    if (found && !viewerModel) openViewer(found)
    if (annotationParam) {
      supabase.from('model_annotations').select('x, y, z').eq('id', annotationParam).single()
        .then(({ data }) => {
          if (data) setFocusAnnotationPos(new THREE.Vector3(data.x, data.y, data.z))
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  function handleFileSelect(f: File) {
    setUploadFile(f)
    if (!uploadName) setUploadName(f.name.replace(/\.(glb|gltf)$/i, ''))
  }

  async function handleUpload() {
    if (!uploadFile || !uploadName || !profile) return
    setUploading(true)
    try {
      const base = `${Date.now()}_${uploadName.replace(/\s+/g, '_')}`
      const ext = uploadFile.name.split('.').pop() ?? 'glb'
      const path = `${base}.${ext}`

      const { error: storageErr } = await supabase.storage.from(BUCKET).upload(path, uploadFile)
      if (storageErr) throw storageErr

      let thumbnailPath: string | null = null
      try {
        const thumbBlob = await generateThumbnail(uploadFile)
        const thumbPath = `thumbs/${base}.jpg`
        const { error: thumbErr } = await supabase.storage.from(BUCKET).upload(thumbPath, thumbBlob, { contentType: 'image/jpeg' })
        if (!thumbErr) thumbnailPath = thumbPath
      } catch {
        // thumbnail is optional — proceed without it
      }

      const { error: dbErr } = await supabase.from('model_files').insert({
        name: uploadName,
        description: uploadDesc || null,
        file_path: path,
        thumbnail_path: thumbnailPath,
        file_size: uploadFile.size,
        project_id: uploadProjectId || null,
        created_by: profile.id,
      })
      if (dbErr) throw dbErr

      qc.invalidateQueries({ queryKey: ['model_files'] })
      toast.success('Model nahrán')
      setUploadOpen(false)
      setUploadFile(null)
      setUploadName('')
      setUploadDesc('')
      setUploadProjectId('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Chyba při nahrávání')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(model: ModelFile) {
    if (!await confirm({ title: 'Smazat model', message: `Opravdu smazat model „${model.name}"? Tato akce je nevratná.`, confirmLabel: 'Smazat', variant: 'danger' })) return
    const filesToRemove = [model.file_path, ...(model.thumbnail_path ? [model.thumbnail_path] : [])]
    const { error: storageErr } = await supabase.storage.from(BUCKET).remove(filesToRemove)
    if (storageErr) { toast.error('Chyba při mazání souboru: ' + storageErr.message); return }
    const { error: dbErr } = await supabase.from('model_files').delete().eq('id', model.id)
    if (dbErr) { toast.error('Chyba při mazání záznamu: ' + dbErr.message); return }
    qc.invalidateQueries({ queryKey: ['model_files'] })
    toast.success('Model smazán')
  }

  return (
    <PageLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">3D Modely</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Prohlížeč modelů mostů a konstrukcí</p>
          </div>
          {profile && (
            <button
              onClick={() => setUploadOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Upload size={15} /> Nahrát model
            </button>
          )}
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-28 text-gray-400 dark:text-gray-500">
            <Box size={44} className="mx-auto mb-3 opacity-25" />
            <p className="text-sm">Zatím žádné modely</p>
            {profile && (
              <button onClick={() => setUploadOpen(true)} className="mt-3 text-sm text-indigo-500 hover:text-indigo-600">
                Nahrát první model
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {modelGroups.map(group => (
              <div key={group.projectId ?? '__none__'}>
                {modelGroups.length > 1 && (
                  <div className="flex items-center gap-2 mb-3">
                    <FolderOpen size={15} className="text-indigo-400 shrink-0" />
                    <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{group.name}</h2>
                    <span className="text-xs text-gray-400">({group.models.length})</span>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {group.models.map(model => (
                    <div
                      key={model.id}
                      onClick={() => { if (assigningModelId !== model.id) openViewer(model) }}
                      className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-lg transition-all"
                    >
                      <div className="h-40 bg-linear-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center overflow-hidden">
                        {model.thumbnail_path ? (() => {
                          const base = supabase.storage.from(BUCKET).getPublicUrl(model.thumbnail_path).data.publicUrl
                          const v = localStorage.getItem(`thumb_v_${model.id}`)
                          return <img src={v ? `${base}?v=${v}` : base} alt={model.name} className="w-full h-full object-cover" />
                        })() : (
                          <Box size={48} className="text-gray-300 dark:text-gray-700 group-hover:text-indigo-400 dark:group-hover:text-indigo-500 transition-colors" />
                        )}
                      </div>
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{model.name}</p>
                            {model.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{model.description}</p>}
                            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1.5">
                              {[formatSize(model.file_size), new Date(model.created_at).toLocaleDateString('cs-CZ')].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={e => { e.stopPropagation(); setBgModel(model.id); setBgModelId(model.id); toast.success('Nastaveno jako pozadí') }}
                              title="Nastavit jako pozadí aplikace"
                              className={`p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 ${bgModelId === model.id ? 'text-indigo-500 dark:text-indigo-400 opacity-100' : 'text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'}`}>
                              <Monitor size={14} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); setAssigningModelId(assigningModelId === model.id ? null : model.id) }}
                              title="Přiřadit k projektu"
                              className={`p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 ${model.project_id ? 'text-indigo-500 dark:text-indigo-400 opacity-100' : 'text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'}`}>
                              <FolderOpen size={14} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); handleDelete(model) }}
                              className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {assigningModelId === model.id && (
                          <div className="mt-2" onClick={e => e.stopPropagation()}>
                            <select
                              defaultValue={model.project_id ?? ''}
                              onChange={e => handleAssignProject(model.id, e.target.value || null)}
                              autoFocus
                              className="w-full px-2 py-1.5 text-xs rounded-md border border-indigo-300 dark:border-indigo-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            >
                              <option value="">— bez projektu —</option>
                              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setUploadOpen(false)}>
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Nahrát 3D model</h2>
              <button onClick={() => setUploadOpen(false)} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X size={16} />
              </button>
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                uploadFile
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'border-gray-300 dark:border-gray-700 hover:border-indigo-400 dark:hover:border-indigo-600'
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".glb,.gltf"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }}
              />
              <Upload size={24} className="mx-auto mb-2 text-gray-400" />
              {uploadFile ? (
                <p className="text-sm text-indigo-600 dark:text-indigo-400 font-medium">{uploadFile.name}</p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Klikni nebo přetáhni soubor <strong>.glb</strong> nebo <strong>.gltf</strong>
                </p>
              )}
            </div>

            <input
              value={uploadName}
              onChange={e => setUploadName(e.target.value)}
              placeholder="Název modelu"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <textarea
              value={uploadDesc}
              onChange={e => setUploadDesc(e.target.value)}
              placeholder="Popis (volitelné)"
              rows={2}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />

            <select
              value={uploadProjectId}
              onChange={e => setUploadProjectId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— bez projektu —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            <button
              onClick={handleUpload}
              disabled={!uploadFile || !uploadName || uploading}
              className="w-full py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Nahrávám…' : 'Nahrát'}
            </button>
          </div>
        </div>
      )}

      {/* 3D Viewer */}
      {viewerModel && (
        <Viewer
          url={viewerModel.url}
          name={viewerModel.model.name}
          modelId={viewerModel.model.id}
          onClose={() => { setViewerModel(null); setFocusAnnotationPos(null) }}
          focusAnnotationPos={focusAnnotationPos}
          initialCameraState={viewerModel.model.camera_state ?? null}
        />
      )}
    </PageLayout>
  )
}
