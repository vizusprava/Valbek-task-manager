import * as THREE from 'three'

export interface SceneNode {
  id: string
  name: string
  type: string
  depth: number
  object: THREE.Object3D
}

export type CameraState = { px: number; py: number; pz: number; tx: number; ty: number; tz: number }
export type CameraSaveResult = { canvas: HTMLCanvasElement; cameraState: CameraState }

export function setMeshGlow(mesh: THREE.Mesh, level: 0 | 1 | 2) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  mats.forEach(m => {
    if (!m || !('emissive' in m)) return
    const sm = m as THREE.MeshStandardMaterial
    if (level === 0) sm.emissive.setRGB(0, 0, 0)
    else if (level === 1) sm.emissive.setRGB(0.07, 0.07, 0.07)
    else sm.emissive.setRGB(0.12, 0.10, 0.02)
  })
}
