/* eslint-disable react-hooks/refs, react-hooks/set-state-in-effect -- imperativní raycast nástroj: ref drží aktuální stav pro DOM event handler, mutace probíhá záměrně */
import { useRef, useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ViewerAnnotation } from './adapter'

// vždy navrchu: vysoký renderOrder + materiál bez depth testu/zápisu (přes celý model)
const MEASURE_ORDER = 100000
const MEASURE_COLOR = '#f97316'
// společné props pro vždy-viditelné pixelové čáry (drei spreaduje i na materiál)
const LINE_OVERLAY = { color: MEASURE_COLOR, transparent: true, depthTest: false, depthWrite: false, renderOrder: MEASURE_ORDER } as const

/** Puntík v konstantní pixelové velikosti (jako tečka u anotace), vždy navrchu. */
function MeasureDot({ p }: { p: THREE.Vector3 }) {
  return (
    <Html position={[p.x, p.y, p.z]} center style={{ pointerEvents: 'none' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: MEASURE_COLOR, boxShadow: '0 0 6px rgba(249,115,22,0.9)' }} />
    </Html>
  )
}

const fmtDist = (d: number) => (d < 1 ? `${(d * 100).toFixed(1)} cm` : `${d.toFixed(3)} m`)

/** Spočítá směr odsazení kóty (kolmo na čáru); u svislé čáry vodorovně ke kameře. */
function measureOffset(a: THREE.Vector3, b: THREE.Vector3, camPos: THREE.Vector3): THREE.Vector3 {
  const dir = b.clone().sub(a).normalize()
  const up = new THREE.Vector3(0, 1, 0)
  const off = up.clone().addScaledVector(dir, -dir.dot(up))
  if (off.lengthSq() < 0.02) {
    const m = a.clone().lerp(b, 0.5)
    off.copy(camPos).sub(m); off.y = 0
    off.addScaledVector(dir, -dir.dot(off))
    if (off.lengthSq() < 1e-6) off.set(1, 0, 0)
  }
  return off.normalize()
}

/** Jedno měření = dva body + odsazená kóta tenkými čárami. Směr odsazení je předaný (fixní). */
function OneMeasure({ a, b, off }: { a: THREE.Vector3; b: THREE.Vector3; off: THREE.Vector3 }) {
  const dist = a.distanceTo(b)
  const lift = Math.min(0.5, Math.max(dist * 0.15, 0.12))
  const d = off.clone().multiplyScalar(lift)
  const r0 = a.clone().add(d)
  const r1 = b.clone().add(d)
  const mid = r0.clone().lerp(r1, 0.5)
  return (
    <>
      <MeasureDot p={a} />
      <MeasureDot p={b} />
      <Line points={[a, r0]} lineWidth={1.5} {...LINE_OVERLAY} />
      <Line points={[b, r1]} lineWidth={1.5} {...LINE_OVERLAY} />
      <Line points={[r0, r1]} lineWidth={2.5} {...LINE_OVERLAY} />
      <Html position={mid} center>
        <div className="bg-gray-900/90 text-orange-400 text-xs font-mono font-semibold px-2 py-1 rounded border border-orange-500/40 whitespace-nowrap pointer-events-none select-none shadow-lg">
          {fmtDist(dist)}
        </div>
      </Html>
    </>
  )
}

export type MeasureApi = { reset: () => void; undo: () => void }

export function MeasureTool({ active, apiRef, onCount }: {
  active: boolean
  apiRef?: { current: MeasureApi | null }
  onCount?: (n: number) => void
}) {
  const { camera, gl, scene } = useThree()
  const [measurements, setMeasurements] = useState<{ a: THREE.Vector3; b: THREE.Vector3; off: THREE.Vector3 }[]>([])
  const [pending, setPending] = useState<THREE.Vector3 | null>(null)
  const pendRef = useRef<THREE.Vector3 | null>(null)
  pendRef.current = pending
  const downXY = useRef({ x: 0, y: 0 })

  useEffect(() => { if (!active) setPending(null) }, [active])
  useEffect(() => { onCount?.(measurements.length) }, [measurements, onCount])

  // imperativní reset/undo pro DOM ovládání ve Vieweru
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      reset: () => { setMeasurements([]); setPending(null) },
      undo: () => {
        if (pendRef.current) setPending(null)
        else setMeasurements(m => m.slice(0, -1))
      },
    }
    return () => { apiRef.current = null }
  }, [apiRef])

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
      if (dx * dx + dy * dy > 25) return
      const rect = canvas.getBoundingClientRect()
      const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
      const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
      rc.setFromCamera(new THREE.Vector2(x, y), camera)
      const meshes: THREE.Object3D[] = []
      scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o) })
      const hits = rc.intersectObjects(meshes, false)
      if (hits.length === 0) return
      const p = hits[0].point.clone()
      if (pendRef.current === null) setPending(p)
      else {
        const a = pendRef.current
        const off = measureOffset(a, p, camera.position) // směr odsazení spočítán jednou, pak fixní
        setMeasurements(m => [...m, { a, b: p, off }])
        setPending(null)
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup',   onPointerUp)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup',   onPointerUp)
    }
  }, [active, camera, gl, scene])

  if (measurements.length === 0 && !pending) return null

  return (
    <group>
      {measurements.map((m, i) => <OneMeasure key={i} a={m.a} b={m.b} off={m.off} />)}
      {pending && <MeasureDot p={pending} />}
    </group>
  )
}

export function ScreenshotCapture({ takeFnRef, annotations, annotationsVisible, hiddenAnnotationIds }: {
  takeFnRef: { current: (() => void) | null }
  annotations: ViewerAnnotation[]
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
        const r = src.width / src.clientWidth

        annotations.forEach(ann => {
          if (hiddenAnnotationIds.has(ann.id)) return
          const pos = new THREE.Vector3(ann.x, ann.y, ann.z).project(camera)
          if (pos.z > 1) return

          const sx = (pos.x *  0.5 + 0.5) * src.width
          const sy = (pos.y * -0.5 + 0.5) * src.height

          ctx.beginPath()
          ctx.arc(sx, sy, 3.5 * r, 0, Math.PI * 2)
          ctx.fillStyle = '#818cf8'
          ctx.fill()

          const stemH = 16 * r
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(sx, sy - stemH)
          ctx.strokeStyle = 'rgba(129,140,248,0.8)'
          ctx.lineWidth = r
          ctx.stroke()

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

          ctx.fillStyle   = 'rgba(10,12,20,0.95)'
          ctx.strokeStyle = 'rgba(99,102,241,0.5)'
          ctx.lineWidth   = r
          ctx.beginPath()
          ;(ctx as any).roundRect(boxX, boxY, boxW, boxH, rad)
          ctx.fill(); ctx.stroke()

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
