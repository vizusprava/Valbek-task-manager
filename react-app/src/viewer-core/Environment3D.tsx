/* eslint-disable react-hooks/refs, react-hooks/immutability -- imperativní three.js API: clipping planes, helpery a bounds ref se mutují záměrně */
import { useRef, useMemo, useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import { EffectComposer, N8AO, Bloom, SMAA } from '@react-three/postprocessing'
import * as THREE from 'three'
import { mulberry32 } from './Vegetation'
import type { CameraState } from './shared'

/** Sleduje boundsRef a vrátí bounds, jakmile je model načtený. */
function useBounds(boundsRef: { current: THREE.Box3 | null }) {
  const [bounds, setBounds] = useState<THREE.Box3 | null>(boundsRef.current)
  useFrame(() => {
    if (boundsRef.current !== bounds) setBounds(boundsRef.current)
  })
  return bounds
}

export type SkyPreset = 'morning' | 'afternoon' | 'evening'

// HDRI obloha = pozadí i odrazy zároveň; směrové slunce drží stíny zarovnané s presetem
const SKY_PRESETS: Record<SkyPreset, {
  env: 'dawn' | 'park' | 'sunset'
  dir: THREE.Vector3
  color: string
  intensity: number
  hemi: number
}> = {
  morning:   { env: 'dawn',   dir: new THREE.Vector3( 0.85, 0.35,  0.40).normalize(), color: '#ffe2c0', intensity: 1.9, hemi: 0.55 },
  afternoon: { env: 'park',   dir: new THREE.Vector3( 0.40, 0.88,  0.30).normalize(), color: '#fff5e6', intensity: 2.4, hemi: 0.65 },
  evening:   { env: 'sunset', dir: new THREE.Vector3(-0.82, 0.28, -0.30).normalize(), color: '#ffb472', intensity: 1.7, hemi: 0.45 },
}

/**
 * Venkovní obloha přes HDRI preset (ráno/odpoledne/večer) — slouží jako pozadí i odrazová
 * mapa najednou. Směrové slunce přidává ostré stíny zarovnané s daným presetem.
 */
export function HdriSky({ preset, rotation = 0, boundsRef, shadowRadius = 5 }: {
  preset: SkyPreset
  /** otočení oblohy kolem svislé osy ve stupních (background, odrazy i slunce) */
  rotation?: number
  boundsRef: { current: THREE.Box3 | null }
  shadowRadius?: number
}) {
  const { scene } = useThree()
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const bounds = useBounds(boundsRef)
  const cfg = SKY_PRESETS[preset] ?? SKY_PRESETS.afternoon
  const rad = THREE.MathUtils.degToRad(rotation)
  // slunce se otáčí spolu s oblohou, ať stíny sedí s viditelnou polohou slunce v HDRI
  const dir = useMemo(() => cfg.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rad), [cfg, rad])

  const center = useMemo(() => bounds ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(), [bounds])
  const maxDim = useMemo(() => {
    if (!bounds) return 50
    const s = bounds.getSize(new THREE.Vector3())
    return Math.max(s.x, s.y, s.z)
  }, [bounds])

  useEffect(() => {
    const light = lightRef.current
    if (!light) return
    scene.add(light.target)
    light.target.position.copy(center)
    light.target.updateMatrixWorld()
    return () => { scene.remove(light.target) }
  }, [scene, center])

  useEffect(() => {
    const light = lightRef.current
    if (!light) return
    const span = maxDim * 0.9
    const cam = light.shadow.camera as THREE.OrthographicCamera
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span
    cam.near = 0.1; cam.far = maxDim * 8
    cam.updateProjectionMatrix()
    light.shadow.normalBias = maxDim * 0.002
    light.shadow.radius = shadowRadius
  }, [maxDim, shadowRadius])

  return (
    <>
      <Environment preset={cfg.env} background backgroundRotation={[0, rad, 0]} environmentRotation={[0, rad, 0]} />
      <hemisphereLight args={['#bcd6f5', '#3c4034', cfg.hemi]} />
      <directionalLight
        ref={lightRef}
        position={[center.x + dir.x * maxDim * 2, center.y + dir.y * maxDim * 2, center.z + dir.z * maxDim * 2]}
        intensity={cfg.intensity}
        color={cfg.color}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0002}
      />
    </>
  )
}

