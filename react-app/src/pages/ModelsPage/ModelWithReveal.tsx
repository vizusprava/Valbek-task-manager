import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { setMeshGlow } from './shared'
import type { SceneNode } from './shared'

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

export function ModelWithReveal({ url, wireframe, wireframeOnly, wireframeColor, wireframeMode, selectedUuid, annotationMode, vegClickPlace, boundsRef, onReady, onMeshMap, onHover, onSelect, onAnnotationPlace, onVegPlace }: ModelProps) {
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

  useEffect(() => { selectedUuidRef.current = selectedUuid }, [selectedUuid])

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
        ls.raycast = () => {}
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

  useEffect(() => {
    wireMats.current.forEach(m => m.color.set(wireframeColor))
    edgeMats.current.forEach(m => m.color.set(wireframeColor))
  }, [wireframeColor])

  useEffect(() => {
    meshMapRef.current.forEach((mesh, uuid) => {
      const isHov = mesh === hoveredMeshRef.current
      if (uuid === selectedUuid) setMeshGlow(mesh, 0)
      else setMeshGlow(mesh, isHov ? 1 : 0)
    })
  }, [selectedUuid])

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
