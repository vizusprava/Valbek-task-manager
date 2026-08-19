/**
 * Import 3D modelů: změření, syrové textury z GLB a georeferencování modelu z 3ds Maxu.
 *
 * three je tu JEN na čtení geometrie (nejnižší bod, vrcholy pro půdorys) — vykreslování si
 * Cesium dělá samo ze stejného souboru.
 */
import * as Cesium from 'cesium'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { wgsOf } from './tiles'
import { GEOID_CZ } from './config'
import { FOOT_MAX_TRIS_UNION, MASK_NAME_RE, concaveFootprint, simplifyRingCapped, unionOutlines } from './rings'
import type { Anchor } from './types'

// three loader jen pro změření modelu (nejnižší bod) — Cesium si model vykresluje sám
let gltfLoader: GLTFLoader | null = null
export function getGltfLoader(): GLTFLoader {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader()
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
    gltfLoader.setDRACOLoader(draco)
    gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  }
  return gltfLoader
}

// ── Textury z GLB (Google 3D dlaždice) ─────────────────────────────────────────────
// Obrázek bereme jako SYROVÉ bajty z BIN chunku, ne přes canvas — žádné překódování,
// takže JPEG z Googlu doputuje do zipu v původní kvalitě a bez čekání na ImageBitmap.

export type GltfJson = {
  images?: { bufferView?: number; mimeType?: string }[]
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[]
  bufferViews?: { byteOffset?: number; byteLength: number }[]
}
export type GltfParser = { json: GltfJson; associations?: Map<object, { textures?: number }> }

/** BIN chunk z GLB. null = není to binární glTF nebo BIN chybí. */
export function glbBin(buf: ArrayBuffer): Uint8Array | null {
  const dv = new DataView(buf)
  if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return null // 'glTF'
  let off = 12
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true)
    if (type === 0x004e4942) return new Uint8Array(buf, off + 8, Math.min(len, dv.byteLength - off - 8)) // 'BIN\0'
    off += 8 + len
  }
  return null
}

/** Kopie bajtů obrázku z GLB (slice, ne view — jinak by nám v paměti visely celé dlaždice). */
export function gltfImage(json: GltfJson, bin: Uint8Array | null, imgIdx: number): { bytes: Uint8Array; ext: string } | null {
  const img = json.images?.[imgIdx]
  if (!img || img.bufferView === undefined || !bin) return null
  const bv = json.bufferViews?.[img.bufferView]
  if (!bv) return null
  const mime = img.mimeType || ''
  if (mime.includes('ktx') || mime.includes('basis')) return null // MTL ani Max komprimované textury nepřečtou
  const start = bv.byteOffset || 0
  return { bytes: bin.slice(start, start + bv.byteLength), ext: mime.includes('png') ? 'png' : 'jpg' }
}

/** Index obrázku pro texturu materiálu — přes associations z GLTFLoaderu, jinak jediný obrázek v GLB. */
export function textureImageIndex(parser: GltfParser | undefined, json: GltfJson, tex: THREE.Texture | null): number | null {
  const ti = tex ? parser?.associations?.get(tex)?.textures : undefined
  if (ti !== undefined) {
    const td = json.textures?.[ti]
    const src = td?.source ?? (td?.extensions ? Object.values(td.extensions).find(e => e?.source !== undefined)?.source : undefined)
    if (src !== undefined) return src
  }
  return json.images?.length === 1 ? 0 : null
}

/** Nejnižší bod modelu (gltf Y-up = cesium Z-up). null = nezměřeno. */
export async function computeBottomZ(file: File): Promise<number | null> {
  try {
    const buf = await file.arrayBuffer()
    const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
      getGltfLoader().parse(buf, '', g => resolve(g as unknown as { scene: THREE.Object3D }), reject)
    })
    const box = new THREE.Box3().setFromObject(gltf.scene)
    return Number.isFinite(box.min.y) ? box.min.y : null
  } catch { return null }
}

/**
 * Model z 3ds Max s reálnými S-JTSK (EPSG:5514) souřadnicemi v geometrii → přemapuje každý vrchol
 * proj4 (S-JTSK→WGS84) + výška Bpv→elipsoid a zapeče do lokálního ENU rámce (E,U,-N) kolem těžiště,
 * stejnou konvencí jako náš export. Vrací glb URL + geo-kotvu. null = nevypadá jako S-JTSK (necháme ruční).
 * Osy/znaménko se detekují z dat: výška = osa s nejmenší velikostí, horizontály dle velikosti (v ČR |Y|>|X|),
 * proj4 chce záporné hodnoty.
 */