/** Světla pro Studio režim. Se zapnutým terénem hlavní světlo vrhá stíny, jinak původní vzhled beze změny. */
export function StudioLights({ boundsRef, shadows, shadowRadius = 5 }: {
  boundsRef: { current: THREE.Box3 | null }
  shadows: boolean
  shadowRadius?: number
}) {
  const { scene } = useThree()
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const bounds = useBounds(boundsRef)

  const center = useMemo(() => bounds ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(), [bounds])
  const maxDim = useMemo(() => {
    if (!bounds) return 50
    const s = bounds.getSize(new THREE.Vector3())
    return Math.max(s.x, s.y, s.z)
  }, [bounds])
  const dir = useMemo(() => new THREE.Vector3(10, 20, 10).normalize(), [])

  useEffect(() => {
    const light = lightRef.current
    if (!light || !shadows) return
    scene.add(light.target)
    light.target.position.copy(center)
    light.target.updateMatrixWorld()
    return () => { scene.remove(light.target) }
  }, [scene, center, shadows])

  useEffect(() => {
    const light = lightRef.current
    if (!light || !shadows) return
    const span = maxDim * 0.9
    const cam = light.shadow.camera as THREE.OrthographicCamera
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span
    cam.near = 0.1; cam.far = maxDim * 8
    cam.updateProjectionMatrix()
    light.shadow.normalBias = maxDim * 0.002
    light.shadow.radius = shadowRadius
  }, [maxDim, shadows, shadowRadius])

  return (
    <>
      <ambientLight intensity={0.6} />
      {shadows ? (
        <directionalLight
          ref={lightRef}
          position={[center.x + dir.x * maxDim * 2, center.y + dir.y * maxDim * 2, center.z + dir.z * maxDim * 2]}
          intensity={1.4}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0002}
        />
      ) : (
        <directionalLight position={[10, 20, 10]} intensity={1.4} />
      )}
      <directionalLight position={[-8, -4, -8]} intensity={0.35} />
    </>
  )
}

