/**
 * Katastr do DXF: parcely v S-JTSK obálce → 3D křivky drapované na terén DMR.
 *
 * Čistá funkce nad obálkou — žádný stav komponenty, žádné Cesium. Volající si jen řekne
 * o obdélník a dostane hotové křivky (nebo rovnou text DXF).
 *
 * Výstup sedí na terén i na exportované OBJ dlaždice bez přepočtu: WFS vrací parcely rovnou
 * v EPSG:5514 (stejná soustava jako vrcholy dlaždic) a DMR výšky jsou Bpv (stejné jako Z terénu).
 */
import { wgsOf } from '../tiles'
import { fetchParcelsInBbox } from '../katastr'
import { fetchElevSampler } from '../elevation'
import { pointInRing, ringCentroid } from '../rings'
import { buildDxf } from '../exportUtils'

/**
 * Jádro katastru: parcely v S-JTSK obálce → 3D křivky (raw S-JTSK, výšky z DMR). Volitelný
 * `filter` (S-JTSK polygony území) nechá jen parcely, jejichž těžiště leží uvnitř. Vrací i
 * vzorkovač výšek `sampleZ`, aby na týž terén šel drapovat i obrys území ve stejném rámci.
 */
export async function fetchKatastrPolylines(minX: number, minY: number, maxX: number, maxY: number, filter?: [number, number][][]):
  Promise<{ polylines: [number, number, number][][]; count: number; sampleZ: (x: number, y: number) => number } | null> {
  // S-JTSK obálka → lon/lat bbox pro WFS
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [x, y] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as [number, number][]) {
    const [lo, la] = wgsOf(x, y)
    minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
  }
  const parcels = await fetchParcelsInBbox(minLon, minLat, maxLon, maxLat)
  if (!parcels.length) return null

  const span = Math.max(maxX - minX, maxY - minY)
  const size = Math.min(2048, Math.max(512, Math.ceil(span / 5)))
  const sampler = await fetchElevSampler('dmr5g', minLon, minLat, maxLon, maxLat, size)
  // náhradní výška pro místa bez DMR dat (kraje) — vzorek ze středu
  const [cLon, cLat] = wgsOf((minX + maxX) / 2, (minY + maxY) / 2)
  const fallbackH = sampler(cLon, cLat) ?? 0
  const sampleZ = (x: number, y: number): number => { const [lo, la] = wgsOf(x, y); return sampler(lo, la) ?? fallbackH }

  const polylines: [number, number, number][][] = []
  for (const p of parcels) {
    const ring = p.ring.slice()
    // DXF uzavře smyčku sám (flag), tak zahoď duplicitní koncový bod
    if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) ring.pop() }
    if (ring.length < 3) continue
    // filtr na tvar území (těžiště uvnitř některého prstence) — pro vyhledané k.ú./obec,
    // ať v DXF nejsou i sousední parcely z rohů obdélníkové obálky
    if (filter) { const [cx, cy] = ringCentroid(ring); if (!filter.some(fr => pointInRing(cx, cy, fr))) continue }
    polylines.push(ring.map(([x, y]) => [x, y, sampleZ(x, y)] as [number, number, number]))
  }
  if (!polylines.length) return null
  return { polylines, count: polylines.length, sampleZ }
}

export async function fetchKatastrDxf(minX: number, minY: number, maxX: number, maxY: number): Promise<{ dxf: string; count: number } | null> {
  const r = await fetchKatastrPolylines(minX, minY, maxX, maxY)
  return r ? { dxf: buildDxf(r.polylines), count: r.count } : null
}

