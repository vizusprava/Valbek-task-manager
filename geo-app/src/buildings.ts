/**
 * Budovy z ČÚZK INSPIRE (bu:Building) → čisté nízkopolygonové hmoty s rozpoznaným typem střechy.
 *
 * ČÚZK dává jen 2D půdorysy (v S-JTSK), výšku v datech NEMÁ. Výšku i tvar střechy proto bereme
 * z výškových modelů: DMR5G = terén (spodek zdí), DMP1G = povrch (střecha). Střechu ale
 * NEpřetahujeme jako surový LiDAR (to by bylo zašuměné a high-poly) — z DMP1G jen odhadneme
 * parametry (okap, hřeben, typ) a vygenerujeme čistou symetrickou střechu z pár rovin.
 *
 * Modul je bez Cesia/Reactu/DOMu (jen fetch + string parsing + math), aby šel testovat i v Node.
 */
import { fetchRetry } from './tiles'

/** Půdorys budovy v S-JTSK (EPSG:5514): vnější obrys + volitelné vnitřní dvory. */
export type Footprint = { outer: [number, number][]; holes: [number, number][][] }

const BU_WFS = 'https://services.cuzk.cz/wfs/inspire-bu-wfs.asp'

/**
 * Stáhne půdorysy budov v S-JTSK obdélníku z ČÚZK INSPIRE WFS.
 * BBOX i výstup jsou v EPSG:5514 ve stejném pořadí (x=east, y=north) jako proj4 — ověřeno
 * proti živým datům, takže se souřadnice nepřehazují.
 */
export async function fetchBuildings(minX: number, minY: number, maxX: number, maxY: number, signal?: AbortSignal): Promise<Footprint[]> {
  const bbox = `${minX},${minY},${maxX},${maxY},urn:ogc:def:crs:EPSG::5514`
  const url = `${BU_WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=bu:Building&SRSNAME=urn:ogc:def:crs:EPSG::5514&COUNT=8000&BBOX=${encodeURIComponent(bbox)}`
  const gml = await fetchRetry(url, { signal, parse: async res => {
    if (!res.ok) throw new Error(`Budovy WFS: HTTP ${res.status}`)
    const text = await res.text()
    // ověř, že je to opravdu GML kolekce (a ne HTML chybová stránka / prázdno)
    if (!/FeatureCollection/i.test(text)) throw new Error('Budovy WFS: nečekaná odpověď (není FeatureCollection)')
    return text
  } })
  return parseBuildingsGml(gml)
}

/** Rozparsuje GML 3.2 kolekci bu:Building na půdorysy. Bez XML knihovny — struktura ČÚZK je pevná. */
export function parseBuildingsGml(gml: string): Footprint[] {
  const out: Footprint[] = []
  // rozděl na jednotlivé budovy; prefix elementu je bu-ext2d:/bu-core2d: → povol i pomlčku
  const parts = gml.split(/<[\w-]+:Building[\s>]/).slice(1)
  for (const part of parts) {
    const ext = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/i.exec(part)
    if (!ext) continue
    const outer = parsePosList(ext[1])
    if (outer.length < 3) continue
    const holes: [number, number][][] = []
    const re = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) { const h = parsePosList(m[1]); if (h.length >= 3) holes.push(h) }
    out.push({ outer, holes })
  }
  return out
}

/** "x0 y0 x1 y1 …" → [[x0,y0],[x1,y1],…]; odstraní duplicitní uzavírací bod. */
function parsePosList(s: string): [number, number][] {
  const nums = s.trim().split(/\s+/).map(Number)
  const pts: [number, number][] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i], y = nums[i + 1]
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y])
  }
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts.pop()
  }
  return pts
}

// ── Geometrie budov ───────────────────────────────────────────────────────────────────
export type RoofType = 'flat' | 'gable' | 'hip'
export type BuildingMesh = { positions: number[]; indices: number[]; roof: RoofType }
export type Sampler = (x: number, y: number) => number | null // S-JTSK (x,y) → výška Bpv, nebo null

/** MTL materiál budov — matná hnědá, bez textury. */
export const BUILDING_MTL = ['newmtl budovy', 'Ka 0.05 0.03 0.02', 'Kd 0.42 0.28 0.18', 'Ks 0.000 0.000 0.000', 'd 1.0', 'illum 1', ''].join('\n')

const MIN_EAVE = 2.0     // minimální výška okapu (m); pod tím to nebereme jako stojící budovu
const MIN_RIDGE = 2.5    // minimální výška hřebene
const FLAT_THRESH = 1.2  // (hřeben − okap) < → plochá střecha

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.max(0, Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1))))]
}

