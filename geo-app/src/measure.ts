/**
 * Měření parcel — délky mezí a výměra.
 *
 * Počítá se v S-JTSK (EPSG:5514), ne ve WGS84: je metrický a je to zároveň projekce, ve které
 * katastr vede výměry → čísla lícují s údajem z KN i s exportem do DXF.
 */
import { sjtskOf, wgsOf } from './tiles'
import { pointInRing, ringCentroid } from './rings'

// ── Měření parcel (délky stran + výměra) ─────────────────────────────────────────
// Počítá se v S-JTSK (EPSG:5514), ne ve WGS84: je metrický a je to zároveň projekce,
// ve které katastr vede výměry → čísla lícují s údajem z KN i s exportem do DXF.

export const MEASURE_MAX_EDGES = 600     // víc kót se stejně slije dohromady a jen brzdí scénu
export const MEASURE_MIN_EDGE = 0.5      // kratší úseky jsou zbytky lomových bodů — bez kóty
const MEASURE_SPLIT_ANGLE = 10    // ° — pod tímhle lomem je to pořád jedna mez → jedna kóta (součet)

/** Bod uvnitř parcely poblíž těžiště. Těžiště vypadne ven u konkávních tvarů (L/U) a taky
 *  když leží v díře — pak vezmeme střed nejširšího úseku vodorovného řezu, který je opravdu
 *  uvnitř (za hranou vnějšího prstence a mimo všechny díry). */
function innerPoint(pts: number[][], holes: number[][][], cx: number, cy: number): [number, number] {
  const inside = (x: number, y: number) => pointInRing(x, y, pts) && !holes.some(h => pointInRing(x, y, h))
  if (inside(cx, cy)) return [cx, cy]
  const xs: number[] = []
  for (const r of [pts, ...holes]) {
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length]
      if ((y0 > cy) !== (y1 > cy)) xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0))
    }
  }
  xs.sort((a, b) => a - b)
  let best = 0, bx = cx
  // úseky testujeme jednotlivě (ne po párech) — s dírami se sudé/nepaté párování nedá předpokládat
  for (let i = 0; i + 1 < xs.length; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2
    if (xs[i + 1] - xs[i] > best && inside(mid, cy)) { best = xs[i + 1] - xs[i]; bx = mid }
  }
  return [bx, cy]
}

export type ParcelMeasure = { area: number; label: [number, number]; edges: Array<{ mid: [number, number]; len: number }> }

/** Odchylka dvou směrů ve stupních, 0–180. */
function angDiffDeg(a: number, b: number): number {
  return Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI
}

/**
 * Indexy stran seskupené do úseků, které jsou pořád jedna mez: dělí se jen tam, kde
 * se hranice láme o víc než MEASURE_SPLIT_ANGLE. Katastr totiž vkládá lomový bod do
 * každého dotyku sousední parcely, takže rovná mez přijde jako pět čísel za sebou.
 * Začíná se u nejostřejšího lomu — jinak by se mez rozpůlila jen proto, že tam
 * náhodou začíná prstenec z WFS.
 */
function edgeRuns(pts: [number, number][]): number[][] {
  const n = pts.length
  const dirs = pts.map((p, i) => { const q = pts[(i + 1) % n]; return Math.atan2(q[1] - p[1], q[0] - p[0]) })
  const turn = (i: number) => angDiffDeg(dirs[(i + n - 1) % n], dirs[i]) // lom ve vrcholu i
  let start = 0, worst = -1
  for (let i = 0; i < n; i++) if (turn(i) > worst) { worst = turn(i); start = i }
  const runs: number[][] = []
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (runs.length && turn(i) <= MEASURE_SPLIT_ANGLE) runs[runs.length - 1].push(i)
    else runs.push([i])
  }
  return runs
}

/** Prstence ve WGS84 → kóty mezí, výměra a místo pro popisek (zase ve WGS84 lon/lat).
 *  `holesLL` = vykrojené parcely uvnitř; jejich plocha se od výměry odečte, ale nekótují se
 *  (je to mez sousední parcely, ne téhle). */
export function measureRing(ringLL: number[][], holesLL: number[][][] = []): ParcelMeasure | null {
  // do S-JTSK + zahodit uzavírací bod (GeoJSON prstenec má poslední = první), ať nevzniká nulová strana
  const toSj = (r: number[][]): [number, number][] => {
    const p: [number, number][] = r.map(([lo, la]) => sjtskOf(lo, la))
    if (p.length > 1 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 0.01) p.pop()
    return p
  }
  const pts = toSj(ringLL)
  if (pts.length < 3) return null
  const holes = holesLL.map(toSj).filter(h => h.length >= 3)
  const n = pts.length
  const segLen = (i: number) => Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1])
  const shoelace = (p: [number, number][]) => {
    let s = 0
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1] }
    return Math.abs(s) / 2
  }

  let cross2 = 0, cx = 0, cy = 0
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n]
    const cr = x0 * y1 - x1 * y0
    cross2 += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr
  }

  const edges: Array<{ mid: [number, number]; len: number }> = []
  for (const run of edgeRuns(pts)) {
    const len = run.reduce((s, i) => s + segLen(i), 0)
    // popisek do poloviny DÉLKY úseku, ne mezi jeho krajní body — u mírně lomené meze by ujel
    let rest = len / 2, mid = pts[run[0]]
    for (const i of run) {
      const l = segLen(i)
      if (rest <= l) {
        const t = l > 0 ? rest / l : 0, a = pts[i], b = pts[(i + 1) % n]
        mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        break
      }
      rest -= l
    }
    edges.push({ mid: wgsOf(mid[0], mid[1]), len })
  }

  // těžiště polygonu (ne průměr vrcholů) → popisek sedí i u protáhlých parcel
  const [gx, gy] = Math.abs(cross2) > 1e-9 ? [cx / (3 * cross2), cy / (3 * cross2)] : ringCentroid(pts)
  const area = shoelace(pts) - holes.reduce((s, h) => s + shoelace(h), 0)
  return { area, label: wgsOf(...innerPoint(pts, holes, gx, gy)), edges }
}

/** „1 234 m²“, u velkých ploch i hektary (cs-CZ formát jako v katastru). */
export function fmtArea(m2: number): string {
  const m = `${m2.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} m²`
  return m2 >= 10000 ? `${m} (${(m2 / 10000).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} ha)` : m
}
