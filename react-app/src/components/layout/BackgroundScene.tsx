import { Suspense, useEffect, useMemo, useState, useRef, Component } from 'react'
import type { ReactNode } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { useGLTF, OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import * as THREE from 'three'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

// ── Error boundary ────────────────────────────────────────────
class SceneErrorBoundary extends Component<{ children: ReactNode }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() { return this.state.error ? null : this.props.children }
}

// ── Hologram material ─────────────────────────────────────────
const HOLO_VERT = `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos    = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position  = projectionMatrix * viewMatrix * wp;
}
`

const HOLO_FRAG = `
uniform float uTime;
uniform vec3  uColor;
varying vec3  vWorldNormal;
varying vec3  vWorldPos;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = 1.0 - abs(dot(normalize(vWorldNormal), viewDir));
  fresnel = pow(fresnel, 1.8);

  float scan = sin(vWorldPos.y * 28.0 - uTime * 1.8) * 0.5 + 0.5;
  scan = smoothstep(0.35, 0.65, scan) * 0.35;

  float flicker = 0.92 + 0.08 * sin(uTime * 17.3) * sin(uTime * 5.7);

  float alpha = clamp((fresnel * 0.75 + 0.12 + scan) * flicker, 0.0, 0.92);
  gl_FragColor = vec4(uColor, alpha);
}
`

