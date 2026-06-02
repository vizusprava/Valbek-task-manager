import { useRef, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, useProgress } from '@react-three/drei'
import * as THREE from 'three'
import type { CameraState, CameraSaveResult } from './shared'

export function Loader() {
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

export function CameraNearFarSync() {
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

export function FocusTarget({ disabled }: { disabled: boolean }) {
  const { camera, controls, gl, scene } = useThree()
  const disabledRef = useRef(disabled)
  const controlsRef = useRef<any>(null)
  const animating   = useRef(false)
  const progress    = useRef(0)
  const fromTarget  = useRef(new THREE.Vector3())
  const toTarget    = useRef(new THREE.Vector3())

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
  }, [camera, gl, scene])

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

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _fwd   = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up    = new THREE.Vector3(0, 1, 0)

export function FlyCamera({ speedRef, onFlyChange }: {
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

export function CameraPersist({ modelId, boundsRef, saveFnRef, initialCameraState }: {
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

export function FlyToAnnotation({ pos, boundsRef }: {
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

export function CameraRig({ commandRef, boundsRef }: {
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