/** Orientovaný min-area obdélník půdorysu → střed, úhel hlavní osy a půlrozměry (a ≥ b). */
function obb(poly: [number, number][]): { cx: number; cy: number; ang: number; a: number; b: number } {
  let best = { area: Infinity, ang: 0, mnu: 0, mxu: 0, mnv: 0, mxv: 0 }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0])
    const c = Math.cos(ang), s = Math.sin(ang)
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity
    for (const [x, y] of poly) {
      const u = x * c + y * s, v = -x * s + y * c
      if (u < mnu) mnu = u; if (u > mxu) mxu = u
      if (v < mnv) mnv = v; if (v > mxv) mxv = v
    }
    const area = (mxu - mnu) * (mxv - mnv)
    if (area < best.area) best = { area, ang, mnu, mxu, mnv, mxv }
  }
  const cu = (best.mnu + best.mxu) / 2, cv = (best.mnv + best.mxv) / 2
  const c = Math.cos(best.ang), s = Math.sin(best.ang)
  const cx = cu * c - cv * s, cy = cu * s + cv * c
  let a = (best.mxu - best.mnu) / 2, b = (best.mxv - best.mnv) / 2, ang = best.ang
  if (a < b) { const t = a; a = b; b = t; ang += Math.PI / 2 } // hlavní osa = delší strana (kudy jde hřeben)
  return { cx, cy, ang, a, b }
}

/**
 * Jedna budova → čistá nízkopolygonová hmota (zdi + rozpoznaná střecha).
 * Střecha se NEpřetahuje ze surového LiDARu; z DMP1G se jen odhadne okap/hřeben/typ a postaví
 * se z pár rovin na orientovaném obdélníku → symetrická (obě strany stejně) a low-poly.
 * `ground` = DMR5G (terén, spodek zdí), `surface` = DMP1G (povrch, tvar střechy). null = nestavět.
 */
