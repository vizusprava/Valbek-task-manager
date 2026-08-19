/**
 * REFERENČNÍ export meshe z Google 3D dlaždic pro vybranou oblast.
 *
 * Geometrie se tahá z už VYKRESLENÝCH dlaždic (`_selectedTiles` na tilesetu), přetransformuje se
 * do reálného S-JTSK (lícuje s exportem terénu) a ořízne na hranici výběru. Textury jdou do zipu
 * syrové z GLB, bez překódování přes canvas — JPEG od Googlu tak dorazí v původní kvalitě.
 *
 * POZOR: Google Photorealistic 3D Tiles mají v licenci omezení na odvozené modely — výstup je
 * použitelný jen jako interní reference výšek a tvarů při modelování.
 */
import * as Cesium from 'cesium'
import * as THREE from 'three'
import polygonClipping from 'polygon-clipping'
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { sjtskOf, concatBytes, buildMaxScriptFiles } from '../tiles'
import { GEOID_CZ } from '../config'
import { pointInRing } from '../rings'
import { getGltfLoader, glbBin, gltfImage, textureImageIndex, type GltfJson, type GltfParser } from '../model3d'
import { download } from '../exportUtils'
import { throwIfAborted, type ExportCtx } from './ctx'

/** Dlaždice tak, jak ji drží Cesium3DTileset._selectedTiles (v typech není). */
export type GoogleTile = { _contentResource?: Cesium.Resource; content?: unknown; computedTransform: Cesium.Matrix4 }

