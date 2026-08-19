/**
 * Export vybraných dlaždic jako zip: teren.obj + teren.mtl + JPEG na dlaždici.
 *
 * Každá dlaždice = vlastní objekt s vlastním materiálem, souřadnice v REÁLNÉ rovině S-JTSK bez
 * posunu, ať to v Maxu lícuje s ostatními daty. 3ds Max importuje OBJ nativně i s texturami.
 *
 * Zip se skládá STREAMOVANĚ, po dlaždicích. Celý OBJ jako jeden řetězec nejde: u ~50 dlaždic
 * přeteče strop V8 na délku stringu (~512 MB) a join spadne na „Invalid string length". Takhle
 * se v paměti nikdy nedrží víc než jedna dlaždice a zkomprimovaný výstup.
 */
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import {
  type Tile, type Offset, type TileSize, type MeshStep, type TexSize,
  tileName, tilesBounds, pool, fetchTileHeights, fetchTileOrtho, buildTileObj, buildMtl, buildMaxScript,
  medianHeight, stepOf, concatBytes,
} from '../tiles'
import { BUILDING_MTL } from '../buildings'
import { isAbortError } from '../config'
import { download, buildingsObjChunk } from '../exportUtils'
import { fetchKatastrDxf } from './katastrDxf'
import { throwIfAborted, type ExportCtx } from './ctx'

export type TilesObjOpts = {
  tileSize: TileSize; meshStep: MeshStep; texSize: TexSize
  /** přibalit budovy ČÚZK jako samostatný objekt „budovy" */
  buildings: boolean
  /** přibalit hranice parcel jako katastr.dxf v témže S-JTSK rámci */
  katastr: boolean
}