export function buildBuildingMesh(fp: Footprint, ground: Sampler, surface: Sampler, forceRoof?: RoofType): BuildingMesh | null {
  const outer = fp.outer
  if (outer.length < 3) return null
  const { cx, cy, ang, a, b } = obb(outer)
  if (a < 1.5 || b < 1.0) return null // drobná stavba / šum
  const cos = Math.cos(ang), sin = Math.sin(ang)
  const toWorld = (uu: number, vv: number): [number, number] => [cx + uu * cos - vv * sin, cy + uu * sin + vv * cos]

  // datum terénu = medián země ve středu + rozích
  const gs: number[] = []
  for (const [uu, vv] of [[0, 0], [-a, -b], [a, -b], [a, b], [-a, b]] as [number, number][]) {
    const [wx, wy] = toWorld(uu, vv); const g = ground(wx, wy); if (g != null) gs.push(g)
  }
  if (!gs.length) return null
  const h0 = percentile(gs, 50)

  // výšky povrchu nad terénem uvnitř půdorysu (mřížka ~1,5 m v rámci OBB)
  const step = 1.5
  const rel: number[] = []
  for (let uu = -a + step * 0.5; uu < a; uu += step)
    for (let vv = -b + step * 0.5; vv < b; vv += step) {
      const [wx, wy] = toWorld(uu, vv)
      if (!pointInRing(wx, wy, outer)) continue
      if (fp.holes.some(h => pointInRing(wx, wy, h))) continue
      const s = surface(wx, wy)
      if (s == null) continue
      const r = s - h0
      if (r > 0.3 && r < 80) rel.push(r)
    }
  if (rel.length < 4) return null

  let hEave = Math.max(MIN_EAVE, percentile(rel, 15))
  let hRidge = Math.max(hEave, percentile(rel, 88))
  if (hRidge < MIN_RIDGE) return null // není to stojící budova

  let roof: RoofType
  if (forceRoof) roof = forceRoof
  else if (hRidge - hEave < FLAT_THRESH) roof = 'flat'
  else {
    // sedlová vs valbová: povrch na hřebeni u obou konců (uu ≈ ±(a−0,6), vv = 0)
    const endR: number[] = []
    for (const uu of [a - 0.6, -(a - 0.6)]) { const [wx, wy] = toWorld(uu, 0); const s = surface(wx, wy); if (s != null) endR.push(s - h0) }
    const endRidge = endR.length ? percentile(endR, 50) : hEave
    roof = (endRidge - hEave) / Math.max(0.1, hRidge - hEave) > 0.5 ? 'gable' : 'hip'
  }

  // ── geometrie ── (vinutí faců srovnáme podle „ven" normály, ať nezáleží na pořadí vrcholů)
  const pos: number[] = [], idx: number[] = []
  const pushV = (x: number, y: number, z: number) => { pos.push(x, y, z); return pos.length / 3 - 1 }
  const tri = (i: number, j: number, k: number, ref: [number, number, number]) => {
    const ax = pos[j * 3] - pos[i * 3], ay = pos[j * 3 + 1] - pos[i * 3 + 1], az = pos[j * 3 + 2] - pos[i * 3 + 2]
    const bx = pos[k * 3] - pos[i * 3], by = pos[k * 3 + 1] - pos[i * 3 + 1], bz = pos[k * 3 + 2] - pos[i * 3 + 2]
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    if (nx * ref[0] + ny * ref[1] + nz * ref[2] < 0) { const t = j; j = k; k = t }
    idx.push(i, j, k)
  }
  const quad = (i: number, j: number, k: number, l: number, ref: [number, number, number]) => { tri(i, j, k, ref); tri(i, k, l, ref) }

  const eaveZ = h0 + hEave, ridgeZ = h0 + hRidge
  const G: number[] = [], W: number[] = []
  const cornersL: [number, number][] = [[-a, -b], [a, -b], [a, b], [-a, b]]
  for (const [uu, vv] of cornersL) {
    const [wx, wy] = toWorld(uu, vv)
    G.push(pushV(wx, wy, ground(wx, wy) ?? h0)) // spodek zdi = terén (drapuje se na svah)
    W.push(pushV(wx, wy, eaveZ))                // okap
  }
  // zdi ven (vodorovná „ven" normála = od středu ke straně)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const [mx, my] = toWorld((cornersL[i][0] + cornersL[j][0]) / 2, (cornersL[i][1] + cornersL[j][1]) / 2)
    quad(G[i], G[j], W[j], W[i], [mx - cx, my - cy, 0])
  }

  if (roof === 'flat') {
    quad(W[0], W[1], W[2], W[3], [0, 0, 1]) // plochá stříška
  } else {
    const rl = roof === 'gable' ? a : Math.max(0.1, a - b) // valba = zkrácený hřeben
    const [rax, ray] = toWorld(-rl, 0), [rbx, rby] = toWorld(rl, 0)
    const RA = pushV(rax, ray, ridgeZ), RB = pushV(rbx, rby, ridgeZ)
    quad(W[0], W[1], RB, RA, [0, 0, 1]) // dlouhý spád k v=−b
    quad(W[3], RA, RB, W[2], [0, 0, 1]) // dlouhý spád k v=+b
    if (roof === 'gable') {
      const [ex, ey] = toWorld(-a, 0), [fx, fy] = toWorld(a, 0)
      tri(W[0], RA, W[3], [ex - cx, ey - cy, 0]) // svislý štít u=−a
      tri(W[1], W[2], RB, [fx - cx, fy - cy, 0]) // svislý štít u=+a
    } else {
      tri(W[0], RA, W[3], [0, 0, 1]) // valbový sklopený konec u=−a
      tri(W[1], W[2], RB, [0, 0, 1]) // valbový sklopený konec u=+a
    }
  }
  return { positions: pos, indices: idx, roof }
}

/**
 * Všechny budovy → jeden OBJ objekt „budovy" (bez UV, jedna barva). Indexy jsou globální 1-based
 * s offsetem vBase (index, který dostane první zde vypsaný `v`). Vrací i statistiku typů střech.
 */
export function buildBuildingsObj(fps: Footprint[], ground: Sampler, surface: Sampler, vBase: number):
  { verts: string[]; faces: string[]; vCount: number; count: number; stats: Record<RoofType, number> } {
  const verts: string[] = [], faces: string[] = []
  let vc = 0, count = 0
  const stats: Record<RoofType, number> = { flat: 0, gable: 0, hip: 0 }
  for (const fp of fps) {
    const m = buildBuildingMesh(fp, ground, surface)
    if (!m) continue
    const base = vBase + vc
    for (let i = 0; i < m.positions.length; i += 3)
      verts.push(`v ${m.positions[i].toFixed(3)} ${m.positions[i + 1].toFixed(3)} ${m.positions[i + 2].toFixed(3)}`)
    for (let i = 0; i < m.indices.length; i += 3)
      faces.push(`f ${base + m.indices[i]} ${base + m.indices[i + 1]} ${base + m.indices[i + 2]}`)
    vc += m.positions.length / 3
    count++; stats[m.roof]++
  }
  return { verts, faces, vCount: vc, count, stats }
}
