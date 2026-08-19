/**
 * Pomocníci pro export do souborů: stažení blobu, jméno podle kotvy, zápis DXF a OBJ budov.
 *
 * Pozor na jména: `dxf.ts` DXF ČTE (import výkresu), tenhle modul ho PÍŠE (export parcel a území).
 */
import { fetchBuildings, buildBuildingsObj } from './buildings'
import { fetchElevSamplerSJTSK } from './elevation'
import type { Anchor } from './types'

/**
 * Geo-kotva v názvu jako CELÁ ČÍSLA bez teček (lon/lat v mikrostupních, výška v cm) —
 * tečky některé programy (3ds Max) usekávají u prvního „.". Formát: geo_<lonE6>_<latE6>_<hCm>.
 */
export function parseAnchor(name: string): Anchor | null {
  const m = name.match(/geo_(-?\d+)_(-?\d+)_(-?\d+)/)
  return m ? { lon: +m[1] / 1e6, lat: +m[2] / 1e6, h: +m[3] / 100 } : null
}

export function download(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function anchorFilename(anchor: Anchor, ext: string): string {
  const lon = Math.round(anchor.lon * 1e6)
  const lat = Math.round(anchor.lat * 1e6)
  const h = Math.round(anchor.h * 100)
  return `geo_${lon}_${lat}_${h}.${ext}`
}

/**
 * Uzavřené 3D polyliny do DXF (R12) — importuje se do 3ds Max/CAD jako editovatelné splajny/tvary.
 * Souřadnice v lokálním ENU (X=východ, Y=sever, Z=nahoru), stejný rámec jako OBJ export terénu.
 */
export function buildDxf(polylines: [number, number, number][][], layer = 'PARCELY'): string {
  return buildDxfLayers([{ layer, polylines }])
}

/** Jako buildDxf, ale víc pojmenovaných hladin v jednom výkresu (např. parcely + obrys území). */
export function buildDxfLayers(groups: { layer: string; polylines: [number, number, number][][] }[]): string {
  const L: (string | number)[] = []
  const g = (code: number, val: string | number) => { L.push(code, val) }
  g(0, 'SECTION'); g(2, 'ENTITIES')
  for (const grp of groups) for (const pl of grp.polylines) {
    g(0, 'POLYLINE'); g(8, grp.layer); g(66, 1); g(70, 9) // 1=uzavřená + 8=3D polylinie
    for (const [x, y, z] of pl) {
      g(0, 'VERTEX'); g(8, grp.layer)
      g(10, x.toFixed(4)); g(20, y.toFixed(4)); g(30, z.toFixed(4)); g(70, 32) // 32=vrchol 3D polylinie
    }
    g(0, 'SEQEND')
  }
  g(0, 'ENDSEC'); g(0, 'EOF')
  return L.join('\n')
}

/**
 * Budovy ČÚZK pro S-JTSK obdélník → OBJ objekt „budovy" (výška i tvar střechy z DMR5G/DMP1G).
 * Vrací kus OBJ textu k připojení, počet přidaných vrcholů a řádek do info.txt.
 */
export async function buildingsObjChunk(minX: number, minY: number, maxX: number, maxY: number, vBase: number, signal: AbortSignal): Promise<{ obj: string; vCount: number; line: string }> {
  const span = Math.max(maxX - minX, maxY - minY)
  const long = Math.min(2048, Math.max(64, Math.ceil(span / 2))) // ~2 m/px, strop 2048
  const sw = Math.max(2, Math.round(long * (maxX - minX) / span))
  const sh = Math.max(2, Math.round(long * (maxY - minY) / span))
  const [ground, surface, fps] = await Promise.all([
    fetchElevSamplerSJTSK('dmr5g', minX, minY, maxX, maxY, sw, sh, signal), // terén = spodek zdí
    fetchElevSamplerSJTSK('dmp1g', minX, minY, maxX, maxY, sw, sh, signal), // povrch = tvar střechy
    fetchBuildings(minX, minY, maxX, maxY, signal),
  ])
  if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
  if (!fps.length) return { obj: '', vCount: 0, line: 'Budovy: v oblasti žádné' }
  const bo = buildBuildingsObj(fps, ground, surface, vBase)
  if (!bo.count) return { obj: '', vCount: 0, line: 'Budovy: nevznikly (chybí DMP1G data?)' }
  const obj = 'o budovy\ng budovy\nusemtl budovy\n' + bo.verts.join('\n') + '\n' + bo.faces.join('\n') + '\n'
  return { obj, vCount: bo.vCount, line: `Budovy: ${bo.count} (plochých ${bo.stats.flat}, sedlových ${bo.stats.gable}, valbových ${bo.stats.hip})` }
}
