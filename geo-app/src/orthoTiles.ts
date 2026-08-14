/**
 * Stažení ortofoto dlaždic ČÚZK pro lokální cache. Používá se s „Stáhnout do localu": pro dlaždici
 * (dané Cesium GEOGRAPHIC soustavy, EPSG:4326) stáhne obrázek pro její lon/lat obálku a uloží.
 * ZOBRAZENÍ jede přes WMS (správné zarovnání) — tohle jen plní cache, ať klíč sedí na WMS dlaždici.
 *
 * ČÚZK při paralelní zátěži vrací PRÁZDNÉ dlaždice → nízký souběh (semafor) + retry + validace.
 * Bez Cesia/DOMu (jen fetch), ať je to lehké.
 */
const ORTO_EXPORT = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer/export'
const MIN_BYTES = 1500 // menší/nesprávná odpověď = throttle/blank → retry

/** REST export URL pro lon/lat (EPSG:4326) obálku, výstup pxW×pxH (výchozí čtverec), JPEG. */
export function orthoExport4326Url(w: number, s: number, e: number, n: number, pxW: number, pxH: number = pxW): string {
  return `${ORTO_EXPORT}?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${pxW},${pxH}&format=jpg&f=image`
}

// ── semafor: max souběžných fetchů na ČÚZK (jinak vrací blank) ──
let active = 0
const queue: (() => void)[] = []
const MAX_CONC = 4
function acquire(): Promise<void> {
  if (active < MAX_CONC) { active++; return Promise.resolve() }
  return new Promise<void>(res => queue.push(() => res())).then(() => { active++ })
}
function release() { active--; const next = queue.shift(); if (next) next() }

/** Stáhne jednu dlaždici z URL (semafor + retry + validace). Vrací bajty, nebo null při selhání. */
export async function fetchOrthoUrl(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  await acquire()
  try {
    for (let a = 1; a <= 5; a++) {
      if (signal?.aborted) return null
      try {
        const r = await fetch(url, { signal })
        const ct = r.headers.get('content-type') || ''
        const buf = new Uint8Array(await r.arrayBuffer())
        if (r.ok && ct.includes('image/jpeg') && buf.length >= MIN_BYTES) return buf
      } catch { if (signal?.aborted) return null /* jinak retry */ }
      await new Promise(res => setTimeout(res, 250 * a)) // backoff (throttle ČÚZK)
    }
    return null
  } finally { release() }
}