/** Procedurální alpha mapa „ostrova" — radiální fade s nepravidelným okrajem. */
function makeIslandAlphaMap(seed: number): THREE.CanvasTexture {
  const S = 1024
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(S, S)
  const rng = mulberry32(seed)
  const p = Array.from({ length: 6 }, () => rng() * Math.PI * 2)

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2)
      const dy = (y - S / 2) / (S / 2)
      const r = Math.hypot(dx, dy)
      const a = Math.atan2(dy, dx)
      // nepravidelný práh okraje (vč. vysokofrekvenčního zubatění) + úzký fade, ať okraj není rozplizlý
      const thr  = 0.74 + 0.08 * Math.sin(3 * a + p[0]) + 0.05 * Math.sin(7 * a + p[1]) + 0.03 * Math.sin(13 * a + p[2]) + 0.02 * Math.sin(23 * a + p[3]) + 0.012 * Math.sin(41 * a + p[4]) + 0.008 * Math.sin(67 * a + p[5])
      const fade = 0.06 + 0.03 * Math.sin(5 * a + p[4]) + 0.015 * Math.sin(11 * a + p[5])
      let v = (thr - r) / Math.max(fade, 0.02) + 1
      v = Math.min(1, Math.max(0, v))
      v = v * v * (3 - 2 * v) // smoothstep
      const i = (y * S + x) * 4
      const byte = Math.round(v * 255)
      img.data[i] = byte; img.data[i + 1] = byte; img.data[i + 2] = byte; img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export function GroundPlane({ boundsRef, offsetY = 0, seed = 7 }: {
  boundsRef: { current: THREE.Box3 | null }
  /** Posun výšky terénu, -1..1 (zlomek velikosti modelu). 0 = nejspodnější vertex modelu. */
  offsetY?: number
  seed?: number
}) {
  const bounds = useBounds(boundsRef)
  const alphaMap = useMemo(() => makeIslandAlphaMap(seed), [seed])
  useEffect(() => () => { alphaMap.dispose() }, [alphaMap])

  if (!bounds) return null
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const radius = maxDim * 1.7

  return (
    <mesh
      position={[center.x, bounds.min.y - maxDim * 0.0015 + offsetY * maxDim * 0.15, center.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
      renderOrder={-1}
    >
      <circleGeometry args={[radius, 128]} />
      {/* depthWrite: true — části modelu pod terénem se schovají, takže je vidět přesný kontakt se zemí */}
      <meshStandardMaterial
        color="#3d4238"
        roughness={1}
        metalness={0}
        alphaMap={alphaMap}
        transparent
        alphaTest={0.02}
        depthWrite
        userData={{ noClip: true }}
      />
    </mesh>
  )
}

const AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
} as const

const OTHER_AXES: Record<'x' | 'y' | 'z', ['x' | 'y' | 'z', 'x' | 'y' | 'z']> = {
  x: ['y', 'z'],
  y: ['x', 'z'],
  z: ['x', 'y'],
}

// průhledný klon modelu pro odříznutou stranu — sdílí geometrii, vlastní průhledné materiály
function makeGhostClone(root: THREE.Object3D, invPlane: THREE.Plane): THREE.Object3D {
  const clone = root.clone(true)
  const toRemove: THREE.Object3D[] = []
  clone.traverse(o => {
    if ((o as THREE.LineSegments).isLineSegments) { toRemove.push(o); return }
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const conv = (mm: THREE.Material) => {
      const c = mm.clone() as THREE.MeshStandardMaterial
      c.transparent = true
      c.opacity = 0.16
      c.depthWrite = false       // ať odříznutá skořápka neschová vnitřek
      c.side = THREE.DoubleSide
      c.clippingPlanes = [invPlane]
      c.userData = { noClip: true } // hlavní clip apply() se ho nedotýká
      return c as THREE.Material
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.raycast = () => {}
  })
  toRemove.forEach(o => o.parent?.remove(o))
  return clone
}

export function SectionPlane({ active, axis, offset, flip, rotA = 0, rotB = 0, ghost = false, modelRoot = null, showHelper, boundsRef }: {
  active: boolean
  axis: 'x' | 'y' | 'z'
  offset: number // 0..1 podél bboxu
  flip: boolean
  /** natočení roviny kolem zbylých dvou os, ve stupních */
  rotA?: number
  rotB?: number
  /** odříznutou část zobrazit průhledně (přidá průhledný klon s obrácenou rovinou) */
  ghost?: boolean
  /** kořen načteného modelu — potřeba pro ghost klon */
  modelRoot?: THREE.Object3D | null
  showHelper: boolean
  boundsRef: { current: THREE.Box3 | null }
}) {
  const { gl, scene } = useThree()
  const bounds = useBounds(boundsRef)
  const frameRef = useRef(0)

  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), [])
  const invPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), [])
  const planesRef = useRef<THREE.Plane[]>([])

  useEffect(() => {
    gl.localClippingEnabled = true
    return () => { gl.localClippingEnabled = false }
  }, [gl])

  // tvrdý clip na materiály modelu (terén i ghost klon mají noClip → nedotčené)
  function apply() {
    const planes = planesRef.current.length ? planesRef.current : null
    scene.traverse(obj => {
      const m = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m) return
      const mats = Array.isArray(m) ? m : [m]
      mats.forEach(mat => {
        if (!mat || mat.userData?.noClip) return
        if (mat.clippingPlanes !== planes) mat.clippingPlanes = planes
      })
    })
  }

  useEffect(() => {
    if (!active || !bounds) {
      planesRef.current = []
      apply()
      return
    }
    const n = AXIS_VECTORS[axis].clone()
    const [oa, ob] = OTHER_AXES[axis]
    n.applyAxisAngle(AXIS_VECTORS[oa], THREE.MathUtils.degToRad(rotA))
    n.applyAxisAngle(AXIS_VECTORS[ob], THREE.MathUtils.degToRad(rotB))
    if (!flip) n.negate()
    const point = bounds.getCenter(new THREE.Vector3())
    point[axis] = THREE.MathUtils.lerp(bounds.min[axis], bounds.max[axis], offset)
    plane.setFromNormalAndCoplanarPoint(n, point)
    invPlane.copy(plane).negate()
    planesRef.current = [plane]
    apply()
    return () => { planesRef.current = []; apply() }
  }, [plane, invPlane, active, axis, offset, flip, rotA, rotB, bounds]) // eslint-disable-line react-hooks/exhaustive-deps

  // throttlovaný dosběr — řez musí chytit i materiály vzniklé později (vegetace, wireframe)
  useFrame(() => {
    frameRef.current++
    if (frameRef.current % 15 !== 0) return
    apply()
  })

  const ghostClone = useMemo(() => (modelRoot ? makeGhostClone(modelRoot, invPlane) : null), [modelRoot, invPlane])

  const helper = useMemo(() => {
    if (!active || !showHelper || !bounds) return null
    const size = bounds.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    return new THREE.PlaneHelper(plane, maxDim * 1.3, 0xf97316)
  }, [plane, active, showHelper, bounds])

  // helper sám nesmí být ořezán ani vrhat raycast
  useEffect(() => {
    if (!helper) return
    const mat = helper.material as THREE.Material
    mat.userData.noClip = true
    helper.raycast = () => {}
  }, [helper])

  return (
    <>
      {ghost && active && ghostClone && <primitive object={ghostClone} />}
      {helper && <primitive object={helper} />}
    </>
  )
}

