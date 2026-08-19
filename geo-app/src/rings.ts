/**
 * 2D geometrie nad prstenci: zjednodušení, konkávní obal, union a test bodu v polygonu.
 *
 * Používá se na dvě věci, které spolu na první pohled nesouvisí, ale počítají totéž: půdorys
 * importovaného modelu (kvůli ořezu mapy pod ním) a práci s obrysy parcel. Vše je čistá
 * matematika nad `[x, y]` páry — žádné Cesium, žádný DOM.
 */
import concaveman from 'concaveman'
import polygonClipping from 'polygon-clipping'

// ── Půdorys modelu (konkávní obal) pro skrytí mapy pod/nad modelem ────────────────────
const FOOT_GRID_M = 0.15       // sjednocení bodů do mřížky (hustá síť má statisíce vrcholů → výkon)
const FOOT_CONCAVITY = 2       // concaveman: menší = detailnější obrys
const FOOT_MIN_INLET_M = 0.5   // zálivy kratší než tohle se vyhladí
const FOOT_SIMPLIFY_M = 0.2    // tolerance zjednodušení obrysu (Douglas–Peucker), v metrech
const FOOT_MAX_PTS = 250       // strop bodů obrysu — víc Cesium clip polygon spolehlivě neořízne
export const FOOT_MAX_TRIS_UNION = 40000 // nad tolik trojúhelníků je 2D union pomalý → fallback na konkávní obal
// objekty v modelu, které slouží JEN jako maska ořezu (podle názvu). Když nějaké jsou, obrys se
// počítá z nich (každý zvlášť); jinak z celého modelu.
export const MASK_NAME_RE = /maska|mask|clip|ořez|orez|výřez|vyrez|object006|object007/i

/** Douglas–Peucker (iterativně, bez rekurze) na otevřenou lomenou čáru; krajní body zachová. */
export function simplifyRDP(pts: [number, number][], eps: number): [number, number][] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1; keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const seg = stack.pop()!, s = seg[0], e = seg[1]
    const ax = pts[s][0], ay = pts[s][1], bx = pts[e][0], by = pts[e][1]
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let maxD = -1, idx = -1
    for (let i = s + 1; i < e; i++) {
      const px = pts[i][0], py = pts[i][1]
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const cx = ax + t * dx, cy = ay + t * dy
      const d = Math.hypot(px - cx, py - cy)
      if (d > maxD) { maxD = d; idx = i }
    }
    if (idx > 0 && maxD > eps) { keep[idx] = 1; stack.push([s, idx], [idx, e]) }
  }
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** Uzavře, zjednoduší (Douglas–Peucker) a osekne prstenec na strop bodů; null když <3 body. */
export function simplifyRingCapped(ring: [number, number][]): [number, number][] | null {
  if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (a[0] === b[0] && a[1] === b[1]) ring = ring.slice(0, -1) }
  if (ring.length < 3) return null
  // Cesium clip polygon zvládne jen omezený počet bodů → zvyšuj toleranci, dokud nejsme pod stropem
  let eps = FOOT_SIMPLIFY_M
  let simp = simplifyRDP(ring, eps)
  while (simp.length > FOOT_MAX_PTS && eps < 100) { eps *= 1.7; simp = simplifyRDP(ring, eps) }
  return simp.length >= 3 ? simp : null
}

/** Konkávní obal 2D bodů → zjednodušený prstenec [[x,y],…] bez děr; null když málo bodů. */
export function concaveFootprint(pts: [number, number][]): [number, number][] | null {
  if (pts.length < 3) return null
  // dedup do mřížky kvůli výkonu (interiér nás nezajímá, obrys drží krajní body)
  const grid = new Map<string, [number, number]>()
  for (const [x, y] of pts) { const k = `${Math.round(x / FOOT_GRID_M)}_${Math.round(y / FOOT_GRID_M)}`; if (!grid.has(k)) grid.set(k, [x, y]) }
  const uniq = [...grid.values()]
  if (uniq.length < 3) return null
  let raw: number[][]
  try { raw = concaveman(uniq, FOOT_CONCAVITY, FOOT_MIN_INLET_M) } catch (e) { console.error('Konkávní obal selhal:', e); return null }
  return simplifyRingCapped(raw.map(([x, y]) => [x, y] as [number, number]))
}

/** Přesný obrys plochy = 2D union trojúhelníků (polygon-clipping). Vrací vnější prstence (díry zahodí,
 * Cesium clip je neumí), takže vhloubení/mezery mezi rameny zůstanou nevyříznuté (žádné černé díry). */
export function unionOutlines(tris: [number, number][][]): [number, number][][] {
  if (!tris.length) return []
  const polys = tris.map(t => [[t[0], t[1], t[2], t[0]]] as [number, number][][])
  let merged: [number, number][][][]
  try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as unknown as [number, number][][][] }
  catch (e) { console.error('Union masky selhal:', e); return [] }
  const rings: [number, number][][] = []
  for (const poly of merged) { const outer = poly[0]; if (outer && outer.length >= 4) rings.push(outer.map(([x, y]) => [x, y] as [number, number])) }
  return rings
}

/** Test bod-v-polygonu (ray casting); ring = [[lon,lat], …]. */
export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function ringCentroid(ring: number[][]): [number, number] {
  let sx = 0, sy = 0
  for (const [x, y] of ring) { sx += x; sy += y }
  return [sx / ring.length, sy / ring.length]
}
