/**
 * Výřez terénu: DMR 5G + zapečené ortofoto ořezané na zadané polygony (lon/lat).
 *
 * Sdílené pro parcely i správní území — volající si jen připraví obrysy. Výstup je zip
 * (vyrez.obj + mtl + jpg + V-Ray skript + info) v reálném S-JTSK (EPSG:5514), výšky Bpv,
 * takže lícuje s exportem dlaždic i s modely.
 *
 * Je to STEJNÝ export jako dlaždice, jen ořezaný na hranici výběru místo na celé čtverce. UV se
 * berou z polohy v bboxu výřezu, takže jedno ortofoto přes celý výběr sedí na terén 1:1.
 */

import cdt2d from 'cdt2d'
import polygonClipping from 'polygon-clipping'
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { sjtskOf, concatBytes, buildMaxScriptFiles, type MeshStep } from '../tiles'
import { fetchElevSamplerSJTSK } from '../elevation'
import { pointInRing } from '../rings'
import { download } from '../exportUtils'
import { fetchOrthoTexture } from './maps'
import { throwIfAborted, type ExportCtx } from './ctx'

export async function exportCutout(polys: [number, number][][][], meshStep: MeshStep, ctx: ExportCtx): Promise<string> {
  // 1) sloučit vybrané polygony do jednoho tvaru, ať se sousední parcely nešvují uprostřed
  let merged: [number, number][][][]
  try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] }
  catch (e) { console.error('Union polygonů selhal, padám na jednotlivé:', e); merged = polys }

  // 2) převod na S-JTSK + odstranění uzavíracího bodu + bbox celého výběru
  const cleanRing = (r: number[][]) => {
    const c = r.slice()
    if (c.length > 1) { const a = c[0], b = c[c.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) c.pop() }
    return c
  }
  const patches: { outer: number[][]; holes: number[][][] }[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of merged) {
    const outer = cleanRing(poly[0].map(([lo, la]) => sjtskOf(lo, la) as number[]))
    if (outer.length < 3) continue
    const holes = poly.slice(1).map(h => cleanRing(h.map(([lo, la]) => sjtskOf(lo, la) as number[]))).filter(h => h.length >= 3)
    for (const [x, y] of outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    patches.push({ outer, holes })
  }
  if (!patches.length) throw new Error('Výběr nemá platnou plochu')
  const spanX = maxX - minX, spanY = maxY - minY
  if (!(spanX > 0) || !(spanY > 0)) throw new Error('Výběr má nulovou plochu')
  const longSpan = Math.max(spanX, spanY)

  // 3) výšky DMR přes bbox (S-JTSK) — ~2 m/px, strop 2048 na delší stranu
  ctx.report(-1, 'stahuji výšky (DMR)…')
  const demLong = Math.min(2048, Math.max(64, Math.ceil(longSpan / 2)))
  const demW = Math.max(2, Math.round(demLong * spanX / longSpan))
  const demH = Math.max(2, Math.round(demLong * spanY / longSpan))
  const sampler = await fetchElevSamplerSJTSK('dmr5g', minX, minY, maxX, maxY, demW, demH, ctx.signal)

  // 4) ortofoto jako textura — míří na nativních 20 cm/px, strop 8192 px na delší stranu;
  //    nad 4096 px se skládá z dlaždic (ČÚZK dá max 4096 px na jeden požadavek)
  ctx.report(-1, 'stahuji ortofoto…')
  const texLong = Math.min(8192, Math.max(1024, Math.ceil(longSpan / 0.2)))
  const texW = Math.max(1, Math.round(texLong * spanX / longSpan))
  const texH = Math.max(1, Math.round(texLong * spanY / longSpan))
  const jpg = await fetchOrthoTexture(minX, minY, maxX, maxY, texLong, ctx.signal, m => ctx.report(-1, m))

  // 5) triangulace každého výseku v S-JTSK, ořez hranicí, UV z polohy v bboxu
  ctx.report(-1, 'skládám…')
  const spacing = Math.max(meshStep, longSpan / 300) // hustota jako dlaždice, ale strop na velkou plochu

  // OBJ text jednoho výseku (v/vt/f) s globálním offsetem indexů vBase; null = žádná plocha
  const buildPatch = (sp: { outer: number[][]; holes: number[][][] }, vBase: number): { text: string; nv: number; nf: number } | null => {
    // body + constrained hrany: obrys i díry jako zhuštěné uzavřené smyčky
    const pts: number[][] = []
    const edges: number[][] = []
    const addLoop = (r: number[][]) => {
      const start = pts.length
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length]
        const nseg = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing))
        for (let k = 0; k < nseg; k++) { const t = k / nseg; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
      }
      const end = pts.length
      for (let i = start; i < end; i++) edges.push([i, i + 1 < end ? i + 1 : start])
    }
    addLoop(sp.outer)
    for (const h of sp.holes) addLoop(h)

    // vnitřní body na mřížce (bbox výseku): uvnitř obrysu a mimo díry
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of sp.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    for (let y = y0 + spacing * 0.5; y < y1; y += spacing)
      for (let x = x0 + spacing * 0.5; x < x1; x += spacing)
        if (pointInRing(x, y, sp.outer) && !sp.holes.some(h => pointInRing(x, y, h))) pts.push([x, y])

    // výšky Bpv (bez geoidu) + medián jako náhrada za díry v DMR
    const heights = pts.map(([x, y]) => { const e = sampler(x, y); return e != null ? e : NaN })
    const valid = heights.filter(h => Number.isFinite(h)) as number[]
    if (!valid.length) return null
    const fallback = valid.slice().sort((a, b) => a - b)[Math.floor(valid.length / 2)]

    const tris = cdt2d(pts, edges, { exterior: false })
    if (!tris.length) return null

    const L: string[] = []
    for (let i = 0; i < pts.length; i++) {
      const z = Number.isFinite(heights[i]) ? (heights[i] as number) : fallback
      L.push(`v ${pts[i][0].toFixed(3)} ${pts[i][1].toFixed(3)} ${z.toFixed(3)}`)
    }
    // vt: poloha v bboxu → sedí na jpg (sever = maxY = horní okraj obrázku = v 1)
    for (let i = 0; i < pts.length; i++)
      L.push(`vt ${((pts[i][0] - minX) / spanX).toFixed(6)} ${((pts[i][1] - minY) / spanY).toFixed(6)}`)
    // f: jen trojúhelníky se středem uvnitř obrysu a mimo díry; vinutí CCW → normála +Z
    let nf = 0
    for (const t of tris) {
      const cx = (pts[t[0]][0] + pts[t[1]][0] + pts[t[2]][0]) / 3
      const cy = (pts[t[0]][1] + pts[t[1]][1] + pts[t[2]][1]) / 3
      if (!pointInRing(cx, cy, sp.outer)) continue
      if (sp.holes.some(h => pointInRing(cx, cy, h))) continue
      let i0 = t[0], i1 = t[1], i2 = t[2]
      const area = (pts[i1][0] - pts[i0][0]) * (pts[i2][1] - pts[i0][1]) - (pts[i2][0] - pts[i0][0]) * (pts[i1][1] - pts[i0][1])
      if (area < 0) { const tmp = i1; i1 = i2; i2 = tmp } // otoč na CCW (lícem nahoru, +Z)
      const a = vBase + i0, b = vBase + i1, c = vBase + i2
      L.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`)
      nf++
    }
    if (!nf) return null
    return { text: L.join('\n'), nv: pts.length, nf }
  }

  // 6) streamovaný zip (jako u dlaždic — velký výběr by jinak přetekl strop délky stringu)
  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }

  const objF = new ZipDeflate('vyrez.obj', { level: 1 })
  zip.add(objF)
  objF.push(strToU8('mtllib vyrez.mtl\no vyrez\ng vyrez\nusemtl vyrez\n'), false)
  let vBase = 1
  let built = 0
  let totalTris = 0
  for (const sp of patches) {
    throwIfAborted(ctx.signal)
    const part = buildPatch(sp, vBase)
    if (part) {
      objF.push(strToU8(part.text + '\n'), false)
      vBase += part.nv
      totalTris += part.nf
      check()
    }
    ctx.report(++built / patches.length, `skládám ${built}/${patches.length}`)
    await new Promise(r => setTimeout(r, 0))
  }
  objF.push(new Uint8Array(0), true)
  check()
  if (vBase === 1) throw new Error('Z výběru nevznikla žádná plocha (chybí DMR data?)')

  const jf = new ZipPassThrough('vyrez.jpg')
  zip.add(jf); jf.push(jpg, true); check()

  const addText = (name: string, text: string) => { const d = new ZipDeflate(name, { level: 6 }); zip.add(d); d.push(strToU8(text), true); check() }
  addText('vyrez.mtl', ['newmtl vyrez', 'Ka 0.000 0.000 0.000', 'Kd 1.000 1.000 1.000', 'Ks 0.000 0.000 0.000', 'd 1.0', 'illum 1', 'map_Kd vyrez.jpg', ''].join('\n'))
  addText('vray_material.ms', buildMaxScriptFiles(['vyrez.jpg']))
  addText('info.txt', [
    'Teren DMR 5G + ortofoto (CUZK) — VYREZ podle hranic katastru',
    '',
    'Souřadnice: REÁLNÉ S-JTSK / Křovák East North (EPSG:5514), výšky Bpv.',
    'Žádný posun — vrcholy jsou na skutečných souřadnicích (lícuje s exportem dlaždic).',
    'Terén je ořezaný přesně na hranici vybraných parcel/oblasti (ne celé čtverce).',
    '',
    'Import do 3ds Max:',
    '  1) File > Import > vyrez.obj (texturu natáhne vyrez.mtl)',
    '  2) Chceš-li V-Ray: spusť Scripting > Run Script > vray_material.ms',
    '  Rozbal celý zip do JEDNÉ složky, MTL i skript hledají vyrez.jpg vedle sebe.',
    '',
    `Rozsah bbox: X ${Math.round(minX)} … ${Math.round(maxX)}, Y ${Math.round(minY)} … ${Math.round(maxY)}`,
    `Plocha bboxu: ${spanX.toFixed(0)} × ${spanY.toFixed(0)} m`,
    `Mřížka terénu: ~${spacing.toFixed(2)} m (zdrojový DMR 5G má body po ~2,8 m)`,
    `Textura: ${texW} × ${texH} px = ${(spanX / texW * 100).toFixed(1)} cm/px (ortofoto ČÚZK má nativně 20 cm/px)`,
    `Trojúhelníků: ~${totalTris}`,
    'Y je mřížkový sever Křováku, ne pravý sever (meridiánová konvergence ~7°).',
    '',
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
  ].join('\n'))

  zip.end()
  check()
  download(concatBytes(chunks), `vyrez_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
  return `Vyvezen výřez (${patches.length} ${patches.length === 1 ? 'plocha' : 'ploch'}) s ortofotem`
}