export async function exportGoogleMesh(tiles: GoogleTile[], polys: [number, number][][][], ctx: ExportCtx): Promise<string> {
  // 1) výběr → S-JTSK obrysy + bbox (stejná konvence jako výřez terénu, aby to lícovalo)
  let merged: [number, number][][][]
  try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] } catch { merged = polys }
  const rings: number[][][] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of merged) {
    const outer = poly[0].map(([lo, la]) => sjtskOf(lo, la) as number[])
    if (outer.length < 3) continue
    for (const [x, y] of outer) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    rings.push(outer)
  }
  if (!rings.length) throw new Error('Výběr nemá platnou plochu')
  const inSel = (x: number, y: number) => rings.some(r => pointInRing(x, y, r))

  // 2) unikátní dlaždice s obsahem
  const uniq = new Map<string, { _contentResource?: Cesium.Resource; computedTransform: Cesium.Matrix4 }>()
  for (const t of tiles) { const cr = t._contentResource; if (cr && t.content) uniq.set(cr.url, t) }
  if (!uniq.size) throw new Error('Žádné načtené Google dlaždice s obsahem')

  // 3) projdi dlaždice, vytáhni trojúhelníky uvnitř výběru
  const loader = getGltfLoader()
  const YUP = (Cesium.Axis as unknown as { Y_UP_TO_Z_UP: Cesium.Matrix4 }).Y_UP_TO_Z_UP // v typech chybí, runtime OK
  const world = new Cesium.Matrix4(), ecef = new Cesium.Cartesian3(), vwT = new THREE.Vector3()
  const dedup = new Map<string, number>()
  const vChunks: string[] = [], vtChunks: string[] = []
  const faceByMat = new Map<string, string[]>()                            // materiál (= textura dlaždice) → f řádky
  const texByKey = new Map<string, string>()                               // dlaždice#obrázek → jméno materiálu
  const texFiles = new Map<string, { name: string; bytes: Uint8Array }>()  // materiál → soubor textury
  let vCount = 0, triKept = 0
  // Vrchol = pozice + UV: na švech textury je stejný bod několikrát, jinak by se texturování
  // rozsypalo. Index je společný pro v i vt, takže se do faces píše `f i/i`.
  const vIndex = (sx: number, sy: number, sz: number, u: number, w: number): number => {
    const key = `${sx.toFixed(2)}_${sy.toFixed(2)}_${sz.toFixed(2)}_${u.toFixed(4)}_${w.toFixed(4)}`
    let id = dedup.get(key)
    if (id === undefined) {
      vChunks.push(`v ${sx.toFixed(3)} ${sy.toFixed(3)} ${sz.toFixed(3)}`)
      vtChunks.push(`vt ${u.toFixed(6)} ${w.toFixed(6)}`)
      id = ++vCount; dedup.set(key, id)
    }
    return id
  }
  let done = 0
  for (const [url, tile] of uniq) {
    throwIfAborted(ctx.signal)
    ctx.report(done / uniq.size, `zpracovávám dlaždice ${done + 1}/${uniq.size}`); done++
    let buf: ArrayBuffer | undefined
    try { buf = await tile._contentResource!.clone().fetchArrayBuffer() } catch { continue }
    if (!buf) continue
    let gltf: { scene: THREE.Object3D; parser?: GltfParser }
    try { gltf = await new Promise((res, rej) => loader.parse(buf, '', g => res(g as unknown as { scene: THREE.Object3D; parser?: GltfParser }), rej)) } catch { continue }
    const bin = glbBin(buf), gjson = (gltf.parser?.json ?? {}) as GltfJson
    Cesium.Matrix4.multiply(tile.computedTransform, YUP, world)
    gltf.scene.updateMatrixWorld(true)
    const meshes: THREE.Mesh[] = []
    gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry
      const pos = g.attributes.position as THREE.BufferAttribute | undefined
      if (!pos) continue
      const uv = g.attributes.uv as THREE.BufferAttribute | undefined
      const idx = g.index
      const nodeMat = m.matrixWorld
      const nTri = idx ? idx.count / 3 : pos.count / 3

      const faces: string[] = []
      const toS = (i: number): [number, number, number, number, number] => {
        vwT.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(nodeMat)
        ecef.x = vwT.x; ecef.y = vwT.y; ecef.z = vwT.z
        Cesium.Matrix4.multiplyByPoint(world, ecef, ecef)
        const carto = Cesium.Cartographic.fromCartesian(ecef)
        const lon = Cesium.Math.toDegrees(carto.longitude), lat = Cesium.Math.toDegrees(carto.latitude)
        const sj = sjtskOf(lon, lat) as number[]
        // glTF má počátek UV vlevo NAHOŘE, OBJ vlevo DOLE → V se překlápí
        return [sj[0], sj[1], carto.height - GEOID_CZ, uv ? uv.getX(i) : 0, uv ? 1 - uv.getY(i) : 0]
      }
      for (let t = 0; t < nTri; t++) {
        const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
        const A = toS(a), B = toS(b), C = toS(c)
        if (!inSel((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3)) continue
        const ia = vIndex(A[0], A[1], A[2], A[3], A[4]), ib = vIndex(B[0], B[1], B[2], B[3], B[4]), ic = vIndex(C[0], C[1], C[2], C[3], C[4])
        faces.push(`f ${ia}/${ia} ${ib}/${ib} ${ic}/${ic}`)
        triKept++
      }
      g.dispose()
      if (!faces.length) continue

      // Textura až teď — z dlaždic mimo výběr by se JPEGy jen vršily v paměti.
      // Bez UV nebo bez čitelného obrázku spadneme na jeden bílý materiál (geometrii nezahazujeme).
      let matName = 'google_bez_textury'
      const mat0 = Array.isArray(m.material) ? m.material[0] : m.material
      const map = (mat0 as THREE.MeshStandardMaterial | undefined)?.map ?? null
      const imgIdx = uv ? textureImageIndex(gltf.parser, gjson, map) : null
      if (imgIdx !== null) {
        const known = texByKey.get(`${url}#${imgIdx}`)
        if (known) matName = known
        else {
          const im = gltfImage(gjson, bin, imgIdx)
          if (im) {
            matName = `google_tex_${texFiles.size}`
            texFiles.set(matName, { name: `${matName}.${im.ext}`, bytes: im.bytes })
            texByKey.set(`${url}#${imgIdx}`, matName)
          }
        }
      }
      const bucket = faceByMat.get(matName)
      if (bucket) for (const f of faces) bucket.push(f)
      else faceByMat.set(matName, faces)
    }
    await new Promise(r => setTimeout(r, 0))
  }

  // materiály bez jediného trojúhelníku uvnitř výběru do zipu nepatří (ani jejich textury)
  const usedMats = [...faceByMat].filter(([, f]) => f.length)
  const usedTex = usedMats.map(([mt]) => texFiles.get(mt)).filter((t): t is { name: string; bytes: Uint8Array } => !!t)
  const texMB = usedTex.reduce((s, t) => s + t.bytes.length, 0) / 1048576
  console.log(`Google mesh: ${uniq.size} dlaždic → ${triKept} trojúhelníků, ${vCount} vrcholů, ${usedTex.length} textur (${texMB.toFixed(1)} MB)`)
  if (!triKept) throw new Error('V oblasti nejsou žádné Google trojúhelníky — přibliž kameru (načtou se detailnější dlaždice) a zkus znovu')

  // 4) streamovaný zip (velký mesh)
  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }
  const objF = new ZipDeflate('google_mesh.obj', { level: 1 }); zip.add(objF)
  const pushLines = (L: string[]) => { for (let i = 0; i < L.length; i += 10000) { objF.push(strToU8(L.slice(i, i + 10000).join('\n') + '\n'), false); check() } }
  objF.push(strToU8('mtllib google_mesh.mtl\no google\ng google\n'), false)
  pushLines(vChunks)
  pushLines(vtChunks)
  for (const [mt, faces] of usedMats) { objF.push(strToU8(`usemtl ${mt}\n`), false); pushLines(faces) }
  objF.push(new Uint8Array(0), true); check()

  // JPEGy jdou rovnou (už jsou komprimované, deflate by je jen zdržel)
  for (const t of usedTex) { const f = new ZipPassThrough(t.name); zip.add(f); f.push(t.bytes, true); check() }

  const addText = (name: string, text: string) => { const d = new ZipDeflate(name, { level: 6 }); zip.add(d); d.push(strToU8(text), true); check() }
  addText('google_mesh.mtl', usedMats.map(([mt]) => {
    const t = texFiles.get(mt)
    return [`newmtl ${mt}`, 'Ka 0.000 0.000 0.000', 'Kd 1.000 1.000 1.000', 'Ks 0.000 0.000 0.000', 'd 1.0', 'illum 1', ...(t ? [`map_Kd ${t.name}`] : []), ''].join('\n')
  }).join('\n'))
  if (usedTex.length) addText('vray_material.ms', buildMaxScriptFiles(usedTex.map(t => t.name)))
  addText('info.txt', [
    'Mesh z Google Photorealistic 3D Tiles — REFERENCE (geometrie + zapečené fototextury).',
    'Souřadnice: reálné S-JTSK (EPSG:5514, proj4), výšky Bpv → lícuje s exportem terénu i modely.',
    'Ořezáno na hranici vybraných parcel. Kvalita = fotogrammetrická „tavenina" (jen jako reference výšek a tvarů).',
    'POZOR: licence Google zakazuje odvozené modely — pouze pro interní referenci při modelování.',
    '',
    'Obsah zipu:',
    '  google_mesh.obj  — mesh (Y = sever, Z = výška), materiál na každou dlaždici',
    '  google_mesh.mtl  — materiály; Max si textury natáhne sám při importu OBJ',
    '  google_tex_*.jpg — textury dlaždic, syrové z Googlu (bez překódování)',
    usedTex.length ? '  vray_material.ms — po importu spusť (Scripting > Run Script) pro převod na VRayMtl' : '',
    '',
    `Trojúhelníků: ${triKept}, vrcholů: ${vCount}, textur: ${usedTex.length} (${texMB.toFixed(1)} MB)`,
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
  ].filter(Boolean).join('\n'))
  zip.end(); check()
  download(concatBytes(chunks), `google_mesh_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
  return `Vyveden Google mesh (${triKept} trojúhelníků, ${usedTex.length} textur)`
}
