/**
 * Katastr a správní členění z ČÚZK: parcely přes WFS, kraj/okres/obec/k.ú. přes RÚIAN.
 *
 * S-JTSK / Křovák (EPSG:5514) — obě služby vrací geometrii v něm a my ji přepočítáváme na WGS84
 * přes `wgsOf` z `./tiles`; ten import zároveň zaručí, že je definice EPSG:5514 v proj4 zaregistrovaná.
 */
import * as Cesium from 'cesium'
import { wgsOf } from './tiles'
import { pointInRing, ringCentroid } from './rings'
import type { Parcel } from './types'

// ── Správní jednotky (kraj/okres/obec + k.ú.) z ČÚZK RÚIAN (ArcGIS REST) ─────────────────
// RÚIAN MapServer má vrstvy s názvy i kódy a jde dotazovat bodem/jménem/kódem obce.
export type AdminUnit = { level: string; name: string; kod: number; layer: number; obec?: number; rings?: [number, number][][] }
const RUIAN = 'https://ags.cuzk.gov.cz/arcgis/rest/services/RUIAN/MapServer'
const RUIAN_LEVELS: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec']] // od největší po nejmenší

/** Dotaz na RÚIAN vrstvu (Esri JSON, geometrie v S-JTSK). geom=true → i prstence. */
export async function ruianQuery(layer: number, where: string, geom: boolean): Promise<Array<{ kod: number; nazev: string; obec?: number; rings: [number, number][][] }>> {
  const url = `${RUIAN}/${layer}/query?where=${encodeURIComponent(where)}&outFields=kod,nazev&returnGeometry=${geom}&outSR=5514&f=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string; obec?: number }; geometry?: { rings?: number[][][] } }> }
  const out: Array<{ kod: number; nazev: string; obec?: number; rings: [number, number][][] }> = []
  for (const f of data.features || []) {
    const rings = (f.geometry?.rings || []).filter(r => r.length >= 3).map(r => r.map(([x, y]) => [x, y] as [number, number]))
    out.push({ kod: Number(f.attributes?.kod), nazev: (f.attributes?.nazev || '').trim(), obec: f.attributes?.obec, rings })
  }
  return out
}
/** Bodový dotaz na vrstvu (jednotka obsahující bod) — bez geometrie, jen název+kód (rychlé). */
export async function ruianAtPoint(layer: number, lon: number, lat: number): Promise<{ kod: number; nazev: string } | null> {
  const url = `${RUIAN}/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=kod,nazev&returnGeometry=false&f=json`
  const res = await fetch(url); if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string } }> }
  const a = data.features?.[0]?.attributes
  return a?.nazev ? { kod: Number(a.kod), nazev: a.nazev.trim() } : null
}

/** Kraj/okres/obec obsahující bod (bez geometrie — ta se dotáhne až při výběru). */
export async function fetchAdminUnits(lon: number, lat: number): Promise<AdminUnit[]> {
  const out: AdminUnit[] = []
  for (const [layer, level] of RUIAN_LEVELS) {
    try { const u = await ruianAtPoint(layer, lon, lat); if (u) out.push({ level, name: u.nazev, kod: u.kod, layer, obec: level === 'Obec' ? u.kod : undefined }) } catch { /* přeskoč */ }
  }
  return out
}
/** Katastrální území dané obce (kód obce) — názvy + kódy, bez geometrie. */
export async function fetchAdminParts(obecKod: number): Promise<AdminUnit[]> {
  const ku = await ruianQuery(7, `obec=${obecKod}`, false)
  return ku.filter(u => u.nazev).map(u => ({ level: 'k.ú.', name: u.nazev, kod: u.kod, layer: 7 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}
/** Dotáhne prstence (S-JTSK) jednotky podle vrstvy+kódu. */
export async function fetchAdminGeom(layer: number, kod: number): Promise<[number, number][][]> {
  const r = await ruianQuery(layer, `kod=${kod}`, true)
  return r[0]?.rings || []
}

/** Jedna parcela z GML odpovědi ČÚZK WFS. */
export type WfsParcel = { id: string; label: string; knArea: number; outer: number[][]; holes: number[][][] }

/**
 * Parcely z GML (= výchozí výstup WFS; `OUTPUTFORMAT=application/json` téže služby nese jen
 * styl a interní id, takže z JSONu výměru ani číslo parcely nedostaneme).
 *
 * `cp:areaValue` je výměra ZAPSANÁ v katastru — není přepočítaná z mapy, proto je to ta,
 * kterou ukazuje ikatastr i list vlastnictví, a v územích s mapou 1:2880 se od geometrie
 * liší o jednotky procent. `cp:label` je číslo parcely („354“, „st. 557“).
 *
 * Geometrie: jeden gml:Polygon, gml:exterior + 0..n gml:interior (vykrojené parcely uvnitř),
 * souřadnice v posList po párech X Y v S-JTSK (EPSG:5514, záporné jako u proj4).
 */
function parseParcelsGml(gml: string): WfsParcel[] {
  const out: WfsParcel[] = []
  for (const chunk of gml.split('<cp:CadastralParcel').slice(1)) {
    const label = (/<cp:label>([^<]*)/.exec(chunk) || [])[1] || ''
    const ref = (/<cp:nationalCadastralReference>([^<]*)/.exec(chunk) || [])[1] || ''
    const kn = parseFloat((/<cp:areaValue[^>]*>([^<]*)/.exec(chunk) || [])[1])
    let outer: number[][] | null = null
    const holes: number[][][] = []
    for (const m of chunk.matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g)) {
      const n = m[2].trim().split(/\s+/)
      const ring: number[][] = []
      for (let i = 0; i + 1 < n.length; i += 2) ring.push([parseFloat(n[i]), parseFloat(n[i + 1])])
      if (ring.length < 3) continue
      if (m[1] === 'interior') holes.push(ring)
      else if (!outer) outer = ring
    }
    if (!outer) continue
    out.push({ id: ref || label, label, knArea: isFinite(kn) ? kn : 0, outer, holes })
  }
  return out
}

/**
 * Z kliku najde katastrální parcelu (ČÚZK WFS, GML v S-JTSK) a vrátí obrys ve WGS84.
 * Stáhne víc kandidátů (BBOX matchuje obálky) a vybere tu, jejíž geometrie bod opravdu obsahuje.
 */
export async function fetchParcelAt(lon: number, lat: number): Promise<Parcel | null> {
  // ~10 m bbox, víc kandidátů; BBOX se NEkóduje (ČÚZK chce literální čárky/dvojtečky)
  const d = 0.0001
  const bbox = `${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=10&BBOX=${bbox}`
  try {
    const feats = parseParcelsGml(await (await fetch(url)).text())
    if (!feats.length) return null
    const toWgs = (r: number[][]) => r.map(([x, y]) => wgsOf(x, y))
    const cands = feats.map(f => ({ ...f, outerW: toWgs(f.outer), holesW: f.holes.map(toWgs) }))
    // Parcela, která bod skutečně obsahuje. Klik v díře patří té VNITŘNÍ parcele, ne téhle —
    // proto se díry z testu vylučují (dřív klik na dům v zahradě vybral zahradu).
    let chosen = cands.find(c => pointInRing(lon, lat, c.outerW) && !c.holesW.some(h => pointInRing(lon, lat, h)))
    if (!chosen) { // nic netrefeno (klik mimo/na hranu) → nejbližší podle těžiště
      let best = Infinity
      for (const c of cands) {
        const [cx, cy] = ringCentroid(c.outerW)
        const dist = (cx - lon) ** 2 + (cy - lat) ** 2
        if (dist < best) { best = dist; chosen = c }
      }
    }
    if (!chosen) return null
    const toCart = (r: [number, number][]) => r.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
    return {
      id: chosen.id, label: chosen.label, knArea: chosen.knArea,
      positions: toCart(chosen.outerW), holes: chosen.holesW.map(toCart),
    }
  } catch {
    return null
  }
}

// ring/holes = surová geometrie v S-JTSK (EPSG:5514); holes jsou vykrojené parcely uvnitř
export type RawParcel = { id: string; label: string; knArea: number; ring: number[][]; holes: number[][][] }

/** Všechny katastrální parcely v bboxu (surová S-JTSK geometrie, pro výběr oblastí polygonem).
 *  ČÚZK WFS ignoruje STARTINDEX, ale respektuje vysoký COUNT → jeden dotaz. Reprojekci děláme až u volajícího
 *  (jen těžiště pro test, plnou geometrii pro vybrané) — reprojektovat tisíce parcel celé je zbytečně drahé. */
export async function fetchParcelsInBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<RawParcel[]> {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=30000&BBOX=${bbox}`
  try {
    // GML i tady, ať mají hromadně vybrané parcely stejná čísla jako ty naklikané
    return parseParcelsGml(await (await fetch(url)).text())
      .map(f => ({ id: f.id, label: f.label, knArea: f.knArea, ring: f.outer, holes: f.holes }))
  } catch { return [] }
}