/** Kriticky tlumený SmoothDamp (Unity-style) per složku vektoru — mutuje `cur` i `vel`. */
function smoothDampV3(cur: THREE.Vector3, tar: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  const omega = 2 / smoothTime
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const axes = ['x', 'y', 'z'] as const
  for (const k of axes) {
    const change = cur[k] - tar[k]
    const temp = (vel[k] + omega * change) * dt
    vel[k] = (vel[k] - omega * temp) * exp
    cur[k] = tar[k] + (change + temp) * exp
  }
}

/**
 * Plynulý přelet kamery na uložený pohled kriticky tlumenou pružinou.
 * Při změně cíle za letu si drží rychlost → žádné zastavení a cuk mezi přelety.
 * Po dojezdu se uvolní, aby šlo normálně orbitovat.
 */
export function CameraFlyTo({ target, nonce, smoothTime = 0.85 }: {
  target: CameraState | null
  nonce: number
  smoothTime?: number
}) {
  const { camera, controls } = useThree()
  const active     = useRef(false)
  const posTarget  = useRef(new THREE.Vector3())
  const lookTarget = useRef(new THREE.Vector3())
  const posVel     = useRef(new THREE.Vector3())
  const lookVel    = useRef(new THREE.Vector3())
  const startDist  = useRef(0)
  const elapsed    = useRef(0)

  useEffect(() => {
    if (!target || nonce === 0 || !controls) return
    posTarget.current.set(target.px, target.py, target.pz)
    lookTarget.current.set(target.tx, target.ty, target.tz)
    startDist.current = camera.position.distanceTo(posTarget.current)
    elapsed.current = 0
    active.current = true
    // rychlost ZÁMĚRNĚ neresetujeme — při přesměrování za letu plyne dál
  }, [nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt) => {
    if (!active.current || !controls) return
    const ctrl = controls as unknown as { target: THREE.Vector3; update: () => void }
    const dtc = Math.min(dt, 0.05) // stabilita při výpadku snímků
    elapsed.current += dtc

    smoothDampV3(camera.position, posTarget.current, posVel.current, smoothTime, dtc)
    smoothDampV3(ctrl.target, lookTarget.current, lookVel.current, smoothTime, dtc)
    ctrl.update()

    // uvolnit BEZ skoku — až když je vzdálenost i rychlost zanedbatelná (jinak by snap cuknul)
    const near = camera.position.distanceTo(posTarget.current) < Math.max(startDist.current * 0.0015, 1e-4)
    const slow = posVel.current.length() < Math.max(startDist.current * 0.01, 1e-4)
    if ((near && slow) || elapsed.current > 5) {
      posVel.current.setScalar(0); lookVel.current.setScalar(0)
      active.current = false
    }
  })

  return null
}

const TONE_MAPPINGS = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
} as const

export type ToneMappingMode = keyof typeof TONE_MAPPINGS

/** Přepínání tone mappingu za běhu — vyžaduje rekompilaci materiálů (needsUpdate). */
export function ToneMapping({ mode, exposure }: { mode: ToneMappingMode; exposure: number }) {
  const { gl, scene } = useThree()

  useEffect(() => {
    gl.toneMapping = TONE_MAPPINGS[mode] ?? THREE.ACESFilmicToneMapping
    scene.traverse(obj => {
      const m = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m) return
      const mats = Array.isArray(m) ? m : [m]
      mats.forEach(mat => { if (mat) mat.needsUpdate = true })
    })
  }, [gl, scene, mode])

  useEffect(() => {
    gl.toneMappingExposure = exposure
  }, [gl, exposure])

  return null
}

export function Effects({ bloom }: { bloom: boolean }) {
  // dvě varianty kompozice — podmíněné children uvnitř EffectComposer dělají potíže
  if (bloom) {
    return (
      <EffectComposer multisampling={0}>
        <N8AO quality="medium" aoRadius={48} screenSpaceRadius intensity={3} halfRes />
        <Bloom intensity={0.25} luminanceThreshold={0.85} mipmapBlur />
        <SMAA />
      </EffectComposer>
    )
  }
  return (
    <EffectComposer multisampling={0}>
      <N8AO quality="medium" aoRadius={48} screenSpaceRadius intensity={3} halfRes />
      <SMAA />
    </EffectComposer>
  )
}