function makeHoloMaterial(color = '#00d4ff') {
  return new THREE.ShaderMaterial({
    vertexShader:   HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    uniforms: {
      uTime:  { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

// ── Vegetation (mirror of ModelsPage) ────────────────────────
type VegType = 'grass' | 'bush-s' | 'bush-m' | 'bush-l' | 'tree-s' | 'tree-m' | 'tree-l' | 'tree-ds' | 'tree-dm' | 'tree-dl'
interface VegInstance { x: number; y: number; z: number; ry: number; s: number; rx?: number; rz?: number }
interface VegGroup { id: string; type: VegType; targetName: string; scaleMult: number; instances: VegInstance[]; mode: 'scatter' | 'click' }

const VEG_CFG: Record<VegType, { baseH: number; color: string; trunkColor?: string }> = {
  'grass':   { baseH: 0.12, color: '#6fcf7c' },
  'bush-s':  { baseH: 0.50, color: '#4a9e5c' },
  'bush-m':  { baseH: 1.00, color: '#3a8a4a' },
  'bush-l':  { baseH: 1.80, color: '#2d7040' },
  'tree-s':  { baseH: 2.50, color: '#4a7c59', trunkColor: '#795548' },
  'tree-m':  { baseH: 5.00, color: '#3d6b4f', trunkColor: '#6d4c41' },
  'tree-l':  { baseH: 8.00, color: '#2d5a3f', trunkColor: '#5d4037' },
  'tree-ds': { baseH: 2.50, color: '#6aaa3a', trunkColor: '#8d6e63' },
  'tree-dm': { baseH: 5.00, color: '#5a9a2a', trunkColor: '#795548' },
  'tree-dl': { baseH: 8.00, color: '#4a8a1a', trunkColor: '#6d4c41' },
}

const HOLO_VEG_COLOR = '#00ffcc'

function GrassLayerHolo({ instances, h, mat }: { instances: VegInstance[]; h: number; mat: THREE.ShaderMaterial }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => {
    const w = 0.022 * h / 0.12, s60 = 0.866
    const pos = new Float32Array([
      -w, 0, 0,  w, 0, 0,  0, h, 0,
      -w*0.5, 0, -w*s60,  w*0.5, 0, w*s60,  0, h, 0,
       w*0.5, 0, -w*s60, -w*0.5, 0, w*s60,  0, h, 0,
    ])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length).fill(0), 3))
    return g
  }, [h])
  useEffect(() => {
    if (!ref.current) return
    const d = new THREE.Object3D()
    instances.forEach((v, i) => {
      d.position.set(v.x, v.y, v.z); d.rotation.set(v.rx ?? 0, v.ry, v.rz ?? 0); d.scale.setScalar(v.s); d.updateMatrix()
      ref.current!.setMatrixAt(i, d.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  }, [instances])
  return <instancedMesh ref={ref} args={[geo, mat, instances.length]} />
}

function BushLayerHolo({ instances, h, mat }: { instances: VegInstance[]; h: number; mat: THREE.ShaderMaterial }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => new THREE.IcosahedronGeometry(h * 0.45, 0), [h])

  useEffect(() => {
    if (!ref.current) return
    const grp = new THREE.Object3D()
    const loc = new THREE.Object3D()
    loc.position.set(0, h * 0.45, 0); loc.updateMatrix()
    const m = new THREE.Matrix4()
    instances.forEach((v, i) => {
      grp.position.set(v.x, v.y, v.z); grp.rotation.set(0, v.ry, 0); grp.scale.setScalar(v.s); grp.updateMatrix()
      ref.current!.setMatrixAt(i, m.multiplyMatrices(grp.matrix, loc.matrix))
    })
    ref.current.instanceMatrix.needsUpdate = true
  }, [instances, h])

  return <instancedMesh ref={ref} args={[geo, mat, instances.length]} />
}

function TreeLayerHolo({ instances, h, deciduous, matT, matL }: {
  instances: VegInstance[]; h: number; deciduous: boolean
  matT: THREE.ShaderMaterial; matL: THREE.ShaderMaterial
}) {
  const trunkRef   = useRef<THREE.InstancedMesh>(null)
  const canopy1Ref = useRef<THREE.InstancedMesh>(null)
  const canopy2Ref = useRef<THREE.InstancedMesh>(null)

  const trunkGeo   = useMemo(() => new THREE.CylinderGeometry(h * 0.035, h * 0.06, h * 0.4, 5), [h])
  const canopy1Geo = useMemo(() => deciduous
    ? new THREE.IcosahedronGeometry(h * 0.38, 0)
    : new THREE.ConeGeometry(h * 0.38, h * 0.55, 6), [h, deciduous])
  const canopy2Geo = useMemo(() => deciduous ? null : new THREE.ConeGeometry(h * 0.27, h * 0.42, 6), [h, deciduous])

  useEffect(() => {
    const grp = new THREE.Object3D()
    const loc = new THREE.Object3D()
    const m = new THREE.Matrix4()
    const fill = (ref: { current: THREE.InstancedMesh | null }, offsetY: number) => {
      if (!ref.current) return
      loc.position.set(0, offsetY, 0); loc.updateMatrix()
      instances.forEach((v, i) => {
        grp.position.set(v.x, v.y, v.z); grp.rotation.set(0, v.ry, 0); grp.scale.setScalar(v.s); grp.updateMatrix()
        ref.current!.setMatrixAt(i, m.multiplyMatrices(grp.matrix, loc.matrix))
      })
      ref.current.instanceMatrix.needsUpdate = true
    }
    fill(trunkRef,   h * 0.2)
    fill(canopy1Ref, deciduous ? h * 0.68 : h * 0.62)
    if (!deciduous) fill(canopy2Ref, h * 0.87)
  }, [instances, h, deciduous])

  return (
    <>
      <instancedMesh ref={trunkRef}   args={[trunkGeo,   matT, instances.length]} />
      {canopy1Geo && <instancedMesh ref={canopy1Ref} args={[canopy1Geo, matL, instances.length]} />}
      {canopy2Geo && <instancedMesh ref={canopy2Ref} args={[canopy2Geo, matL, instances.length]} />}
    </>
  )
}

function VegetationLayerHolo({ groups }: { groups: VegGroup[] }) {
  const matGrass = useMemo(() => makeHoloMaterial(HOLO_VEG_COLOR), [])
  const matBush  = useMemo(() => makeHoloMaterial(HOLO_VEG_COLOR), [])
  const matTrunk = useMemo(() => makeHoloMaterial('#00aaff'), [])
  const matLeaf  = useMemo(() => makeHoloMaterial(HOLO_VEG_COLOR), [])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    matGrass.uniforms.uTime.value = t
    matBush.uniforms.uTime.value  = t
    matTrunk.uniforms.uTime.value = t
    matLeaf.uniforms.uTime.value  = t
  })

  return (
    <>
      {groups.map(g => {
        const cfg = VEG_CFG[g.type]
        const h = cfg.baseH * g.scaleMult
        if (g.type === 'grass')        return <GrassLayerHolo key={g.id} instances={g.instances} h={h} mat={matGrass} />
        if (g.type.startsWith('bush')) return <BushLayerHolo  key={g.id} instances={g.instances} h={h} mat={matBush} />
        return <TreeLayerHolo key={g.id} instances={g.instances} h={h} deciduous={g.type.startsWith('tree-d')} matT={matTrunk} matL={matLeaf} />
      })}
    </>
  )
}

// ── Hologram model ────────────────────────────────────────────
function HoloModel({ url, vegGroups, onReady }: { url: string; vegGroups: VegGroup[]; onReady?: () => void }) {
  const { scene: src } = useGLTF(url)
  const { camera } = useThree()

  const { scene, mats } = useMemo(() => {
    const s = src.clone(true)
    const created: THREE.ShaderMaterial[] = []
    s.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      const m = makeHoloMaterial('#00d4ff')
      created.push(m)
      obj.material = m
    })
    return { scene: s, mats: created }
  }, [src])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    mats.forEach(m => { m.uniforms.uTime.value = t })
  })

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    scene.position.sub(center)
    const fov = 40
    const dist = (maxDim / (2 * Math.tan((fov * Math.PI) / 360))) * 1.1
    camera.position.set(dist * 0.7, dist * 0.35, dist * 0.85)
    camera.lookAt(0, 0, 0)
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = dist / 1000
      camera.far = dist * 10
      camera.updateProjectionMatrix()
    }
    onReady?.()
  }, [scene, camera])

  return (
    <>
      <primitive object={scene} />
      <VegetationLayerHolo groups={vegGroups} />
      <OrbitControls autoRotate autoRotateSpeed={0.4} enableZoom={false} enablePan={false} enableRotate={false} />
    </>
  )
}

