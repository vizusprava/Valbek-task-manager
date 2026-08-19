/**
 * Výškové vzorkovače z ČÚZK ImageServeru (DMR5G = terén, DMP1G = povrch).
 *
 * Stáhne se jeden float32 TIFF pro obdélník a vrátí se funkce „souřadnice → výška". Bez Cesia
 * a bez DOMu (jen fetch + geotiff), takže to jde volat i z exportních modulů a testovat v Node.
 */
import { fromArrayBuffer } from 'geotiff'
import { fetchRetry } from './tiles'

/** Výškový rastr z ČÚZK ImageServeru (dmr5g/dmp1g) → vzorkovací funkce lon/lat → výška (Bpv). */
export async function fetchElevSampler(service: 'dmr5g' | 'dmp1g', minLon: number, minLat: number, maxLon: number, maxLat: number, size: number): Promise<(lon: number, lat: number) => number | null> {
  const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/${service}/ImageServer/exportImage?bbox=${minLon},${minLat},${maxLon},${maxLat}&bboxSR=4326&imageSR=4326&size=${size},${size}&format=tiff&pixelType=F32&f=image`
  return fetchRetry(url, { parse: async res => {
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`)
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
    const w = img.getWidth(), h = img.getHeight()
    if (!w || !h) throw new Error(`${service}: prázdný rastr`)
    const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
    return (lon, lat) => {
      const x = Math.max(0, Math.min(w - 1, Math.round(((lon - minLon) / (maxLon - minLon)) * w - 0.5)))
      const y = Math.max(0, Math.min(h - 1, Math.round(((maxLat - lat) / (maxLat - minLat)) * h - 0.5)))
      const e = r[y * w + x] as number
      return Number.isFinite(e) && e > -500 && e < 3000 ? e : null
    }
  } })
}

/**
 * Totéž, ale rovnou v S-JTSK (EPSG:5514) → vzorkovač (X,Y)→výška Bpv. Používá výřez katastru,
 * který trianguluje v S-JTSK rovině (stejně jako dlaždice), takže výšky vzorkuje bez reprojekce.
 * Výšky jsou syrové Bpv (BEZ geoidu) — shodně s dlaždicemi (fetchTileHeights), ať export lícuje.
 */
export async function fetchElevSamplerSJTSK(service: 'dmr5g' | 'dmp1g', minX: number, minY: number, maxX: number, maxY: number, sw: number, sh: number, signal?: AbortSignal): Promise<(x: number, y: number) => number | null> {
  const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/${service}/ImageServer/exportImage?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=5514&imageSR=5514&size=${sw},${sh}&format=tiff&pixelType=F32&f=image`
  return fetchRetry(url, { signal, parse: async res => {
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`)
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
    const w = img.getWidth(), h = img.getHeight()
    if (!w || !h) throw new Error(`${service}: prázdný rastr`)
    const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
    return (x, y) => {
      const px = Math.max(0, Math.min(w - 1, Math.round(((x - minX) / (maxX - minX)) * w - 0.5)))
      const py = Math.max(0, Math.min(h - 1, Math.round(((maxY - y) / (maxY - minY)) * h - 0.5)))
      const e = r[py * w + px] as number
      return Number.isFinite(e) && e > -500 && e < 3000 ? e : null
    }
  } })
}