export async function exportTilesObj(tiles: Tile[], o: TilesObjOpts, ctx: ExportCtx): Promise<string> {
  ctx.report(0, `0/${tiles.length}`)
  let done = 0
  const fetched = await pool(tiles, 3, async tile => {
    const [grid, jpg] = await Promise.all([fetchTileHeights(tile, o.meshStep, ctx.signal), fetchTileOrtho(tile, o.texSize, ctx.signal)])
    done++
    ctx.report(done / tiles.length, `${done}/${tiles.length}`)
    return { tile, grid, jpg }
  })
  ctx.report(-1, 'skládám…')
  await new Promise(r => setTimeout(r, 30)) // ať se stihne překreslit UI před blokující prací

  const fallbackH = medianHeight(fetched.map(f => f.grid))
  const { minX, minY, maxX, maxY } = tilesBounds(tiles)
  // Žádný posun: vrcholy jdou ven v reálných S-JTSK souřadnicích, ať sedí na ostatní data v Maxu.
  const off: Offset = { x: 0, y: 0, z: 0 }

  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }

  const objF = new ZipDeflate('teren.obj', { level: 1 })
  zip.add(objF)
  objF.push(strToU8('mtllib teren.mtl\n'), false)
  let vBase = 1
  let built = 0
  for (const f of fetched) {
    throwIfAborted(ctx.signal)
    objF.push(strToU8(buildTileObj(f.tile, f.grid, off, fallbackH, vBase) + '\n'), false)
    vBase += f.grid.n * f.grid.n
    check()
    if (++built % 5 === 0 || built === fetched.length) {
      ctx.report(built / fetched.length, `skládám ${built}/${fetched.length}`)
      await new Promise(r => setTimeout(r, 0)) // pustit UI k slovu
    }
  }
  // volitelně: budovy ČÚZK (výška i tvar střechy z DMR5G/DMP1G) jako samostatný objekt „budovy"
  let buildingsLine = 'Budovy: ne'
  let hasBuildings = false
  if (o.buildings) {
    ctx.report(-1, 'budovy…')
    try {
      const bch = await buildingsObjChunk(minX, minY, maxX, maxY, vBase, ctx.signal)
      if (bch.obj) { objF.push(strToU8(bch.obj), false); check(); vBase += bch.vCount; hasBuildings = true }
      buildingsLine = bch.line
    } catch (e) {
      if (isAbortError(e)) throw e
      console.error('Budovy do exportu selhaly:', e); buildingsLine = 'Budovy: stažení selhalo (viz konzole)'
    }
  }
  objF.push(new Uint8Array(0), true)
  check()

  for (const f of fetched) {
    const jf = new ZipPassThrough(`${tileName(f.tile)}.jpg`) // JPEG už komprimovaný je
    zip.add(jf)
    jf.push(f.jpg, true)
    check()
  }

  const addText = (name: string, text: string) => {
    const d = new ZipDeflate(name, { level: 6 })
    zip.add(d)
    d.push(strToU8(text), true)
    check()
  }
  addText('teren.mtl', buildMtl(tiles) + (hasBuildings ? '\n' + BUILDING_MTL : ''))
  addText('vray_material.ms', buildMaxScript(tiles))

  // volitelně: hranice parcel (katastr) jako DXF křivky v témže S-JTSK rámci
  let katastrLine = 'Katastr: ne'
  if (o.katastr) {
    ctx.report(-1, 'katastr…')
    try {
      const k = await fetchKatastrDxf(minX, minY, maxX, maxY)
      throwIfAborted(ctx.signal)
      if (k) { addText('katastr.dxf', k.dxf); katastrLine = `Katastr: katastr.dxf (${k.count} parcel, hranice jako 3D křivky)` }
      else katastrLine = 'Katastr: v oblasti nenalezeny žádné parcely'
    } catch (e) {
      if (isAbortError(e)) throw e
      console.error('Katastr do exportu selhal:', e); katastrLine = 'Katastr: stažení selhalo (viz konzole)'
    }
  }

  addText('info.txt', [
    'Terén DMR 5G + ortofoto (ČÚZK)',
    '',
    'Souřadnice: REÁLNÉ S-JTSK / Křovák East North (EPSG:5514), výšky Bpv.',
    'Žádný posun — vrcholy jsou na skutečných souřadnicích, tak jak leží.',
    '',
    'Import do 3ds Max:',
    '  1) File > Import > teren.obj (textury natáhne teren.mtl)',
    '  2) Chceš-li V-Ray: označ dlaždice (nebo neoznač nic — najde si je sám)',
    '     a spusť Scripting > Run Script > vray_material.ms',
    '     → označeným objektům vymění materiál za VRayMtl s ortofotem v diffuse.',
    '     (VRayMtl nejde uložit do .mtl — Wavefront formát renderery nezná.)',
    '  Rozbal celý zip do JEDNÉ složky, MTL i skript hledají JPEGy vedle sebe.',
    '',
    `Rozsah: X ${minX} … ${maxX}, Y ${minY} … ${maxY}`,
    '',
    `Dlaždic: ${tiles.length} × ${o.tileSize} m`,
    `Mřížka terénu: ${stepOf(tiles[0], fetched[0].grid.n).toFixed(3)} m (zdrojový DMR 5G má body po ~2,8 m)`,
    `Textura: ${o.texSize} px na dlaždici = ${(o.tileSize / o.texSize * 100).toFixed(1)} cm/px (ortofoto ČÚZK má nativně 20 cm/px)`,
    katastrLine,
    buildingsLine,
    'Budovy (je-li): objekt „budovy" = půdorysy ČÚZK, výška z DMP1G−DMR5G, střecha',
    'rozpoznaná (plochá/sedlová/valbová) jako čistá low-poly hmota, hnědý materiál bez textury.',
    'Y je mřížkový sever Křováku, ne pravý sever (meridiánová konvergence ~7°).',
    '',
    'katastr.dxf (je-li): hranice parcel jako uzavřené 3D křivky (DXF R12), stejný S-JTSK',
    'rámec i výšky jako terén → v Maxu lícuje. Import: File > Import > katastr.dxf.',
    '',
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
  ].join('\n'))

  zip.end()
  check()
  download(concatBytes(chunks), `teren_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
  return `Vyvezeno ${tiles.length}× dlaždice ${o.tileSize} m s ortofotem`
}
