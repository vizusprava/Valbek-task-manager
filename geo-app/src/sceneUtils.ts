/**
 * Drobní pomocníci nad viewrem a usazením modelu: co je pod kurzorem, kam se kamera dívá
 * a jak z kotvy poskládat transformační matici.
 */
import * as Cesium from 'cesium'
import type { GroundHit, Placement } from './types'

/** Najde 3D bod povrchu (terén/dlaždice) pod daným bodem obrazovky. */
export function pickGround(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const scene = v.scene
  let cart: Cesium.Cartesian3 | undefined
  if (scene.pickPositionSupported) {
    const c = scene.pickPosition(screen)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) {
    const ray = v.camera.getPickRay(screen)
    if (ray) { const c = scene.globe.pick(ray, scene); if (Cesium.defined(c)) cart = c }
  }
  if (!cart) {
    const c = v.camera.pickEllipsoid(screen, scene.globe.ellipsoid)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Bod terénu pod kurzorem nezávisle na modelu (globe.pick ignoruje primitivy modelu). */
export function pickTerrain(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const ray = v.camera.getPickRay(screen)
  let cart = ray ? v.scene.globe.pick(ray, v.scene) : undefined
  if (!Cesium.defined(cart)) cart = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid)
  if (!Cesium.defined(cart)) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Povrch pod středem obrazovky (kam se zhruba dívá kamera). */
export function viewCenterGround(v: Cesium.Viewer): GroundHit {
  const canvas = v.scene.canvas
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
  const hit = pickGround(v, center)
  if (hit) return hit
  const carto = v.camera.positionCartographic
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: 0 }
}

export function positionOf(p: Placement): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.groundH + p.heightOffset)
}

export function buildMatrix(p: Placement, centerOffset: Cesium.Cartesian3, yawDeg = 0): Cesium.Matrix4 {
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(p.heading + yawDeg),
    Cesium.Math.toRadians(p.pitch),
    Cesium.Math.toRadians(p.roll),
  )
  const frame = Cesium.Transforms.headingPitchRollToFixedFrame(positionOf(p), hpr)
  const scaled = Cesium.Matrix4.multiplyByUniformScale(frame, p.scale, new Cesium.Matrix4())
  const tneg = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.negate(centerOffset, new Cesium.Cartesian3()))
  return Cesium.Matrix4.multiply(scaled, tneg, new Cesium.Matrix4())
}
