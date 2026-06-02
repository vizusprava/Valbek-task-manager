import { useRef, useEffect, useState, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { ModelAnnotation } from '@/lib/types'

export function MeasureTool({ active }: { active: boolean }) {
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
      if (dx * dx + dy * dy > 25) return
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

export function ScreenshotCapture({ takeFnRef, annotations, annotationsVisible, hiddenAnnotationIds }: {
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
