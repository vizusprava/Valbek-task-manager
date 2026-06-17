import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'

export type VegType = 'grass' | 'bush-s' | 'bush-m' | 'bush-l' | 'tree-s' | 'tree-m' | 'tree-l' | 'tree-ds' | 'tree-dm' | 'tree-dl'

export interface VegInstance { x: number; y: number; z: number; ry: number; s: number; rx?: number; rz?: number }

export interface VegGroup {
  id: string
  type: VegType
  targetName: string
  scaleMult: number
  instances: VegInstance[]
  mode: 'scatter' | 'click'
  seed?: number
  count?: number
  patched?: boolean
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const VEG_CFG: Record<VegType, { label: string; count: number; baseH: number; color: string; trunkColor?: string }> = {
  'grass':   { label: 'Tráva',      count: 2000, baseH: 0.12, color: '#6fcf7c' },
  'bush-s':  { label: 'Keř S',      count: 30,   baseH: 0.50, color: '#4a9e5c' },
  'bush-m':  { label: 'Keř M',      count: 20,   baseH: 1.00, color: '#3a8a4a' },
  'bush-l':  { label: 'Keř L',      count: 12,   baseH: 1.80, color: '#2d7040' },
  'tree-s':  { label: 'Jehlič. S',  count: 10,   baseH: 2.50, color: '#4a7c59', trunkColor: '#795548' },
  'tree-m':  { label: 'Jehlič. M',  count: 7,    baseH: 5.00, color: '#3d6b4f', trunkColor: '#6d4c41' },
  'tree-l':  { label: 'Jehlič. L',  count: 4,    baseH: 8.00, color: '#2d5a3f', trunkColor: '#5d4037' },
  'tree-ds': { label: 'Listnatý S', count: 10,   baseH: 2.50, color: '#6aaa3a', trunkColor: '#8d6e63' },
  'tree-dm': { label: 'Listnatý M', count: 7,    baseH: 5.00, color: '#5a9a2a', trunkColor: '#795548' },
  'tree-dl': { label: 'Listnatý L', count: 4,    baseH: 8.00, color: '#4a8a1a', trunkColor: '#6d4c41' },
}

export function scatterOnMesh(mesh: THREE.Mesh, count: number, patched = false, rng: () => number = Math.random): VegInstance[] {
  mesh.updateWorldMatrix(true, false)
  const bbox = new THREE.Box3().setFromObject(mesh)
  const size = bbox.getSize(new THREE.Vector3())
  const ray  = new THREE.Raycaster()
  const dn   = new THREE.Vector3(0, -1, 0)
  const out: VegInstance[] = []

  const patchSeeds: { x: number; z: number }[] = []
  if (patched) {
    const nPatches = Math.max(4, Math.round(Math.sqrt(count) * 0.6))
    const patchR   = Math.max(size.x, size.z) * 0.18
    for (let p = 0; p < nPatches * 5 && patchSeeds.length < nPatches; p++) {
      const cx = THREE.MathUtils.lerp(bbox.min.x, bbox.max.x, rng())
      const cz = THREE.MathUtils.lerp(bbox.min.z, bbox.max.z, rng())
      ray.set(new THREE.Vector3(cx, bbox.max.y + 1, cz), dn)
      if (ray.intersectObject(mesh, true).length) patchSeeds.push({ x: cx, z: cz })
    }
    // eslint-disable-next-line no-param-reassign
    if (!patchSeeds.length) patched = false
    else {
      const r = patchR
      for (let i = 0; i < count * 20 && out.length < count; i++) {
        const ps   = patchSeeds[Math.floor(rng() * patchSeeds.length)]
        const angle = rng() * Math.PI * 2
        const dist  = Math.sqrt(rng()) * r
        const x = ps.x + Math.cos(angle) * dist
        const z = ps.z + Math.sin(angle) * dist
        ray.set(new THREE.Vector3(x, bbox.max.y + 1, z), dn)
        const hits = ray.intersectObject(mesh, true)
        if (hits.length)
          out.push({ x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z, ry: rng() * Math.PI * 2, s: 0.75 + rng() * 0.5, rx: (rng() - 0.5) * 0.28, rz: (rng() - 0.5) * 0.28 })
      }
      return out
    }
  }

  for (let i = 0; i < count * 10 && out.length < count; i++) {
    const x = THREE.MathUtils.lerp(bbox.min.x, bbox.max.x, rng())
    const z = THREE.MathUtils.lerp(bbox.min.z, bbox.max.z, rng())
    ray.set(new THREE.Vector3(x, bbox.max.y + 1, z), dn)
    const hits = ray.intersectObject(mesh, true)
    if (hits.length)
      out.push({ x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z, ry: rng() * Math.PI * 2, s: 0.75 + rng() * 0.5, rx: (rng() - 0.5) * 0.28, rz: (rng() - 0.5) * 0.28 })
  }
  return out
}

function GrassLayer({ instances, color, h }: { instances: VegInstance[]; color: string; h: number }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => {
    const w = 0.022 * h / 0.12
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
  return <instancedMesh ref={ref} args={[geo, mat, instances.length]} receiveShadow />
}

function BushInst({ v, color, h }: { v: VegInstance; color: string; h: number }) {
  const r = h * 0.45
  return (
    <group position={[v.x, v.y, v.z]} rotation={[0, v.ry, 0]} scale={v.s}>
      <mesh position={[0, r * 0.9, 0]} castShadow>
        <icosahedronGeometry args={[r, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  )
}

function TreeInst({ v, color, trunkColor, h }: { v: VegInstance; color: string; trunkColor: string; h: number }) {
  return (
    <group position={[v.x, v.y, v.z]} rotation={[0, v.ry, 0]} scale={v.s}>
      <mesh position={[0, h * 0.18, 0]} castShadow>
        <cylinderGeometry args={[h * 0.035, h * 0.06, h * 0.36, 5]} />
        <meshStandardMaterial color={trunkColor} flatShading />
      </mesh>
      <mesh position={[0, h * 0.62, 0]} castShadow>
        <coneGeometry args={[h * 0.38, h * 0.55, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh position={[0, h * 0.87, 0]} castShadow>
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
      <mesh position={[0, h * 0.22, 0]} castShadow>
        <cylinderGeometry args={[h * 0.028, h * 0.048, h * 0.44, 5]} />
        <meshStandardMaterial color={trunkColor} flatShading />
      </mesh>
      <mesh position={[0, h * 0.68, 0]} castShadow>
        <icosahedronGeometry args={[r, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh position={[h * 0.12, h * 0.88, 0]} castShadow>
        <icosahedronGeometry args={[r * 0.55, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh position={[-h * 0.10, h * 0.84, h * 0.08]} castShadow>
        <icosahedronGeometry args={[r * 0.48, 0]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  )
}

export function VegetationLayer({ groups }: { groups: VegGroup[] }) {
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