// ── Public API ────────────────────────────────────────────────
const BG_KEY = 'bg_model_id'

export function BackgroundScene() {
  const { user } = useAuthStore()
  const { pathname } = useLocation()
  const [bgModelId, setBgModelId] = useState(() => localStorage.getItem(BG_KEY) ?? '')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    function onBgChange(e: Event) { setBgModelId((e as CustomEvent<{ modelId: string }>).detail.modelId) }
    window.addEventListener('bgmodelchange', onBgChange)
    return () => window.removeEventListener('bgmodelchange', onBgChange)
  }, [])

  const skip = !user || pathname.startsWith('/models') || pathname === '/login'

  const { data: modelRow } = useQuery({
    queryKey: ['bg-model-row', bgModelId],
    queryFn: async () => {
      const q = bgModelId
        ? supabase.from('model_files').select('id, file_path').eq('id', bgModelId).single()
        : supabase.from('model_files').select('id, file_path').limit(1).single()
      const { data } = await q
      return data as { id: string; file_path: string } | null
    },
    enabled: !skip,
    staleTime: Infinity,
  })

  const resolvedId = modelRow?.id ?? ''

  useEffect(() => { setReady(false) }, [resolvedId])

  const { data: vegGroups = [] } = useQuery({
    queryKey: ['bg-model-veg', resolvedId],
    queryFn: async () => {
      const { data } = await supabase.from('model_vegetation').select('data').eq('model_id', resolvedId).maybeSingle()
      return (data?.data ?? []) as VegGroup[]
    },
    enabled: !!resolvedId,
    staleTime: Infinity,
  })

  if (skip || !modelRow) return null

  const modelUrl = supabase.storage.from('models').getPublicUrl(modelRow.file_path).data.publicUrl

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none"
      style={{ zIndex: 0, opacity: ready ? 0.2 : 0, transition: 'opacity 1s ease-in-out' }}
    >
      {/* Scanlines overlay */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 4px)',
        zIndex: 2,
      }} />

      <SceneErrorBoundary>
        <Canvas
          dpr={1}
          gl={{ antialias: false, alpha: true }}
          camera={{ fov: 40 }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.3} />
          <Suspense fallback={null}>
            <HoloModel url={modelUrl} vegGroups={vegGroups} onReady={() => setReady(true)} />
            <EffectComposer>
              <Bloom
                intensity={1.8}
                luminanceThreshold={0.05}
                luminanceSmoothing={0.9}
                mipmapBlur
              />
              <ChromaticAberration
                blendFunction={BlendFunction.NORMAL}
                offset={new THREE.Vector2(0.0018, 0.0018)}
                radialModulation={false}
                modulationOffset={0}
              />
            </EffectComposer>
          </Suspense>
        </Canvas>
      </SceneErrorBoundary>
    </div>
  )
}

export function setBgModel(modelId: string) {
  localStorage.setItem(BG_KEY, modelId)
  window.dispatchEvent(new CustomEvent('bgmodelchange', { detail: { modelId } }))
}