export async function georeferenceSjtskGlb(file: File): Promise<{ url: string; anchor: Anchor; bottomZ: number; footprint: Cesium.Cartesian3[][] | null } | null> {
  const buf = await file.arrayBuffer()
  const gltf = await new Promise<{ scene: THREE.Object3D }>((res, rej) => {
    getGltfLoader().parse(buf, '', g => res(g as unknown as { scene: THREE.Object3D }), rej)
  })
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  if (box.isEmpty()) return null
  const c = box.getCenter(new THREE.Vector3())
  const comp = (v: THREE.Vector3, a: 'x' | 'y' | 'z') => (a === 'x' ? v.x : a === 'y' ? v.y : v.z)
  // velké souřadnice (statisíce metrů) ⇒ S-JTSK; jinak běžný model
  if (Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) < 100000) return null

  const axes: Array<{ k: 'x' | 'y' | 'z'; val: number }> = [
    { k: 'x' as const, val: c.x }, { k: 'y' as const, val: c.y }, { k: 'z' as const, val: c.z },
  ].sort((a, b) => Math.abs(a.val) - Math.abs(b.val))
  const upAxis = axes[0].k                        // nejmenší velikost = výška
  const xAxis = axes[1].k, yAxis = axes[2].k       // menší horizontální = S-JTSK X, větší = Y
  const fx = axes[1].val > 0 ? -1 : 1              // proj4 EPSG:5514 chce záporné
  const fy = axes[2].val > 0 ? -1 : 1
  const toSjtsk = (v: THREE.Vector3): [number, number, number] => [fx * comp(v, xAxis), fy * comp(v, yAxis), comp(v, upAxis)]

  const [aLon, aLat] = wgsOf(fx * comp(c, xAxis), fy * comp(c, yAxis))
  const anchor: Anchor = { lon: aLon, lat: aLat, h: comp(c, upAxis) + GEOID_CZ }
  const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
  const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
  const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3(), vw = new THREE.Vector3()
  let minU = Infinity
  const allPts: [number, number][] = [] // ENU (east, north) všech vrcholů — fallback obrys celého modelu
  const maskTris = new Map<string, [number, number][][]>() // ENU trojúhelníky maskovacích objektů (podle názvu)

  const meshes: THREE.Mesh[] = []
  scene.traverse(obj => { const m = obj as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry
    const pos = g.attributes.position as THREE.BufferAttribute
    const wm = m.matrixWorld
    const isMask = MASK_NAME_RE.test(m.name)
    const meshEN: [number, number][] = isMask ? new Array(pos.count) : [] // ENU vrcholy jen u masky (pro trojúhelníky)
    for (let i = 0; i < pos.count; i++) {
      vw.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm) // do světových souřadnic (respektuj hierarchii)
      const [sx, sy, up] = toSjtsk(vw)
      const [lon, lat] = wgsOf(sx, sy)
      const e = Cesium.Cartesian3.fromDegrees(lon, lat, up + GEOID_CZ)
      s.x = e.x; s.y = e.y; s.z = e.z
      Cesium.Matrix4.multiplyByPoint(inv, s, o) // (east, north, up) v ENU kolem kotvy
      pos.setXYZ(i, o.x, o.z, -o.y)             // gltf (E, U, -N) — stejné jako buildExportScene
      if (o.z < minU) minU = o.z
      allPts.push([o.x, o.y])                   // ENU (east, north)
      if (isMask) meshEN[i] = [o.x, o.y]
    }
    if (isMask) {
      let tris = maskTris.get(m.name); if (!tris) { tris = []; maskTris.set(m.name, tris) }
      const idx = g.index
      if (idx) { for (let t = 0; t + 2 < idx.count; t += 3) tris.push([meshEN[idx.getX(t)], meshEN[idx.getX(t + 1)], meshEN[idx.getX(t + 2)]]) }
      else { for (let t = 0; t + 2 < meshEN.length; t += 3) tris.push([meshEN[t], meshEN[t + 1], meshEN[t + 2]]) }
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }
  // world transformy jsou zapečené do vrcholů → vynuluj všechny node transformy
  scene.traverse(obj => { obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix() })
  scene.updateMatrixWorld(true)

  const glbBuf = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(scene, r => res(r as ArrayBuffer), rej, { binary: true }))
  const url = URL.createObjectURL(new Blob([glbBuf], { type: 'model/gltf-binary' }))

  // obrys(y) půdorysu → svět přes kotvu (přesné, nezávislé na Cesium korekci os).
  // Maskovací objekty: přesný obrys geometrie (union trojúhelníků) → vhloubení zůstanou nevyříznutá.
  // Bez masek: konkávní obal celého modelu.
  const F = Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF)
  const enToWorld = (e: number, n: number) => Cesium.Matrix4.multiplyByPoint(F, new Cesium.Cartesian3(e, n, 0), new Cesium.Cartesian3())
  const footprint: Cesium.Cartesian3[][] = []
  if (maskTris.size) {
    for (const [name, tris] of maskTris) {
      let rings: [number, number][][]
      if (tris.length > FOOT_MAX_TRIS_UNION) { const cf = concaveFootprint(tris.flat()); rings = cf ? [cf] : []; console.warn(`Maska „${name}": ${tris.length} trojúhelníků je moc na přesný obrys → použit konkávní obal`) }
      else rings = unionOutlines(tris)
      for (const r of rings) { const simp = simplifyRingCapped(r); if (simp) footprint.push(simp.map(([e, n]) => enToWorld(e, n))) }
    }
  } else {
    const ring = concaveFootprint(allPts)
    if (ring) footprint.push(ring.map(([e, n]) => enToWorld(e, n)))
  }
  return { url, anchor, bottomZ: Number.isFinite(minU) ? minU : 0, footprint: footprint.length ? footprint : null }
}
