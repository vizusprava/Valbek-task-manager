import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import {
  TILE_SIZES, MESH_STEPS, MESH_STEP_DEFAULT, TEX_SIZES, type TileSize, type MeshStep, type TexSize,
  type Tile, type Offset, tileKey, tileName, tileAt, tilesBounds, tileRingLL,
  pool, fetchTileHeights, fetchTileOrtho, buildTileObj, buildMtl, buildMaxScript, medianHeight,
  gridSize, stepOf, concatBytes, estimateObjBytes,
} from './tiles'
import proj4 from 'proj4'
import { fromArrayBuffer } from 'geotiff'
import cdt2d from 'cdt2d'
import polygonClipping from 'polygon-clipping'
import { toast } from 'sonner'
import { Box, Layers, Map as MapIcon, Image, Search, Loader2, Building2, Upload, Move, Crosshair, Trash2, ArrowDownToLine, RotateCcw, MapPin, Mountain, Download, Eye, EyeOff, Hexagon, Check, Sparkles, Grid3x3 } from 'lucide-react'

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined
// Google Photorealistic 3D Tiles streamované přes Cesium ion (stačí ion token, žádný Google klíč).
// Asset je nutné jednorázově přidat ve svém ion účtu (Asset Depot → Google Photorealistic 3D Tiles).
const GOOGLE_3D_ION_ASSET = 2275207

// S-JTSK / Křovák (EPSG:5514) — katastr WFS vrací geometrii v něm, přepočítáváme na WGS84.
// Definice (7-param Helmert) je v ./tiles, který se načte dřív než tenhle modul.

// ── ČÚZK WMS služby (ověřeno přes GetCapabilities — všechny podporují EPSG:3857) ──

// větší dlaždice = méně requestů = méně opakujících se ČÚZK log v mapě
const WMS_TILE = 512

function ortofotoProvider() {
  return new Cesium.WebMapServiceImageryProvider({
    url: 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer',
    layers: '0',
    tileWidth: WMS_TILE,
    tileHeight: WMS_TILE,
    parameters: { format: 'image/png', transparent: false },
  })
}

// Základní topografická mapa ČR (ZTM) — stylovaná rastrová kartografie.
// Stylizovaná podle měřítka, takže podle výšky kamery přepínáme tier.
const ZTM_TIERS = [
  { code: 'ZTM250', minH: 150_000 },
  { code: 'ZTM100', minH: 60_000 },
  { code: 'ZTM50',  minH: 25_000 },
  { code: 'ZTM25',  minH: 8_000 },
  { code: 'ZTM10',  minH: 0 },
] as const

function ztmProvider(code: string) {
  return new Cesium.WebMapServiceImageryProvider({
    url: `https://ags.cuzk.gov.cz/arcgis1/services/ZTM/${code}/MapServer/WMSServer`,
    layers: '0',
    tileWidth: WMS_TILE,
    tileHeight: WMS_TILE,
    parameters: { format: 'image/png', transparent: false },
  })
}

function pickZtmTier(height: number): string {
  for (const t of ZTM_TIERS) if (height >= t.minH) return t.code
  return 'ZTM10'
}

function katastrProvider() {
  return new Cesium.WebMapServiceImageryProvider({
    url: 'https://services.cuzk.cz/wms/wms.asp',
    layers: 'hranice_parcel,parcelni_cisla,obrazy_parcel,DEF_BUDOVY',
    parameters: { format: 'image/png', transparent: true },
  })
}

const CR_EXTENT = Cesium.Rectangle.fromDegrees(12.0, 48.5, 18.9, 51.1)
// úvodní pohled: přiblížení na Liberec
const LIBEREC_EXTENT = Cesium.Rectangle.fromDegrees(14.98, 50.72, 15.13, 50.81)
// geoidová odchylka Bpv→WGS84 elipsoid v ČR (~+44 m); konstanta lokálně stačí
const GEOID_CZ = 44
// Google Photorealistic dlaždice sedí ~0,5 m níž než DMR — zvedneme je, ať to lícuje
const GOOGLE_LIFT_M = 0.5
// 3ds Max při exportu glb otočí model o 90° kolem svislé osy — při kotveném importu kompenzujeme
const MAX_GLB_YAW_DEG = 90
// OSM budovy posunout o 1 m dolů, ať lépe sedí na terén
const OSM_LIFT_M = -1.5
// svítící obrys kolem importovaného modelu (glow) + barva hrany řezu terénem
const MODEL_GLOW = Cesium.Color.fromCssColorString('#38f8ff')

// Omezení souběžných DMR fetchů: velká plocha jinak vystřelí tisíce fetchů naráz → ERR_INSUFFICIENT_RESOURCES.
// Jednoduchý semafor + cache dlaždic (sampleTerrain často žádá tytéž dlaždice opakovaně).
const DMR_MAX_CONCURRENT = 6
let dmrActive = 0
const dmrQueue: (() => void)[] = []
function dmrAcquire(): Promise<void> {
  if (dmrActive < DMR_MAX_CONCURRENT) { dmrActive++; return Promise.resolve() }
  return new Promise<void>(res => dmrQueue.push(() => { dmrActive++; res() }))
}
function dmrRelease() {
  dmrActive--
  dmrQueue.shift()?.()
}
const dmrTileCache = new Map<string, Float32Array>()
const DMR_CACHE_MAX = 4000

// Terén celé mapy z ČÚZK DMR 5G — výšky se tahají z exportImage pro každou dlaždici za běhu.
// Tím ortofoto/ZTM i vložené plochy/modely leží na stejném přesném terénu.
function makeDmrTerrain(): Cesium.CustomHeightmapTerrainProvider {
  const tilingScheme = new Cesium.GeographicTilingScheme()
  const W = 64, H = 64
  return new Cesium.CustomHeightmapTerrainProvider({
    width: W,
    height: H,
    tilingScheme,
    callback: async (x, y, level) => {
      const rect = tilingScheme.tileXYToRectangle(x, y, level)
      const west = Cesium.Math.toDegrees(rect.west), south = Cesium.Math.toDegrees(rect.south)
      const east = Cesium.Math.toDegrees(rect.east), north = Cesium.Math.toDegrees(rect.north)
      const flat = new Float32Array(W * H)
      if (east < 12.0 || west > 18.9 || north < 48.5 || south > 51.1) return flat // mimo ČR
      const key = `${level}/${x}/${y}`
      const cached = dmrTileCache.get(key)
      if (cached) return cached
      await dmrAcquire()
      try {
        const hit = dmrTileCache.get(key) // mezitím mohla dorazit
        if (hit) return hit
        const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=4326&size=${W},${H}&format=tiff&pixelType=F32&f=image`
        const img = await (await fromArrayBuffer(await (await fetch(url)).arrayBuffer())).getImage()
        const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
        const out = new Float32Array(W * H)
        for (let i = 0; i < W * H; i++) {
          const e = r[i] as number
          out[i] = Number.isFinite(e) && e > -500 && e < 3000 ? e + GEOID_CZ : 0
        }
        if (dmrTileCache.size >= DMR_CACHE_MAX) dmrTileCache.delete(dmrTileCache.keys().next().value as string)
        dmrTileCache.set(key, out)
        return out
      } catch {
        return flat
      } finally {
        dmrRelease()
      }
    },
  })
}

type Base = 'ortofoto' | 'zm' | 'google'

// kotva modelu: zeměpisná poloha + výška nad terénem + natočení (heading/pitch/roll) + měřítko
type Placement = { lon: number; lat: number; groundH: number; heightOffset: number; heading: number; pitch: number; roll: number; scale: number }

type GroundHit = { lon: number; lat: number; height: number }
type Parcel = { id: string; positions: Cesium.Cartesian3[] }
type Anchor = { lon: number; lat: number; h: number }
// data DMR výseku pro export (ECEF vrcholy + indexy + geo-kotva + obrys parcely pro budovy)
type DmrData = { positions: number[]; indices: number[]; anchor: Anchor; ring: number[][]; holes?: number[][][] }

// jeden importovaný model ve scéně
type ModelEntry = {
  id: string
  name: string
  model: Cesium.Model
  url: string
  center: Cesium.Cartesian3
  yawDeg: number
  placement: Placement
  visible: boolean
  excavCells?: ExcavCell[]          // syrové dlaždice půdorysu (pro volitelný výkop, počítá se lazy)
  footprint?: Cesium.Cartesian3[][] // spočítaný výkop (jen kde model dosahuje k povrchu; tunely přeskočeny)
  excavate?: boolean                // vyhloubit pod ním terén, ať je vidět zapuštěná část
}
// položka panelu Scéna
type SceneObj = { id: string; kind: 'model' | 'parcel' | 'surface' | 'dmr'; name: string; visible: boolean }

/**
 * Geo-kotva v názvu jako CELÁ ČÍSLA bez teček (lon/lat v mikrostupních, výška v cm) —
 * tečky některé programy (3ds Max) usekávají u prvního „.". Formát: geo_<lonE6>_<latE6>_<hCm>.
 */
function parseAnchor(name: string): Anchor | null {
  const m = name.match(/geo_(-?\d+)_(-?\d+)_(-?\d+)/)
  return m ? { lon: +m[1] / 1e6, lat: +m[2] / 1e6, h: +m[3] / 100 } : null
}

function download(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function makeGeom(positions: number[], indices: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const vcount = positions.length / 3
  g.setIndex(vcount < 65536 ? new THREE.Uint16BufferAttribute(indices, 1) : new THREE.Uint32BufferAttribute(indices, 1))
  g.computeVertexNormals()
  return g
}

/**
 * Export scény pro víc výseků v lokálním ENU rámci kolem kotvy prvního výseku (gltf Y-up: E, U, -N).
 * Vrací TERÉN a BUDOVY jako oddělené geometrie (dva objekty v souboru). Budovy z OSM (Overpass).
 */
async function buildExportScene(patches: DmrData[], withBuildings: boolean): Promise<{ terrain: THREE.BufferGeometry; buildings: THREE.BufferGeometry | null; anchor: Anchor }> {
  const anchor = patches[0].anchor
  const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
  const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
  const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3()
  const local = (x: number, y: number, z: number): [number, number, number] => { s.x = x; s.y = y; s.z = z; Cesium.Matrix4.multiplyByPoint(inv, s, o); return [o.x, o.z, -o.y] }
  const enu2 = (x: number, y: number, z: number): [number, number] => { s.x = x; s.y = y; s.z = z; Cesium.Matrix4.multiplyByPoint(inv, s, o); return [o.x, o.y] }

  // ── TERÉN (všechny výseky) ──
  const tPos: number[] = [], tIdx: number[] = []
  for (const data of patches) {
    const t0 = tPos.length / 3
    const n = data.positions.length / 3
    for (let i = 0; i < n; i++) { const [a, b, c] = local(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]); tPos.push(a, b, c) }
    for (const idx of data.indices) tIdx.push(t0 + idx)
  }
  const terrain = makeGeom(tPos, tIdx)

  // ── BUDOVY (OSM, všechny výseky) — zvlášť ──
  let buildings: THREE.BufferGeometry | null = null
  if (withBuildings) {
    const bPos: number[] = [], bIdx: number[] = []
    const pushLocal = (x: number, y: number, z: number): number => { const [a, b, c] = local(x, y, z); const i = bPos.length / 3; bPos.push(a, b, c); return i }
    // OSM per parcela (malý bbox = rychlý dotaz, žádný 504); sekvenčně s retry/mirrory kvůli 429
    for (const data of patches) {
      if (data.ring.length < 3) continue
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
      for (const [lon, lat] of data.ring) { minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat) }
      try {
        const [bldgs, dmr, dmp] = await Promise.all([
          fetchOsmBuildingsTiled(minLon, minLat, maxLon, maxLat),
          fetchElevSampler('dmr5g', minLon, minLat, maxLon, maxLat, 1024),
          fetchElevSampler('dmp1g', minLon, minLat, maxLon, maxLat, 1024),
        ])
        for (const bld of bldgs) {
          const [cx, cy] = ringCentroid(bld.ring)
          if (!pointInRing(cx, cy, data.ring)) continue
          if (data.holes?.some(h => pointInRing(cx, cy, h))) continue
          const r = bld.ring.slice()
          if (r.length > 1) { const a = r[0], b = r[r.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) r.pop() }
          if (r.length < 3) continue
          let baseH = Infinity
          for (const [lon, lat] of r) { const d = dmr(lon, lat); if (d != null) baseH = Math.min(baseH, d) }
          if (!Number.isFinite(baseH)) continue
          const bEll = baseH + GEOID_CZ
          let tEll: number
          if (bld.height != null) tEll = bEll + bld.height
          else { let topH = -Infinity; for (const [lon, lat] of r) { const sp = dmp(lon, lat); if (sp != null) topH = Math.max(topH, sp) }; if (!Number.isFinite(topH)) continue; tEll = topH + GEOID_CZ }
          if (tEll - bEll < 2) continue
          const nb = r.length
          const baseIdx: number[] = [], topIdx: number[] = [], footprint: number[][] = []
          for (const [lon, lat] of r) {
            const pb = Cesium.Cartesian3.fromDegrees(lon, lat, bEll)
            const pt = Cesium.Cartesian3.fromDegrees(lon, lat, tEll)
            footprint.push(enu2(pb.x, pb.y, pb.z))
            baseIdx.push(pushLocal(pb.x, pb.y, pb.z))
            topIdx.push(pushLocal(pt.x, pt.y, pt.z))
          }
          for (let i = 0; i < nb; i++) { const j = (i + 1) % nb; bIdx.push(baseIdx[i], baseIdx[j], topIdx[j], baseIdx[i], topIdx[j], topIdx[i]) }
          const loop: number[][] = []
          for (let i = 0; i < nb; i++) loop.push([i, (i + 1) % nb])
          for (const [a, b, c] of cdt2d(footprint, loop, { exterior: false })) {
            bIdx.push(topIdx[a], topIdx[b], topIdx[c])
            bIdx.push(baseIdx[a], baseIdx[c], baseIdx[b])
          }
        }
      } catch (e) { console.error('Budovy do exportu selhaly:', e) }
    }
    if (bPos.length) buildings = makeGeom(bPos, bIdx)
  }

  return { terrain, buildings, anchor }
}

function anchorFilename(anchor: Anchor, ext: string): string {
  const lon = Math.round(anchor.lon * 1e6)
  const lat = Math.round(anchor.lat * 1e6)
  const h = Math.round(anchor.h * 100)
  return `geo_${lon}_${lat}_${h}.${ext}`
}

/**
 * Uzavřené 3D polyliny do DXF (R12) — importuje se do 3ds Max/CAD jako editovatelné splajny/tvary.
 * Souřadnice v lokálním ENU (X=východ, Y=sever, Z=nahoru), stejný rámec jako OBJ export terénu.
 */
function buildDxf(polylines: [number, number, number][][]): string {
  const L: (string | number)[] = []
  const g = (code: number, val: string | number) => { L.push(code, val) }
  g(0, 'SECTION'); g(2, 'ENTITIES')
  for (const pl of polylines) {
    g(0, 'POLYLINE'); g(8, 'PARCELY'); g(66, 1); g(70, 9) // 1=uzavřená + 8=3D polylinie
    for (const [x, y, z] of pl) {
      g(0, 'VERTEX'); g(8, 'PARCELY')
      g(10, x.toFixed(4)); g(20, y.toFixed(4)); g(30, z.toFixed(4)); g(70, 32) // 32=vrchol 3D polylinie
    }
    g(0, 'SEQEND')
  }
  g(0, 'ENDSEC'); g(0, 'EOF')
  return L.join('\n')
}

type OsmBuilding = { ring: number[][]; height: number | null }

/** Půdorysy budov z OpenStreetMap (Overpass API) pro bbox — WGS84, + výška z tagů (matchuje zobrazené OSM budovy). */
async function fetchOsmBuildings(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<OsmBuilding[]> {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`
  const q = `[out:json][timeout:25];(way["building"](${bbox});relation["building"](${bbox}););out geom tags;`
  // víc mirrorů; některé občas úplně visí (žádná odpověď) → viz AbortController timeout níž.
  // Pozn: NEpoužívat regionální instance (např. overpass.osm.ch = jen Švýcarsko) — vrátí 200 s 0 budovami!
  const endpoints = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ]
  const out: OsmBuilding[] = []
  type Node = { lat: number; lon: number }
  type El = { type: string; geometry?: Node[]; members?: { role: string; geometry?: Node[] }[]; tags?: Record<string, string> }
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const REQ_TIMEOUT = 12000 // některé mirrory neodpoví vůbec → nezamrznout, po 12 s zkusit další
  for (let attempt = 0; attempt < endpoints.length * 2; attempt++) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT)
      let res: Response
      try { res = await fetch(endpoints[attempt % endpoints.length] + '?data=' + encodeURIComponent(q), { signal: ctrl.signal }) }
      finally { clearTimeout(timer) }
      if (res.status === 429 || res.status === 504 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue } // rate-limit/timeout → hned jiný mirror
      if (!res.ok) { await sleep(400); continue }
      const data = await res.json() as { elements?: El[] }
      for (const el of data.elements ?? []) {
        let geom: Node[] | undefined
        if (el.type === 'way') geom = el.geometry
        else if (el.type === 'relation') geom = el.members?.find(m => m.role === 'outer' && m.geometry)?.geometry
        if (!geom || geom.length < 3) continue
        const tags = el.tags ?? {}
        let height: number | null = null
        if (tags.height) height = parseFloat(tags.height)
        else if (tags['building:levels']) height = parseFloat(tags['building:levels']) * 3
        if (!Number.isFinite(height as number)) height = null
        out.push({ ring: geom.map(g => [g.lon, g.lat]), height })
      }
      return out
    } catch { await sleep(1000) }
  }
  return out
}

/** Overpass pro velký bbox rozdělený na dlaždice — velký bbox vrací 504 (Gateway Timeout).
 *  Sekvenčně po ~600 m dlaždicích (retry/mirrory řeší fetchOsmBuildings), dedup podle geometrie. */
async function fetchOsmBuildingsTiled(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<OsmBuilding[]> {
  const MAX_SPAN = 0.008 // ~600 m; větší dotaz Overpass často odmítne
  const nx = Math.max(1, Math.ceil((maxLon - minLon) / MAX_SPAN))
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / MAX_SPAN))
  const dx = (maxLon - minLon) / nx, dy = (maxLat - minLat) / ny
  const out: OsmBuilding[] = []
  const seen = new Set<string>()
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = minLon + ix * dx, b = minLat + iy * dy
      const cells = await fetchOsmBuildings(a, b, a + dx, b + dy)
      for (const c of cells) {
        const [cx, cy] = ringCentroid(c.ring) // budova u hrany dlaždice se vrátí ve dvou → dedup podle těžiště
        const key = `${cx.toFixed(6)},${cy.toFixed(6)}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(c)
      }
    }
  }
  return out
}

/** Výškový rastr z ČÚZK ImageServeru (dmr5g/dmp1g) → vzorkovací funkce lon/lat → výška (Bpv). */
async function fetchElevSampler(service: 'dmr5g' | 'dmp1g', minLon: number, minLat: number, maxLon: number, maxLat: number, size: number): Promise<(lon: number, lat: number) => number | null> {
  const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/${service}/ImageServer/exportImage?bbox=${minLon},${minLat},${maxLon},${maxLat}&bboxSR=4326&imageSR=4326&size=${size},${size}&format=tiff&pixelType=F32&f=image`
  const img = await (await fromArrayBuffer(await (await fetch(url)).arrayBuffer())).getImage()
  const w = img.getWidth(), h = img.getHeight()
  const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
  return (lon, lat) => {
    const x = Math.max(0, Math.min(w - 1, Math.round(((lon - minLon) / (maxLon - minLon)) * w - 0.5)))
    const y = Math.max(0, Math.min(h - 1, Math.round(((maxLat - lat) / (maxLat - minLat)) * h - 0.5)))
    const e = r[y * w + x] as number
    return Number.isFinite(e) && e > -500 && e < 3000 ? e : null
  }
}

/** Najde 3D bod povrchu (terén/dlaždice) pod daným bodem obrazovky. */
function pickGround(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const scene = v.scene
  let cart: Cesium.Cartesian3 | undefined
  if (scene.pickPositionSupported) {
    const c = scene.pickPosition(screen)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) {
    const ray = v.camera.getPickRay(screen)
    if (ray) { const c = scene.globe.pick(ray, scene); if (Cesium.defined(c)) cart = c }
  }
  if (!cart) {
    const c = v.camera.pickEllipsoid(screen, scene.globe.ellipsoid)
    if (Cesium.defined(c)) cart = c
  }
  if (!cart) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Bod terénu pod kurzorem nezávisle na modelu (globe.pick ignoruje primitivy modelu). */
function pickTerrain(v: Cesium.Viewer, screen: Cesium.Cartesian2): GroundHit | null {
  const ray = v.camera.getPickRay(screen)
  let cart = ray ? v.scene.globe.pick(ray, v.scene) : undefined
  if (!Cesium.defined(cart)) cart = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid)
  if (!Cesium.defined(cart)) return null
  const carto = Cesium.Cartographic.fromCartesian(cart)
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: carto.height }
}

/** Povrch pod středem obrazovky (kam se zhruba dívá kamera). */
function viewCenterGround(v: Cesium.Viewer): GroundHit {
  const canvas = v.scene.canvas
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
  const hit = pickGround(v, center)
  if (hit) return hit
  const carto = v.camera.positionCartographic
  return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude), height: 0 }
}

function positionOf(p: Placement): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.groundH + p.heightOffset)
}

function buildMatrix(p: Placement, centerOffset: Cesium.Cartesian3, yawDeg = 0): Cesium.Matrix4 {
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(p.heading + yawDeg),
    Cesium.Math.toRadians(p.pitch),
    Cesium.Math.toRadians(p.roll),
  )
  const frame = Cesium.Transforms.headingPitchRollToFixedFrame(positionOf(p), hpr)
  const scaled = Cesium.Matrix4.multiplyByUniformScale(frame, p.scale, new Cesium.Matrix4())
  const tneg = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.negate(centerOffset, new Cesium.Cartesian3()))
  return Cesium.Matrix4.multiply(scaled, tneg, new Cesium.Matrix4())
}

// three loader jen pro změření modelu (nejnižší bod) — Cesium si model vykresluje sám
let gltfLoader: GLTFLoader | null = null
function getGltfLoader(): GLTFLoader {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader()
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
    gltfLoader.setDRACOLoader(draco)
    gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  }
  return gltfLoader
}

/** Nejnižší bod modelu v lokální Z-up soustavě Cesia (gltf Y-up = cesium Z-up). null = nezměřeno. */
async function computeBottomZ(file: File): Promise<number | null> {
  try {
    const buf = await file.arrayBuffer()
    const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
      getGltfLoader().parse(buf, '', g => resolve(g as unknown as { scene: THREE.Object3D }), reject)
    })
    const box = new THREE.Box3().setFromObject(gltf.scene)
    return Number.isFinite(box.min.y) ? box.min.y : null
  } catch {
    return null
  }
}

/**
 * Model z 3ds Max s reálnými S-JTSK (EPSG:5514) souřadnicemi v geometrii → přemapuje každý vrchol
 * proj4 (S-JTSK→WGS84) + výška Bpv→elipsoid a zapeče do lokálního ENU rámce (E,U,-N) kolem těžiště,
 * stejnou konvencí jako náš export. Vrací glb URL + geo-kotvu. null = nevypadá jako S-JTSK (necháme ruční).
 * Osy/znaménko se detekují z dat: výška = osa s nejmenší velikostí, horizontály dle velikosti (v ČR |Y|>|X|),
 * proj4 chce záporné hodnoty.
 */
// dlaždice půdorysu modelu pro výkop: střed (lon/lat), nejvyšší bod modelu (elipsoidálně) a čtverec (lon/lat rohy)
type ExcavCell = { lon: number; lat: number; topEll: number; squareLL: [number, number][] }
const EXCAV_CELL_M = 10 // velikost dlaždice výkopu
const EXCAV_MAX_DEPTH_M = 30 // model hlouběji pod terénem než tohle = tunel → nehloubit (terén zůstane)

async function georeferenceSjtskGlb(file: File): Promise<{ url: string; anchor: Anchor; bottomZ: number; cells: ExcavCell[] } | null> {
  const buf = await file.arrayBuffer()
  const gltf = await new Promise<{ scene: THREE.Object3D }>((res, rej) => {
    getGltfLoader().parse(buf, '', g => res(g as unknown as { scene: THREE.Object3D }), rej)
  })
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  if (box.isEmpty()) return null
  const c = box.getCenter(new THREE.Vector3())
  const comp = (v: THREE.Vector3, a: 'x' | 'y' | 'z') => (a === 'x' ? v.x : a === 'y' ? v.y : v.z)
  // velké souřadnice (statisíce metrů) ⇒ S-JTSK; jinak běžný model
  if (Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) < 100000) return null

  const axes: Array<{ k: 'x' | 'y' | 'z'; val: number }> = [
    { k: 'x' as const, val: c.x }, { k: 'y' as const, val: c.y }, { k: 'z' as const, val: c.z },
  ].sort((a, b) => Math.abs(a.val) - Math.abs(b.val))
  const upAxis = axes[0].k                        // nejmenší velikost = výška
  const xAxis = axes[1].k, yAxis = axes[2].k       // menší horizontální = S-JTSK X, větší = Y
  const fx = axes[1].val > 0 ? -1 : 1              // proj4 EPSG:5514 chce záporné
  const fy = axes[2].val > 0 ? -1 : 1
  const toSjtsk = (v: THREE.Vector3): [number, number, number] => [fx * comp(v, xAxis), fy * comp(v, yAxis), comp(v, upAxis)]

  const [aLon, aLat] = proj4('EPSG:5514', 'EPSG:4326', [fx * comp(c, xAxis), fy * comp(c, yAxis)]) as [number, number]
  const anchor: Anchor = { lon: aLon, lat: aLat, h: comp(c, upAxis) + GEOID_CZ }
  const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
  const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
  const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3(), vw = new THREE.Vector3()
  let minU = Infinity
  // mřížka půdorysu: pro každou dlaždici (ENU) drž nejvyšší bod modelu (up) → úzký výkop kopírující trasu
  const grid = new Map<string, { gx: number; gy: number; top: number }>()

  const meshes: THREE.Mesh[] = []
  scene.traverse(obj => { const m = obj as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry
    const pos = g.attributes.position as THREE.BufferAttribute
    const wm = m.matrixWorld
    for (let i = 0; i < pos.count; i++) {
      vw.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm) // do světových souřadnic (respektuj hierarchii)
      const [sx, sy, up] = toSjtsk(vw)
      const [lon, lat] = proj4('EPSG:5514', 'EPSG:4326', [sx, sy]) as [number, number]
      const e = Cesium.Cartesian3.fromDegrees(lon, lat, up + GEOID_CZ)
      s.x = e.x; s.y = e.y; s.z = e.z
      Cesium.Matrix4.multiplyByPoint(inv, s, o) // (east, north, up) v ENU kolem kotvy
      pos.setXYZ(i, o.x, o.z, -o.y)             // gltf (E, U, -N) — stejné jako buildExportScene
      if (o.z < minU) minU = o.z
      const gx = Math.floor(o.x / EXCAV_CELL_M), gy = Math.floor(o.y / EXCAV_CELL_M)
      const key = `${gx}_${gy}`
      const cur = grid.get(key)
      if (!cur || o.z > cur.top) grid.set(key, { gx, gy, top: o.z })
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }
  // z mřížky poskládej dlaždice výkopu (čtverce v ECEF + lon/lat středu + elipsoidální vršek modelu)
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF)
  const HALF = EXCAV_CELL_M / 2 + 0.5 // malý přesah, ať dlaždice po union těsně splynou
  const enuToLL = (e: number, n: number): [number, number] => {
    const carto = Cesium.Cartographic.fromCartesian(Cesium.Matrix4.multiplyByPoint(frame, new Cesium.Cartesian3(e, n, 0), new Cesium.Cartesian3()))
    return [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)]
  }
  const cells: ExcavCell[] = []
  for (const { gx, gy, top } of grid.values()) {
    const cx = (gx + 0.5) * EXCAV_CELL_M, cy = (gy + 0.5) * EXCAV_CELL_M
    const [clon, clat] = enuToLL(cx, cy)
    cells.push({
      lon: clon, lat: clat, topEll: anchor.h + top,
      squareLL: [enuToLL(cx - HALF, cy - HALF), enuToLL(cx + HALF, cy - HALF), enuToLL(cx + HALF, cy + HALF), enuToLL(cx - HALF, cy + HALF)],
    })
  }
  // world transformy jsou zapečené do vrcholů → vynuluj všechny node transformy
  scene.traverse(obj => { obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix() })
  scene.updateMatrixWorld(true)

  const glbBuf = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(scene, r => res(r as ArrayBuffer), rej, { binary: true }))
  const url = URL.createObjectURL(new Blob([glbBuf], { type: 'model/gltf-binary' }))
  return { url, anchor, bottomZ: Number.isFinite(minU) ? minU : 0, cells }
}

/** Test bod-v-polygonu (ray casting); ring = [[lon,lat], …]. */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function ringCentroid(ring: number[][]): [number, number] {
  let sx = 0, sy = 0
  for (const [x, y] of ring) { sx += x; sy += y }
  return [sx / ring.length, sy / ring.length]
}

/**
 * Z kliku najde katastrální parcelu (ČÚZK WFS, GeoJSON v S-JTSK) a vrátí obrys ve WGS84.
 * Stáhne víc kandidátů (BBOX matchuje obálky) a vybere tu, jejíž geometrie bod opravdu obsahuje.
 */
async function fetchParcelAt(lon: number, lat: number): Promise<Parcel | null> {
  // ~10 m bbox, víc kandidátů; BBOX se NEkóduje (ČÚZK chce literální čárky/dvojtečky)
  const d = 0.0001
  const bbox = `${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=10&OUTPUTFORMAT=application/json&BBOX=${bbox}`
  try {
    const res = await fetch(url)
    const data = await res.json() as { features?: Array<{ geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }> }
    const feats = data.features ?? []
    if (!feats.length) return null
    // přepočítej obrysy kandidátů na WGS84 (S-JTSK → WGS84)
    const cands = feats.map(f => {
      const rings: number[][][] = []
      if (f.geometry.type === 'Polygon') rings.push((f.geometry.coordinates as number[][][])[0])
      else if (f.geometry.type === 'MultiPolygon') for (const poly of (f.geometry.coordinates as number[][][][])) rings.push(poly[0])
      const wgs = rings.map(r => r.map(([x, y]) => proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]))
      return { id: String(f.properties?.id ?? ''), wgs }
    }).filter(c => c.wgs.length > 0)
    if (!cands.length) return null
    // vyber tu, jejíž geometrie bod skutečně obsahuje; jinak nejbližší podle těžiště
    let chosen = cands.find(c => c.wgs.some(r => pointInRing(lon, lat, r)))
    if (!chosen) {
      let best = Infinity
      for (const c of cands) {
        const [cx, cy] = ringCentroid(c.wgs[0])
        const dist = (cx - lon) ** 2 + (cy - lat) ** 2
        if (dist < best) { best = dist; chosen = c }
      }
    }
    if (!chosen) return null
    const positions = chosen.wgs[0].map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
    return { id: chosen.id, positions }
  } catch {
    return null
  }
}

type RawParcel = { id: string; ring: number[][] } // ring je surová geometrie v S-JTSK (EPSG:5514)

/** Všechny katastrální parcely v bboxu (surová S-JTSK geometrie, pro výběr oblastí polygonem).
 *  ČÚZK WFS ignoruje STARTINDEX, ale respektuje vysoký COUNT → jeden dotaz. Reprojekci děláme až u volajícího
 *  (jen těžiště pro test, plnou geometrii pro vybrané) — reprojektovat tisíce parcel celé je zbytečně drahé. */
async function fetchParcelsInBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<RawParcel[]> {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=30000&OUTPUTFORMAT=application/json&BBOX=${bbox}`
  const out: RawParcel[] = []
  try {
    const data = await (await fetch(url)).json() as { features?: Array<{ id?: string; geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }> }
    for (const f of data.features ?? []) {
      let ring: number[][] | null = null
      if (f.geometry.type === 'Polygon') ring = (f.geometry.coordinates as number[][][])[0]
      else if (f.geometry.type === 'MultiPolygon') ring = (f.geometry.coordinates as number[][][][])[0][0]
      if (!ring) continue
      out.push({ id: String(f.properties?.id ?? f.id ?? ''), ring })
    }
  } catch { /* ignore */ }
  return out
}

// Katastrální území statutárního města Liberec (26) — kód k.ú. (RÚIAN) → název.
// Kód = `properties.id` z WFS cp:CadastralZoning; filtrujeme jimi „jen pod Libercem".
const LIBEREC_KU: Record<string, string> = {
  '682039': 'Liberec', '682144': 'Ruprechtice', '682161': 'Nové Pavlovice', '682179': 'Staré Pavlovice',
  '682209': 'Růžodol I', '682233': 'Františkov u Liberce', '682241': 'Janův Důl u Liberce', '682250': 'Horní Růžodol',
  '682268': 'Dolní Hanychov', '682314': 'Rochlice u Liberce', '682390': 'Starý Harcov', '682438': 'Kateřinky u Liberce',
  '682446': 'Rudolfov', '682462': 'Horní Hanychov', '682471': 'Ostašov u Liberce', '682489': 'Horní Suchá u Liberce',
  '682497': 'Karlinky', '673641': 'Krásná Studánka', '673650': 'Radčice u Krásné Studánky', '631086': 'Doubí u Liberce',
  '631094': 'Hluboká u Liberce', '631108': 'Pilínkov', '780472': 'Vesec u Liberce', '785628': 'Kunratice u Liberce',
  '785644': 'Vratislavice nad Nisou', '689823': 'Machnín',
}

type District = { code: string; name: string; rings: Cesium.Cartesian3[][] }

const AURORA_HEIGHT_M = 220 // jak vysoko stoupá „polární záře" nad terén
const AURORA_LABEL_LIFT_M = 90 // popisek pluje kousek nad září
// o kolik zapustit základnu pod terén: kryje nesoulad výšek DMR (základna) vs. zobrazeného povrchu
// (hlavně Google 3D realita se liší i o desítky metrů). Zapuštěná část je pod zemí, glow začíná u povrchu.
const AURORA_SINK_M = 50

// Shaderový materiál záře: svislý fade (dole sytě → nahoru mizí) + stoupající vlny (nahoru/dolů) — GPU, plynulé.
// st.t = 0 u základny stěny, 1 nahoře. czm_frameNumber pohání animaci (viewer renderuje kontinuálně).
function auroraMaterial(color: Cesium.Color, phase: number): Cesium.Material {
  return new Cesium.Material({
    translucent: true,
    fabric: {
      uniforms: { uColor: color, uPhase: phase },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float v = clamp(materialInput.st.t, 0.0, 1.0);
          float s = materialInput.st.s;                                     // 0..1 podél délky stěny
          float fade = pow(1.0 - v, 1.3);                                   // sytě dole, mizí nahoru
          // fáze posunutá i podél délky (s) → vlna dojede nahoru na každém místě jindy (diagonální vlnění)
          float wave = 0.5 + 0.5 * sin(v * 9.0 - czm_frameNumber * 0.03 + uPhase + s * 22.0);
          m.diffuse = uColor.rgb;
          m.emission = uColor.rgb * 0.25;
          m.alpha = uColor.a * fade * (0.4 + 0.6 * wave);
          return m;
        }
      `,
    },
  })
}

/** Uzavřený obrys zhladí Catmull-Rom splinem — místo lomené čáry plynulá křivka (hladší stěna záře). */
function smoothClosedRing(pts: [number, number][], stepsPerSeg: number): [number, number][] {
  const n = pts.length
  if (n < 3) return pts
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t, t3 = t2 * t
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  }
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    for (let s = 0; s < stepsPerSeg; s++) {
      const t = s / stepsPerSeg
      out.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t)])
    }
  }
  return out
}

/** Katastrální území Liberce z ČÚZK WFS (CadastralZoning), filtrovaná na obec Liberec dle LIBEREC_KU. */
async function fetchLiberecDistricts(): Promise<District[]> {
  const bbox = '50.68,14.94,50.83,15.15,urn:ogc:def:crs:EPSG::4326'
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralZoning&COUNT=300&OUTPUTFORMAT=application/json&BBOX=${bbox}`
  const out: District[] = []
  try {
    const data = await (await fetch(url)).json() as { features?: Array<{ properties?: { id?: number | string }; geometry: { type: string; coordinates: unknown } }> }
    for (const f of data.features ?? []) {
      const code = String(f.properties?.id ?? '')
      const name = LIBEREC_KU[code]
      if (!name) continue
      const ringsRaw: number[][][] = []
      if (f.geometry.type === 'Polygon') ringsRaw.push((f.geometry.coordinates as number[][][])[0])
      else if (f.geometry.type === 'MultiPolygon') for (const poly of (f.geometry.coordinates as number[][][][])) ringsRaw.push(poly[0])
      const rings = ringsRaw.filter(r => r && r.length >= 3).map(r => r.map(([x, y]) => {
        const [lo, la] = proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]
        return Cesium.Cartesian3.fromDegrees(lo, la)
      }))
      if (rings.length) out.push({ code, name, rings })
    }
  } catch { /* ignore */ }
  return out
}

export function MapView({ onBackToEditor }: { onBackToEditor: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const ortoRef = useRef<Cesium.ImageryLayer | null>(null)
  const ztmRefs = useRef<Record<string, Cesium.ImageryLayer>>({})
  const katastrRef = useRef<Cesium.ImageryLayer | null>(null)
  const googleRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const osmRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map())
  const selectedIdRef = useRef<string | null>(null)
  // multi-parcela: vybrané parcely + jejich hotové DMR výseky (klíč = id parcely)
  const parcelsRef = useRef<Map<string, { positions: Cesium.Cartesian3[]; ring: number[][]; ents: Cesium.Entity[] }>>(new Map())
  const patchesRef = useRef<Map<string, { data: DmrData; prim: Cesium.Primitive }>>(new Map())
  const fileRef = useRef<HTMLInputElement>(null)

  const [base, setBase] = useState<Base>('ortofoto')
  const [ztmTier, setZtmTier] = useState<string>('ZTM250')
  const [katastrOn, setKatastrOn] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleErr, setGoogleErr] = useState<string | null>(null)

  // scéna: seznam objektů + vybraný + umístění vybraného modelu
  const [objects, setObjects] = useState<SceneObj[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [moveMode, setMoveMode] = useState(false)
  // řez terénem: svislá clipping rovina odřízne terén/Google → profil model+terén
  const [sectionOn, setSectionOn] = useState(false)
  const [sectionAz, setSectionAz] = useState(0)       // azimut normály roviny (°)
  const [sectionOffset, setSectionOffset] = useState(0) // posun roviny podél normály (m)
  const [sectionFlip, setSectionFlip] = useState(false) // která strana se odřízne

  // výběr parcel (multi)
  const [parcelMode, setParcelMode] = useState(false)
  const [parcelLoading, setParcelLoading] = useState(false)
  const [parcelCount, setParcelCount] = useState(0)
  // výběr oblasti: naklikat body → vybrat všechny parcely uvnitř polygonu
  const [areaMode, setAreaMode] = useState(false)
  const [areaPtCount, setAreaPtCount] = useState(0)
  const [areaLoading, setAreaLoading] = useState(false)
  const areaPtsRef = useRef<Cesium.Cartesian3[]>([])
  const areaEntsRef = useRef<Cesium.Entity[]>([])

  const [tileMode, setTileMode] = useState(false)
  const [tileSize, setTileSize] = useState<TileSize>(500)
  const [texSize, setTexSize] = useState<TexSize>(2048)
  const [meshStep, setMeshStep] = useState<MeshStep>(MESH_STEP_DEFAULT)
  const [tileCount, setTileCount] = useState(0)
  const [tileBusy, setTileBusy] = useState(false)
  const [tileProgress, setTileProgress] = useState('')
  const tilesRef = useRef<Map<string, { tile: Tile; ent: Cesium.Entity }>>(new Map())
  // detailní DMR-5G výseky
  const [dmrLoading, setDmrLoading] = useState(false)
  const [patchCount, setPatchCount] = useState(0)
  const [exporting, setExporting] = useState(false)
  // OSM budovy (globální šedé bloky přes ion) — spolehlivé pokrytí
  const [osmOn, setOsmOn] = useState(false)
  const [osmLoading, setOsmLoading] = useState(false)
  // městské části Liberce (katastrální území) se zářícím obrysem
  const [districtsOn, setDistrictsOn] = useState(false)
  const [districtsLoading, setDistrictsLoading] = useState(false)
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null)
  const districtsRef = useRef<Map<string, { name: string; color: Cesium.Color; rings: Cesium.Cartesian3[][]; ents: Cesium.Entity[]; prims: Cesium.Primitive[] }>>(new Map())

  // vyhledávání
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    if (ION_TOKEN) Cesium.Ion.defaultAccessToken = ION_TOKEN

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      timeline: false,
      animation: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
    })
    viewerRef.current = viewer

    // pořadí přidání = pořadí vykreslení zdola nahoru: podklady → katastr
    const orto = viewer.imageryLayers.addImageryProvider(ortofotoProvider())
    ortoRef.current = orto
    for (const t of ZTM_TIERS) {
      const layer = viewer.imageryLayers.addImageryProvider(ztmProvider(t.code))
      layer.show = false
      ztmRefs.current[t.code] = layer
    }
    const katastr = viewer.imageryLayers.addImageryProvider(katastrProvider())
    katastrRef.current = katastr

    // terén celé mapy = ČÚZK DMR 5G (ortofoto/ZTM se drapují na přesný terén)
    viewer.terrainProvider = makeDmrTerrain()

    // přepínání ZTM tieru podle výšky kamery
    viewer.camera.percentageChanged = 0.2
    const onCamChange = () => {
      const h = viewer.camera.positionCartographic?.height
      if (h != null) setZtmTier(pickZtmTier(h))
    }
    viewer.camera.changed.addEventListener(onCamChange)

    // glóbus (ČÚZK podklad) renderuje jen výřez ČR — mimo ni se nic nekreslí
    viewer.scene.globe.cartographicLimitRectangle = CR_EXTENT
    // model se schová za kopce a zapadne pod povrch (nebude prosvítat) — platí pro ČÚZK terén;
    // v Google 3D zaclonění dělají samotné dlaždice
    viewer.scene.globe.depthTestAgainstTerrain = true
    // měkké stíny jako vizuální vodítko, jestli model sedí na zemi (jemné, ne ostré)
    viewer.shadows = true
    viewer.shadowMap.softShadows = true
    viewer.shadowMap.size = 2048
    viewer.shadowMap.darkness = 0.55
    viewer.shadowMap.maximumDistance = 10_000

    viewer.camera.setView({ destination: LIBEREC_EXTENT })
    onCamChange()

    return () => {
      viewer.camera.changed.removeEventListener(onCamChange)
      viewerRef.current = null
      for (const e of modelsRef.current.values()) URL.revokeObjectURL(e.url)
      modelsRef.current.clear()
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  // líné vytvoření Google fotorealistických 3D dlaždic (přes ion token — vzhled Google Earth)
  async function ensureGoogle(viewer: Cesium.Viewer): Promise<Cesium.Cesium3DTileset | null> {
    if (googleRef.current) return googleRef.current
    const ts = await Cesium.Cesium3DTileset.fromIonAssetId(GOOGLE_3D_ION_ASSET)
    if (viewer.isDestroyed()) return null
    ts.enableCollision = true
    // zvednutí dlaždic o ~0,5 m podél „nahoru" (střed ČR), ať lícují s DMR terénem
    const c = Cesium.Cartesian3.fromDegrees(15.5, 49.8)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(c, new Cesium.Cartesian3())
    ts.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, GOOGLE_LIFT_M, new Cesium.Cartesian3()))
    viewer.scene.primitives.add(ts)
    googleRef.current = ts
    updateExcavation() // kdyby byl model naimportovaný dřív, než se Google načetl
    applySection()     // aplikuj řez na čerstvě načtené dlaždice
    return ts
  }

  // z dlaždic modelu vybere ty k vyhloubení: jen kde model dosahuje blízko k povrchu (zářez/na úrovni).
  // Kde je model hluboko pod terénem (pod kopcem) = tunel → nehloubit, terén zůstane. Výška terénu z DMR.
  async function excavationFromCells(cells: ExcavCell[]): Promise<Cesium.Cartesian3[][]> {
    if (!cells.length) return []
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const c of cells) { minLon = Math.min(minLon, c.lon); maxLon = Math.max(maxLon, c.lon); minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat) }
    const pad = 0.0005
    let terrain: (lon: number, lat: number) => number
    try {
      const sampler = await fetchElevSampler('dmr5g', minLon - pad, minLat - pad, maxLon + pad, maxLat + pad, 2048)
      terrain = (lon, lat) => { const e = sampler(lon, lat); return (e != null ? e : NaN) + GEOID_CZ }
    } catch { terrain = () => NaN } // DMR nedostupné → vyhloubit vše (NaN projde podmínkou níž)
    // vyber dlaždice k vyhloubení (u povrchu; tunely přeskoč)
    const keep: [number, number][][] = []
    for (const c of cells) {
      const t = terrain(c.lon, c.lat)
      const diff = t - c.topEll // kladné = vršek modelu je pod terénem
      if (!Number.isFinite(t) || diff < EXCAV_MAX_DEPTH_M) keep.push(c.squareLL)
    }
    if (!keep.length) return []
    // SPOJ dlaždice do pár polygonů (union) → místo stovek čtverců levný clipping
    let merged: [number, number][][][]
    try {
      const polys = keep.map(sq => [[...sq, sq[0]]] as [number, number][][]) // uzavřené ringy
      merged = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][]
    } catch (e) { console.error('Union výkopu selhal:', e); merged = keep.map(sq => [[...sq, sq[0]]]) }
    // z každého polygonu vezmi vnější obrys → clip polygon (díry zanedbáme, u trasy nevznikají)
    return merged.map(poly => poly[0].map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)))
  }

  // vyhloubí terén i Google dlaždice pod modely (clip polygon = půdorys) → zapuštěná část modelu je vidět.
  // Každý cíl (globe / Google) potřebuje vlastní instanci kolekce (nesdílet).
  function updateExcavation() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const rings = [...modelsRef.current.values()].flatMap(m => (m.excavate && m.footprint) ? m.footprint : [])
    const make = () => rings.length
      ? new Cesium.ClippingPolygonCollection({ polygons: rings.map(r => new Cesium.ClippingPolygon({ positions: r })) })
      : undefined
    v.scene.globe.clippingPolygons = make() as Cesium.ClippingPolygonCollection
    if (googleRef.current) googleRef.current.clippingPolygons = make() as Cesium.ClippingPolygonCollection
  }

  // přepínání podkladu: ČÚZK imagery (ortofoto/ZTM/katastr na glóbu) vs Google 3D dlaždice
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const google = base === 'google'

    if (ortoRef.current) ortoRef.current.show = !google && base === 'ortofoto'
    for (const t of ZTM_TIERS) {
      const layer = ztmRefs.current[t.code]
      if (layer) layer.show = !google && base === 'zm' && t.code === ztmTier
    }
    if (katastrRef.current) katastrRef.current.show = !google && katastrOn
    v.scene.globe.show = !google

    if (google) {
      setGoogleErr(null)
      setGoogleLoading(true)
      ensureGoogle(v)
        .then(ts => { if (ts) ts.show = true })
        .catch(() => setGoogleErr('Google 3D se nenačetlo — přidej asset „Google Photorealistic 3D Tiles" ve svém ion účtu (Asset Depot).'))
        .finally(() => setGoogleLoading(false))
    } else if (googleRef.current) {
      googleRef.current.show = false
    }
  }, [base, ztmTier, katastrOn])

  // řez terénem: svislá clipping rovina v místě vybraného modelu (jinak střed pohledu); odřízne terén i Google
  function applySection() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (!sectionOn) {
      v.scene.globe.clippingPlanes = undefined as unknown as Cesium.ClippingPlaneCollection
      if (googleRef.current) googleRef.current.clippingPlanes = undefined as unknown as Cesium.ClippingPlaneCollection
      return
    }
    const e = selectedId ? modelsRef.current.get(selectedId) : null
    let lon: number, lat: number, h: number
    if (e) { lon = e.placement.lon; lat = e.placement.lat; h = e.placement.groundH }
    else { const c = viewCenterGround(v); lon = c.lon; lat = c.lat; h = c.height }
    const originECEF = Cesium.Cartesian3.fromDegrees(lon, lat, h)
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(originECEF)
    const az = Cesium.Math.toRadians(sectionAz)
    const sign = sectionFlip ? -1 : 1
    const nx = sign * Math.cos(az), ny = sign * Math.sin(az)
    // vlastní instance kolekce i roviny pro každý cíl (nesdílet!)
    const mk = () => new Cesium.ClippingPlaneCollection({
      planes: [new Cesium.ClippingPlane(new Cesium.Cartesian3(nx, ny, 0), sectionOffset)],
      modelMatrix, edgeColor: MODEL_GLOW, edgeWidth: 1.0,
    })
    v.scene.globe.clippingPlanes = mk()
    if (googleRef.current) googleRef.current.clippingPlanes = mk()
  }
  useEffect(() => { applySection() }, [sectionOn, sectionAz, sectionOffset, sectionFlip, selectedId, base])

  // promítnutí stavu umístění do matice VYBRANÉHO modelu
  useEffect(() => {
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (e && placement) {
      e.placement = placement
      e.model.modelMatrix = buildMatrix(placement, e.center, e.yawDeg)
    }
  }, [placement])

  // režim přesunu: tažení vybraného modelu po mapě (kamera se při tahu vypne)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !moveMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let dragging = false
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
      const picked = v.scene.pick(evt.position)
      if (picked && e && picked.primitive === e.model) {
        dragging = true
        v.scene.screenSpaceCameraController.enableInputs = false
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragging) return
      const g = pickTerrain(v, evt.endPosition)
      if (g) setPlacement(p => p ? { ...p, lon: g.lon, lat: g.lat, groundH: g.height } : p)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const end = () => { if (dragging) { dragging = false; v.scene.screenSpaceCameraController.enableInputs = true } }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    return () => { handler.destroy(); if (!v.isDestroyed()) v.scene.screenSpaceCameraController.enableInputs = true }
  }, [moveMode])

  // režim výběru parcely: klik → načti obrys z katastru a vykresli polygon
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !parcelMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction(async (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      setParcelLoading(true)
      const parcel = await fetchParcelAt(g.lon, g.lat)
      setParcelLoading(false)
      if (parcel) toggleParcelSel(parcel)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [parcelMode])

  // režim výběru oblasti: každý klik přidá vrchol; polygon se dokreslí a po potvrzení vybere parcely uvnitř
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !areaMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      const pos = Cesium.Cartesian3.fromDegrees(g.lon, g.lat)
      areaPtsRef.current.push(pos)
      // bod — přichycený k terénu (jinak by seděl na elipsoidu = výšce 0 a při šikmém pohledu se promítl jinam)
      areaEntsRef.current.push(v.entities.add({
        position: pos,
        point: { pixelSize: 9, color: Cesium.Color.ORANGE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }))
      // výplň polygonu (od 3 bodů) — CallbackProperty ať se překresluje
      if (areaPtsRef.current.length === 3) {
        areaEntsRef.current.push(v.entities.add({
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(areaPtsRef.current), false),
            material: Cesium.Color.ORANGE.withAlpha(0.15),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          polyline: {
            positions: new Cesium.CallbackProperty(() => [...areaPtsRef.current, areaPtsRef.current[0]], false),
            width: 2, material: Cesium.Color.ORANGE, clampToGround: true,
          },
        }))
      }
      setAreaPtCount(areaPtsRef.current.length)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [areaMode])

  function clearArea() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) areaEntsRef.current.forEach(e => v.entities.remove(e))
    areaEntsRef.current = []
    areaPtsRef.current = []
    setAreaPtCount(0)
  }

  // potvrdí oblast: stáhne parcely v bboxu a vybere ty, jejichž těžiště leží uvnitř nakresleného polygonu
  async function finalizeArea() {
    const pts = areaPtsRef.current
    if (pts.length < 3) return
    const poly = pts.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
    const lons = poly.map(p => p[0]); const lats = poly.map(p => p[1])
    const minLon = Math.min(...lons), maxLon = Math.max(...lons)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    setAreaLoading(true)
    try {
      const parcels = await fetchParcelsInBbox(minLon, minLat, maxLon, maxLat)
      for (const parcel of parcels) {
        // těžiště počítáme v S-JTSK a reprojektujeme jen ten jeden bod (levné)
        const [cx, cy] = ringCentroid(parcel.ring)
        const [clon, clat] = proj4('EPSG:5514', 'EPSG:4326', [cx, cy]) as [number, number]
        if (!pointInRing(clon, clat, poly)) continue
        // vybraná parcela → teprve teď reprojektuj celou geometrii
        const positions = parcel.ring.map(([x, y]) => {
          const [lo, la] = proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]
          return Cesium.Cartesian3.fromDegrees(lo, la)
        })
        addParcelSel({ id: parcel.id, positions })
      }
    } finally {
      setAreaLoading(false)
      clearArea()
      setAreaMode(false)
    }
  }

  function toggleAreaMode() {
    if (areaMode) { clearArea(); setAreaMode(false); return }
    setMoveMode(false); setParcelMode(false); setTileMode(false)
    setAreaMode(true)
  }

  // ── výběr dlaždic: klik přepne jednu, tažení „maluje" přes víc ──
  // Směr celého tahu určí první dlaždice (na vybranou = odebírám, na prázdnou = přidávám),
  // takže stejným gestem jde i mazat. Kamera se při tahu vypne, jinak by mapa ujížděla.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !tileMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let painting = false
    let adding = true
    const stroke = new Set<string>()  // co už tenhle tah řešil — ať to netluče sem a tam
    let lastPx: Cesium.Cartesian2 | null = null

    // Levé tlačítko si bere malování, jenže tím Cesiu bereme otáčení mapy — bez tohohle by
    // v režimu dlaždic nešlo popojet. Posun tedy na pravé, zoom zůstává kolečku.
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes
    const prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]

    const paintAt = (screen: Cesium.Cartesian2) => {
      // pickTerrain (ray na globus) je proti pickGround levnější — nedělá readback hloubky,
      // což se při desítkách MOUSE_MOVE za sekundu pozná
      const g = pickTerrain(v, screen)
      if (!g) return
      const tile = tileAt(g.lon, g.lat, tileSize)
      const key = tileKey(tile)
      if (stroke.has(key)) return
      stroke.add(key)
      setTileSelected(tile, adding)
    }

    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickTerrain(v, evt.position)
      if (!g) return
      adding = !tilesRef.current.has(tileKey(tileAt(g.lon, g.lat, tileSize)))
      painting = true
      stroke.clear()
      lastPx = evt.position.clone()
      v.scene.screenSpaceCameraController.enableInputs = false
      paintAt(evt.position)
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!painting) return
      // pick až po pár pixelech pohybu; jinak zbytečně pickujeme několikrát v téže dlaždici
      if (lastPx && Cesium.Cartesian2.distance(lastPx, evt.endPosition) < 4) return
      lastPx = evt.endPosition.clone()
      paintAt(evt.endPosition)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    const end = () => {
      if (!painting) return
      painting = false
      stroke.clear()
      lastPx = null
      cam.enableInputs = true
    }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    // Pojistka: když pustíš tlačítko mimo canvas, Cesium LEFT_UP nedostane a zůstalo by
    // zapnuté malování i vypnutá kamera. end() je idempotentní, takže to nic nerozbije.
    window.addEventListener('pointerup', end)

    return () => {
      handler.destroy()
      window.removeEventListener('pointerup', end)
      if (v.isDestroyed()) return
      cam.enableInputs = true
      cam.rotateEventTypes = prevRotate
      cam.zoomEventTypes = prevZoom
    }
  }, [tileMode, tileSize])

  /** Zapne/vypne dlaždici. Idempotentní — malování tahem po ní jezdí opakovaně. */
  function setTileSelected(tile: Tile, on: boolean) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const key = tileKey(tile)
    const hit = tilesRef.current.get(key)
    if (on === (hit !== undefined)) return
    if (hit) {
      v.entities.remove(hit.ent)
      tilesRef.current.delete(key)
    } else {
      const positions = Cesium.Cartesian3.fromDegreesArray(tileRingLL(tile))
      const ent = v.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: MODEL_GLOW.withAlpha(0.12),
          classificationType: Cesium.ClassificationType.BOTH,
        },
        polyline: {
          positions: [...positions, positions[0]],
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({ color: MODEL_GLOW, glowPower: 0.25 }),
          clampToGround: true,
        },
      })
      tilesRef.current.set(key, { tile, ent })
    }
    setTileCount(tilesRef.current.size)
  }

  function clearTiles() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) for (const t of tilesRef.current.values()) v.entities.remove(t.ent)
    tilesRef.current.clear()
    setTileCount(0)
  }

  function toggleTileMode() {
    if (tileMode) { setTileMode(false); return }
    setMoveMode(false); setParcelMode(false)
    if (areaMode) { clearArea(); setAreaMode(false) }
    setTileMode(true)
  }

  // jiná velikost = jiná mřížka; míchat čtverce dvou velikostí by dělalo překryvy
  function changeTileSize(s: TileSize) {
    if (s === tileSize) return
    clearTiles()
    setTileSize(s)
  }

  /**
   * Vyveze vybrané dlaždice jako zip: teren.obj + teren.mtl + JPEG na dlaždici.
   * Každá dlaždice = vlastní objekt s vlastním materiálem, souřadnice v rovině S-JTSK
   * mínus zadaný posun (viz buildTileObj). 3ds Max importuje OBJ nativně i s texturami.
   */
  async function exportTilesObj() {
    const tiles = [...tilesRef.current.values()].map(t => t.tile)
    if (!tiles.length || tileBusy) return
    setTileBusy(true)
    setTileProgress(`0/${tiles.length}`)
    try {
      let done = 0
      const fetched = await pool(tiles, 3, async tile => {
        const [grid, jpg] = await Promise.all([fetchTileHeights(tile, meshStep), fetchTileOrtho(tile, texSize)])
        setTileProgress(`${++done}/${tiles.length}`)
        return { tile, grid, jpg }
      })
      setTileProgress('skládám…')
      await new Promise(r => setTimeout(r, 30)) // ať se stihne překreslit UI před blokující prací

      const fallbackH = medianHeight(fetched.map(f => f.grid))
      const { minX, minY, maxX, maxY } = tilesBounds(tiles)
      // Žádný posun: vrcholy jdou ven v reálných S-JTSK souřadnicích, ať sedí na ostatní data v Maxu.
      const off: Offset = { x: 0, y: 0, z: 0 }

      // Zip se skládá STREAMOVANĚ, po dlaždicích. Celý OBJ jako jeden řetězec nejde: u ~50 dlaždic
      // přeteče strop V8 na délku stringu (~512 MB) a join spadne na „Invalid string length".
      // Takhle se v paměti nikdy nedrží víc než jedna dlaždice + zkomprimovaný výstup.
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
        objF.push(strToU8(buildTileObj(f.tile, f.grid, off, fallbackH, vBase) + '\n'), false)
        vBase += f.grid.n * f.grid.n
        check()
        if (++built % 5 === 0 || built === fetched.length) {
          setTileProgress(`skládám ${built}/${fetched.length}`)
          await new Promise(r => setTimeout(r, 0)) // pustit UI k slovu
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
      addText('teren.mtl', buildMtl(tiles))
      addText('vray_material.ms', buildMaxScript(tiles))
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
        `Dlaždic: ${tiles.length} × ${tileSize} m`,
        `Mřížka terénu: ${stepOf(tiles[0], fetched[0].grid.n).toFixed(3)} m (zdrojový DMR 5G má body po ~2,8 m)`,
        `Textura: ${texSize} px na dlaždici = ${(tileSize / texSize * 100).toFixed(1)} cm/px (ortofoto ČÚZK má nativně 20 cm/px)`,
        'Y je mřížkový sever Křováku, ne pravý sever (meridiánová konvergence ~7°).',
        '',
        `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
      ].join('\n'))

      zip.end()
      check()
      download(concatBytes(chunks), `teren_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
      toast.success(`Vyvezeno ${tiles.length}× dlaždice ${tileSize} m s ortofotem`)
    } catch (e) {
      console.error('Export dlaždic selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export dlaždic selhal')
    } finally {
      setTileBusy(false)
      setTileProgress('')
    }
  }

  // městské části Liberce (k.ú.) jako „polární záře" stoupající od terénu, každá vlastní barva; zap/vyp
  async function toggleDistricts() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (districtsOn) {
      for (const d of districtsRef.current.values()) {
        d.ents.forEach(e => v.entities.remove(e))
        d.prims.forEach(p => v.scene.primitives.remove(p))
      }
      districtsRef.current.clear()
      setSelectedDistrict(null)
      setDistrictsOn(false)
      return
    }
    setDistrictsLoading(true)
    try {
      const list = await fetchLiberecDistricts()
      if (v.isDestroyed()) return
      // výšky terénu z jednoho DMR snímku přes celý Liberec (1 request pro všechny části)
      let ground: (lon: number, lat: number) => number
      try {
        const sampler = await fetchElevSampler('dmr5g', 14.94, 50.68, 15.15, 50.83, 2048)
        ground = (lon, lat) => { const e = sampler(lon, lat); return (e != null ? e : 350) + GEOID_CZ }
      } catch { ground = () => 350 + GEOID_CZ } // fallback: cca výška Liberce
      if (v.isDestroyed()) return

      const COS = Math.cos(50.77 * Math.PI / 180)
      list.forEach((d, i) => {
        const color = Cesium.Color.fromHsl(i / list.length, 0.85, 0.55) // vlastní barva pro každou část
        const phase = i * 0.9
        const ents: Cesium.Entity[] = []
        const prims: Cesium.Primitive[] = []
        for (const ring of d.rings) {
          const lonlat = ring.map(c => { const cc = Cesium.Cartographic.fromCartesian(c); return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)] as [number, number] })
          // decimace obrysu na ~70 m, pak Catmull-Rom spline → plynulá „splinová" stěna bez tvrdých rohů
          const dec: [number, number][] = []
          let last: [number, number] | null = null
          for (const p of lonlat) {
            if (!last) { dec.push(p); last = p; continue }
            if (Math.hypot((p[0] - last[0]) * 111320 * COS, (p[1] - last[1]) * 111320) >= 70) { dec.push(p); last = p }
          }
          if (dec.length < 3) continue
          const smooth = smoothClosedRing(dec, 10)
          const closed = [...smooth, smooth[0]]
          const baseH = closed.map(([lo, la]) => ground(lo, la))
          const positions = closed.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
          // stěna „polární záře" jako primitiv se shaderovým materiálem (vlnění + fade, GPU)
          const geom = new Cesium.WallGeometry({
            positions,
            minimumHeights: baseH.map(h => h - AURORA_SINK_M), // zapuštěno pod terén, ať nikde nefloatuje
            maximumHeights: baseH.map(h => h + AURORA_HEIGHT_M),
            vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          })
          const prim = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry: geom }),
            appearance: new Cesium.MaterialAppearance({ material: auroraMaterial(color, phase), translucent: true, flat: true, faceForward: false }),
            asynchronous: false,
          })
          v.scene.primitives.add(prim)
          prims.push(prim)
          // tenká ostrá linka na terénu pro definici hranice (plná detailní geometrie)
          ents.push(v.entities.add({
            polyline: { positions: [...ring, ring[0]], width: 2.5, clampToGround: true, material: color },
          }))
          // jemná výplň (kvůli kliknutí + lehkému zabarvení plochy)
          ents.push(v.entities.add({
            polygon: { hierarchy: new Cesium.PolygonHierarchy(ring), material: color.withAlpha(0.05), classificationType: Cesium.ClassificationType.BOTH },
          }))
        }
        // popisek letí ve vzduchu nad září (nad terénem, ne na výšce 0)
        const big = d.rings.reduce((a, b) => (b.length > a.length ? b : a))
        const bigLL = big.map(c => Cesium.Cartographic.fromCartesian(c))
        const clon = Cesium.Math.toDegrees(bigLL.reduce((s, c) => s + c.longitude, 0) / bigLL.length)
        const clat = Cesium.Math.toDegrees(bigLL.reduce((s, c) => s + c.latitude, 0) / bigLL.length)
        const labelPos = Cesium.Cartesian3.fromDegrees(clon, clat, ground(clon, clat) + AURORA_HEIGHT_M + AURORA_LABEL_LIFT_M)
        ents.push(v.entities.add({
          position: labelPos,
          label: {
            text: d.name, font: 'bold 13px sans-serif', fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(3000, 1.15, 80000, 0.4),
            translucencyByDistance: new Cesium.NearFarScalar(70000, 1.0, 130000, 0.0),
          },
          point: { pixelSize: 5, color, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        }))
        for (const e of ents) (e as unknown as { __district: string }).__district = d.code
        districtsRef.current.set(d.code, { name: d.name, color, rings: d.rings, ents, prims })
      })
      setDistrictsOn(true)
    } finally { setDistrictsLoading(false) }
  }

  // zvýrazní vybranou městskou část (silnější výplň) + přiletí na ni kamerou
  function selectDistrict(code: string) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setSelectedDistrict(code)
    for (const [c, d] of districtsRef.current) {
      const alpha = c === code ? 0.22 : 0.05
      for (const e of d.ents) if (e.polygon) e.polygon.material = new Cesium.ColorMaterialProperty(d.color.withAlpha(alpha))
    }
    const d = districtsRef.current.get(code)
    if (d) v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(d.rings.flat()), { duration: 1.0 })
  }

  // klik na městskou část ji vybere (jen když je vrstva zapnutá a nejsme v jiném klikacím režimu)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !districtsOn || parcelMode || areaMode || moveMode || tileMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = v.scene.pick(evt.position) as { id?: { __district?: string } } | undefined
      const code = picked?.id?.__district
      if (code) selectDistrict(code)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [districtsOn, parcelMode, areaMode, moveMode, tileMode])

  // klik na parcelu ji přidá do výběru; klik na už vybranou ji odebere (multi)
  function toggleParcelSel(parcel: Parcel) {
    const pid = parcel.id || `p${Math.round(parcel.positions[0].x)}_${Math.round(parcel.positions[0].y)}`
    if (parcelsRef.current.has(pid)) { removeParcel(pid); return }
    addParcelSel(parcel)
  }

  // přidá parcelu do výběru (bez toggle) — sdílené klikem i výběrem oblasti
  function addParcelSel(parcel: Parcel) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const pid = parcel.id || `p${Math.round(parcel.positions[0].x)}_${Math.round(parcel.positions[0].y)}`
    if (parcelsRef.current.has(pid)) return
    const ring = parcel.positions.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
    const fill = v.entities.add({
      polygon: { hierarchy: new Cesium.PolygonHierarchy(parcel.positions), material: Cesium.Color.CYAN.withAlpha(0.25), classificationType: Cesium.ClassificationType.BOTH },
    })
    const border = v.entities.add({
      polyline: { positions: [...parcel.positions, parcel.positions[0]], width: 3, material: Cesium.Color.CYAN, clampToGround: true },
    })
    parcelsRef.current.set(pid, { positions: parcel.positions, ring, ents: [fill, border] })
    upsertObj({ id: `parcel-${pid}`, kind: 'parcel', name: `Parcela ${parcel.id || ''}`.trim(), visible: true })
    setParcelCount(parcelsRef.current.size)
  }

  function removeParcel(pid: string) {
    const v = viewerRef.current
    const p = parcelsRef.current.get(pid)
    if (p && v && !v.isDestroyed()) p.ents.forEach(e => v.entities.remove(e))
    parcelsRef.current.delete(pid)
    removeObj(`parcel-${pid}`)
    // detailní terén je union přes všechny parcely → jakákoli změna výběru ho zneplatní
    if (patchesRef.current.size) removeAllPatches()
    setParcelCount(parcelsRef.current.size)
  }

  function clearAllParcels() {
    for (const pid of [...parcelsRef.current.keys()]) removeParcel(pid)
  }

  function removePatch(pid: string) {
    const v = viewerRef.current
    const pt = patchesRef.current.get(pid)
    if (pt && v && !v.isDestroyed()) v.scene.primitives.remove(pt.prim)
    patchesRef.current.delete(pid)
    removeObj(`dmr-${pid}`)
    setPatchCount(patchesRef.current.size)
  }

  function removeAllPatches() {
    for (const pid of [...patchesRef.current.keys()]) removePatch(pid)
  }


  // sesbírá všechny hotové výseky (multi-parcela)
  function collectPatches(): DmrData[] {
    return [...patchesRef.current.values()].map(p => p.data)
  }

  // export všech výseků (+ OSM budovy) — terén a budovy jako ODDĚLENÉ objekty; reimport na stejné místo
  async function exportDmrGlb() {
    const patches = collectPatches()
    if (!patches.length || exporting) { return }
    setExporting(true)
    try {
      const { terrain, buildings, anchor } = await buildExportScene(patches, true)
      const scene = new THREE.Scene()
      const tm = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ color: 0xb8a888, side: THREE.DoubleSide, roughness: 1 })); tm.name = 'teren'; scene.add(tm)
      if (buildings) { const bm = new THREE.Mesh(buildings, new THREE.MeshStandardMaterial({ color: 0xd0d0d0 })); bm.name = 'budovy'; scene.add(bm) }
      scene.userData = { geoAnchor: anchor }
      await new Promise<void>((resolve) => {
        new GLTFExporter().parse(
          scene,
          res => { download(res as ArrayBuffer, anchorFilename(anchor, 'glb'), 'model/gltf-binary'); resolve() },
          err => { console.error('GLTF export selhal', err); resolve() },
          { binary: true },
        )
      })
    } catch (e) {
      console.error('Export glb selhal:', e)
    } finally {
      setExporting(false)
    }
  }

  async function exportDmrObj() {
    const patches = collectPatches()
    if (!patches.length || exporting) { return }
    setExporting(true)
    try {
      const { terrain, buildings, anchor } = await buildExportScene(patches, true)
      terrain.rotateX(Math.PI / 2) // gltf Y-up → Z-up (3ds Max), ať model přijde upright
      if (buildings) buildings.rotateX(Math.PI / 2)
      const scene = new THREE.Scene()
      const tm = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ color: 0xb8a888 })); tm.name = 'teren'; scene.add(tm)
      if (buildings) { const bm = new THREE.Mesh(buildings, new THREE.MeshStandardMaterial({ color: 0xd0d0d0 })); bm.name = 'budovy'; scene.add(bm) }
      download(new OBJExporter().parse(scene), anchorFilename(anchor, 'obj'), 'text/plain')
    } catch (e) {
      console.error('Export obj selhal:', e)
    } finally {
      setExporting(false)
    }
  }

  // export hranic vybraných parcel jako uzavřené 3D křivky (DXF pro 3ds Max), drapované na DMR.
  // Použije stejnou kotvu jako terén (pokud je postaven) → DXF lícuje s glb/obj exportem.
  async function exportParcelsDxf() {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || parcelsRef.current.size === 0 || exporting) return
    setExporting(true)
    try {
      // kotva: shodná s terénem, ať křivky sedí; jinak dopočítat ze středu bboxu parcel
      let anchor = collectPatches()[0]?.anchor
      if (!anchor) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
        for (const p of parcelsRef.current.values())
          for (const [lo, la] of p.ring) { minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la) }
        const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2
        const cc = [Cesium.Cartographic.fromDegrees(midLon, midLat)]
        await Cesium.sampleTerrain(v.terrainProvider, 18, cc)
        anchor = { lon: midLon, lat: midLat, h: Number.isFinite(cc[0].height) ? cc[0].height : 0 }
      }
      const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
      const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
      const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3()
      const toLocalENU = (x: number, y: number, z: number): [number, number, number] => { s.x = x; s.y = y; s.z = z; Cesium.Matrix4.multiplyByPoint(inv, s, o); return [o.x, o.y, o.z] } // east, north, up

      const LIFT = 0.1
      const polylines: [number, number, number][][] = []
      for (const p of parcelsRef.current.values()) {
        const ring = p.ring.slice()
        if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) ring.pop() }
        if (ring.length < 3) continue
        const cartos = ring.map(([lo, la]) => Cesium.Cartographic.fromDegrees(lo, la))
        await Cesium.sampleTerrain(v.terrainProvider, 18, cartos)
        if (v.isDestroyed()) return
        const pts: [number, number, number][] = []
        for (let i = 0; i < ring.length; i++) {
          const h = (Number.isFinite(cartos[i].height) ? (cartos[i].height as number) : anchor.h) + LIFT
          const P = Cesium.Cartesian3.fromDegrees(ring[i][0], ring[i][1], h)
          pts.push(toLocalENU(P.x, P.y, P.z))
        }
        polylines.push(pts)
      }
      if (!polylines.length) return
      download(buildDxf(polylines), anchorFilename(anchor, 'dxf'), 'application/dxf')
    } catch (e) {
      console.error('Export DXF hranic selhal:', e)
    } finally {
      setExporting(false)
    }
  }

  // spočítá triangulovaný DMR mesh pro polygon (vnější obrys + díry), ořezaný přesně hranicí.
  // outer/holes ve WGS84 [lon,lat]. Vrací data pro export; Cesium primitiv se vyrábí zvlášť.
  async function computePatchData(outer: number[][], holes: number[][][]): Promise<DmrData | null> {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || outer.length < 3) return null

    // odstraň duplicitní uzavírací bod ringu
    const cleanRing = (r: number[][]) => {
      const c = r.slice()
      if (c.length > 1) { const a0 = c[0], aN = c[c.length - 1]; if (Math.abs(a0[0] - aN[0]) < 1e-9 && Math.abs(a0[1] - aN[1]) < 1e-9) c.pop() }
      return c
    }
    const clean = cleanRing(outer)
    const cleanHoles = holes.map(cleanRing).filter(h => h.length >= 3)
    if (clean.length < 3) return null

    // bbox z vnějšího obrysu
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const [lon, lat] of clean) { minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat) }
    const midLat = (minLat + maxLat) / 2, midLon = (minLon + maxLon) / 2
    const wM = (maxLon - minLon) * 111320 * Math.cos(midLat * Math.PI / 180)
    const hM = (maxLat - minLat) * 111320
    const cosLat = Math.cos(midLat * Math.PI / 180)
    const toLocal = (lon: number, lat: number): [number, number] => [(lon - midLon) * 111320 * cosLat, (lat - midLat) * 111320]

    // rozteč ~ tak, aby bylo max ~100 bodů na delší stranu (vzorkování výšky je per-bod)
    const spacingM = Math.max(3, Math.max(wM, hM) / 100)

    // body + constrained hrany: vnější obrys i každá díra jako zhuštěná uzavřená smyčka
    const ll: number[][] = []
    const edges: number[][] = []
    const addLoop = (r: number[][]) => {
      const start = ll.length
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length]
        const [ax, ay] = toLocal(a[0], a[1]), [bx, by] = toLocal(b[0], b[1])
        const nseg = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacingM))
        for (let k = 0; k < nseg; k++) { const t = k / nseg; ll.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
      }
      const end = ll.length
      for (let i = start; i < end; i++) edges.push([i, i + 1 < end ? i + 1 : start])
    }
    addLoop(clean)
    for (const h of cleanHoles) addLoop(h)

    // vnitřní body na mřížce: uvnitř obrysu a mimo díry
    const stepLon = spacingM / (111320 * cosLat)
    const stepLat = spacingM / 111320
    for (let lat = minLat + stepLat * 0.5; lat < maxLat; lat += stepLat)
      for (let lon = minLon + stepLon * 0.5; lon < maxLon; lon += stepLon)
        if (pointInRing(lon, lat, clean) && !cleanHoles.some(h => pointInRing(lon, lat, h))) ll.push([lon, lat])

    // VÝŠKY z DMR jedním exportImage přes celý bbox výseku (ne per-bod přes terén provider —
    // u velké plochy by to vystřelilo tisíce fetchů = ERR_INSUFFICIENT_RESOURCES). +GEOID → elipsoidální.
    const maxSpanM = Math.max(wM, hM)
    const size = Math.min(2048, Math.max(256, Math.ceil(maxSpanM / 5))) // ~DMR 5G rozlišení, cap 2048
    const sampler = await fetchElevSampler('dmr5g', minLon, minLat, maxLon, maxLat, size)
    if (v.isDestroyed()) return null
    const heights = ll.map(([lon, lat]) => { const e = sampler(lon, lat); return e != null ? e + GEOID_CZ : NaN })
    const validH = heights.filter(h => Number.isFinite(h)) as number[]
    if (!validH.length) return null
    const fallback = validH.slice().sort((a, b) => a - b)[Math.floor(validH.length / 2)]

    const tris = cdt2d(ll.map(([lon, lat]) => toLocal(lon, lat)), edges, { exterior: false })
    if (!tris.length) return null

    const LIFT = 0.1 // nepatrné nadzvednutí, ať to nebliká z-fightingem s terénem
    const positions: number[] = []
    for (let i = 0; i < ll.length; i++) {
      const hh = Number.isFinite(heights[i]) ? (heights[i] as number) : fallback
      const p = Cesium.Cartesian3.fromDegrees(ll[i][0], ll[i][1], hh + LIFT)
      positions.push(p.x, p.y, p.z)
    }
    // ponech jen trojúhelníky, jejichž těžiště leží uvnitř obrysu a mimo díry
    // (robustní pro konkávní union i díry – nezávisí na chování cdt2d flagů)
    const indices: number[] = []
    for (const t of tris) {
      const cxLon = (ll[t[0]][0] + ll[t[1]][0] + ll[t[2]][0]) / 3
      const cyLat = (ll[t[0]][1] + ll[t[1]][1] + ll[t[2]][1]) / 3
      if (!pointInRing(cxLon, cyLat, clean)) continue
      if (cleanHoles.some(h => pointInRing(cxLon, cyLat, h))) continue
      indices.push(t[0], t[1], t[2])
    }
    if (!indices.length) return null

    return { positions, indices, anchor: { lon: midLon, lat: midLat, h: fallback }, ring: clean, holes: cleanHoles.length ? cleanHoles : undefined }
  }

  function makePatchPrimitive(data: DmrData): Cesium.Primitive {
    const nv = data.positions.length / 3
    const geom = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: new Float64Array(data.positions),
        }),
      } as unknown as Cesium.GeometryAttributes,
      indices: nv < 65536 ? new Uint16Array(data.indices) : new Uint32Array(data.indices),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(data.positions),
    })
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: geom,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString('#c9b58a')) },
      }),
      // plochý neosvětlený materiál: bez stínů/normál → žádná černá odvrácená strana
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
    })
  }

  // sjednotí všechny vybrané parcely do JEDNÉ hranice (union) a postaví jeden detailní terén
  // ořezaný spojenou hranicí (nesouvislé skupiny → víc výseků). Rychlejší i bez švů mezi parcelami.
  async function buildDmrPatches() {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || dmrLoading || parcelsRef.current.size === 0) return
    setDmrLoading(true)
    try {
      // parcely jako uzavřené polygony pro union
      const polys = [...parcelsRef.current.values()].map(p => {
        const r = p.ring.map(([lo, la]) => [lo, la] as [number, number])
        if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
        return [r] as [number, number][][]
      })
      let merged: [number, number][][][]
      try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] }
      catch (e) { console.error('Union parcel selhal, padám na jednotlivé:', e); merged = polys }

      // přestav všechny výseky podle aktuálního unionu
      removeAllPatches()
      let i = 0
      for (const poly of merged) {
        const outer = poly[0].map(([lo, la]) => [lo, la] as number[])
        const holes = poly.slice(1).map(h => h.map(([lo, la]) => [lo, la] as number[]))
        const data = await computePatchData(outer, holes)
        if (!data || v.isDestroyed()) continue
        const prim = makePatchPrimitive(data)
        v.scene.primitives.add(prim)
        const pid = `union-${i++}`
        patchesRef.current.set(pid, { data, prim })
        upsertObj({ id: `dmr-${pid}`, kind: 'dmr', name: 'Detailní terén', visible: true })
      }
      setPatchCount(patchesRef.current.size)
    } finally { setDmrLoading(false) }
  }

  // OSM budovy (Cesium ion) — líné vytvoření + zap/vyp
  async function ensureOsm(viewer: Cesium.Viewer): Promise<Cesium.Cesium3DTileset | null> {
    if (osmRef.current) return osmRef.current
    const ts = await Cesium.createOsmBuildingsAsync()
    if (viewer.isDestroyed()) return null
    viewer.scene.primitives.add(ts)
    osmRef.current = ts
    return ts
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (osmOn) {
      setOsmLoading(true)
      ensureOsm(v).then(ts => {
        if (!ts) return
        // výškový posun podél „nahoru" (střed ČR) — aplikuje se při každém zapnutí (i po HMR)
        const c = Cesium.Cartesian3.fromDegrees(15.5, 49.8)
        const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(c, new Cesium.Cartesian3())
        ts.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, OSM_LIFT_M, new Cesium.Cartesian3()))
        ts.show = true
      }).catch(() => { /* ion */ }).finally(() => setOsmLoading(false))
    } else if (osmRef.current) {
      osmRef.current.show = false
    }
  }, [osmOn])

  function toggleMove() { setMoveMode(m => { const nv = !m; if (nv) { setParcelMode(false); setTileMode(false); if (areaMode) { clearArea(); setAreaMode(false) } } return nv }) }
  function toggleParcel() { setParcelMode(m => { const nv = !m; if (nv) { setMoveMode(false); setTileMode(false); if (areaMode) { clearArea(); setAreaMode(false) } } return nv }) }

  async function importModel(file: File) {
    if (!/\.(glb|gltf|obj)$/i.test(file.name)) return
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return

    const isGlb = /\.(glb|gltf)$/i.test(file.name)
    // glb URL pro Cesium (OBJ převedeme přes three) + promise na nejnižší bod + případná geo-kotva
    let url: string
    let bottomPromise: Promise<number | null>
    let anchor = parseAnchor(file.name) // kotva z názvu (geo_lon_lat_h.*) → reimport našeho exportu
    let excavCells: ExcavCell[] | undefined // dlaždice pro (volitelný) výkop — počítá se až při zapnutí
    if (/\.obj$/i.test(file.name)) {
      try {
        const group = new OBJLoader().parse(await file.text())
        group.traverse(o => {
          const m = o as THREE.Mesh
          if (m.isMesh && m.geometry) { m.geometry.rotateX(-Math.PI / 2); m.geometry.rotateY(-Math.PI / 2) }
        })
        const box = new THREE.Box3().setFromObject(group)
        bottomPromise = Promise.resolve(Number.isFinite(box.min.y) ? box.min.y : null)
        const glbBuf = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(group, r => res(r as ArrayBuffer), rej, { binary: true }))
        url = URL.createObjectURL(new Blob([glbBuf], { type: 'model/gltf-binary' }))
      } catch (e) { console.error('Import OBJ selhal:', e); return }
    } else {
      // glb bez kotvy v názvu: zkus rozpoznat reálné S-JTSK souřadnice v geometrii a usadit přesně
      const geo = !anchor ? await georeferenceSjtskGlb(file).catch(e => { console.error('Georeference selhala:', e); return null }) : null
      if (geo) {
        url = geo.url
        bottomPromise = Promise.resolve(geo.bottomZ)
        anchor = geo.anchor
        excavCells = geo.cells
        toast.success('Model usazen podle S-JTSK souřadnic z geometrie')
      } else {
        url = URL.createObjectURL(file)
        bottomPromise = computeBottomZ(file)
      }
    }

    let base: Anchor
    if (anchor) base = anchor
    else { const c = viewCenterGround(v); base = { lon: c.lon, lat: c.lat, h: c.height } }
    const p: Placement = { lon: base.lon, lat: base.lat, groundH: base.h, heightOffset: 0, heading: 0, pitch: 0, roll: 0, scale: 1 }
    // glb (náš export i georeferencovaný) je otočený o 90° kolem svislé osy → kompenzace přes matici
    const yawDeg = (anchor && isGlb) ? MAX_GLB_YAW_DEG : 0
    if (anchor && parseAnchor(file.name)) toast.success('Model usazen přesně podle geo-kotvy z názvu')
    else if (!anchor) toast.message('Soubor bez souřadnic — umístěno do středu, dolaď ručně')

    try {
      const model = await Cesium.Model.fromGltfAsync({
        url,
        modelMatrix: buildMatrix(p, Cesium.Cartesian3.ZERO, yawDeg),
        shadows: Cesium.ShadowMode.ENABLED,
      })
      if (v.isDestroyed()) { URL.revokeObjectURL(url); return }
      v.scene.primitives.add(model)
      model.environmentMapManager.enabled = true
      model.environmentMapManager.atmosphereScatteringIntensity = 4.0
      model.environmentMapManager.brightness = 1.3
      // svítící obrys (glow) kolem modelu
      model.silhouetteColor = MODEL_GLOW
      model.silhouetteSize = 2.0

      const id = crypto.randomUUID()
      const entry: ModelEntry = {
        id, name: file.name.replace(/\.(glb|gltf|obj)$/i, ''),
        model, url, center: Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO), yawDeg, placement: p, visible: true,
        excavCells, footprint: undefined, excavate: false,
      }
      modelsRef.current.set(id, entry)
      setObjects(list => [...list, { id, kind: 'model', name: entry.name, visible: true }])
      selectObject(id)

      model.readyEvent.addEventListener(async () => {
        if (v.isDestroyed()) return
        if (!anchor) {
          const inv = Cesium.Matrix4.inverse(model.modelMatrix, new Cesium.Matrix4())
          const localCenter = Cesium.Matrix4.multiplyByPoint(inv, model.boundingSphere.center, new Cesium.Cartesian3())
          const bottomZ = await bottomPromise
          entry.center = new Cesium.Cartesian3(localCenter.x, localCenter.y, bottomZ ?? 0)
          model.modelMatrix = buildMatrix(entry.placement, entry.center, entry.yawDeg)
        }
        v.camera.flyToBoundingSphere(model.boundingSphere, { duration: 1.0 })
      })
    } catch {
      URL.revokeObjectURL(url)
      toast.error('Import modelu selhal')
    }
  }

  // ── správa scény ──
  function upsertObj(o: SceneObj) { setObjects(list => [...list.filter(x => x.id !== o.id), o]) }
  function removeObj(id: string) { setObjects(list => list.filter(x => x.id !== id)) }

  function selectObject(id: string | null) {
    selectedIdRef.current = id
    setSelectedId(id)
    const e = id ? modelsRef.current.get(id) : null
    setPlacement(e ? { ...e.placement } : null)
    setMoveMode(false)
  }

  function deleteModel(id: string) {
    const v = viewerRef.current
    const e = modelsRef.current.get(id)
    if (!e) return
    if (v && !v.isDestroyed()) v.scene.primitives.remove(e.model)
    URL.revokeObjectURL(e.url)
    modelsRef.current.delete(id)
    if (e.footprint) updateExcavation() // uklidit výkop po smazaném modelu
    setObjects(list => list.filter(o => o.id !== id))
    if (selectedIdRef.current === id) selectObject(null)
  }

  // zapnout/vypnout výkop pod vybraným modelem (footprint se spočítá lazy z dlaždic)
  async function toggleExcavation(id: string) {
    const e = modelsRef.current.get(id)
    if (!e || !e.excavCells) return
    e.excavate = !e.excavate
    if (e.excavate && !e.footprint) e.footprint = await excavationFromCells(e.excavCells)
    updateExcavation()
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  function toggleVisible(o: SceneObj) {
    const vis = !o.visible
    if (o.kind === 'model') { const e = modelsRef.current.get(o.id); if (e) { e.model.show = vis; e.visible = vis } }
    else if (o.kind === 'parcel') parcelsRef.current.get(o.id.replace('parcel-', ''))?.ents.forEach(en => { en.show = vis })
    else if (o.kind === 'dmr') { const pt = patchesRef.current.get(o.id.replace('dmr-', '')); if (pt) pt.prim.show = vis }
    setObjects(list => list.map(x => x.id === o.id ? { ...x, visible: vis } : x))
  }

  function deleteObject(o: SceneObj) {
    if (o.kind === 'model') deleteModel(o.id)
    else if (o.kind === 'parcel') removeParcel(o.id.replace('parcel-', ''))
    else if (o.kind === 'dmr') removePatch(o.id.replace('dmr-', ''))
  }

  function commitRename() {
    const id = renamingId
    if (id) {
      const name = renameDraft.trim() || 'objekt'
      const e = modelsRef.current.get(id)
      if (e) e.name = name
      setObjects(list => list.map(x => x.id === id ? { ...x, name } : x))
    }
    setRenamingId(null)
  }

  function focusModel() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (v && !v.isDestroyed() && e) v.camera.flyToBoundingSphere(e.model.boundingSphere, { duration: 1.0 })
  }

  // přesné posazení vybraného modelu na povrch (terén i Google dlaždice)
  function dropToGround() {
    const v = viewerRef.current
    const e = selectedIdRef.current ? modelsRef.current.get(selectedIdRef.current) : null
    if (!v || v.isDestroyed() || !placement || !e) return
    if (!v.scene.sampleHeightSupported) return
    const carto = Cesium.Cartographic.fromDegrees(placement.lon, placement.lat)
    const h = v.scene.sampleHeight(carto, [e.model])
    if (h != null) setPlacement(pp => pp ? { ...pp, groundH: h, heightOffset: 0 } : pp)
  }

  function patch(part: Partial<Placement>) {
    setPlacement(p => p ? { ...p, ...part } : p)
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchErr(null)
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=cz&limit=1&q=${encodeURIComponent(q)}`
      const res = await fetch(url, { headers: { 'Accept-Language': 'cs' } })
      const data = await res.json() as Array<{ lat: string; lon: string; boundingbox?: [string, string, string, string] }>
      const hit = data[0]
      const v = viewerRef.current
      if (!hit || !v || v.isDestroyed()) { setSearchErr('Nenalezeno'); return }
      if (hit.boundingbox) {
        const [s, n, w, e2] = hit.boundingbox.map(Number)
        v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e2, n) })
      } else {
        v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(Number(hit.lon), Number(hit.lat), 10000) })
      }
    } catch {
      setSearchErr('Chyba vyhledávání')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />

      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf,.obj"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) importModel(f); e.target.value = '' }}
      />

      {!ION_TOKEN && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-amber-900/80 border border-amber-600/50 text-amber-200 text-xs">
          Chybí VITE_CESIUM_ION_TOKEN — terén z ion nepoběží
        </div>
      )}

      {/* loader při exportu */}
      {exporting && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-gray-900/95 border border-gray-700 text-gray-100">
            <Loader2 size={20} className="animate-spin text-emerald-400" />
            <div className="text-sm">
              <div className="font-medium">Exportuji…</div>
              <div className="text-[11px] text-gray-400">stahuji budovy (OSM) a výšky (ČÚZK)</div>
            </div>
          </div>
        </div>
      )}

      {/* vyhledávání */}
      <form onSubmit={runSearch} className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 p-1.5 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur">
        <Search size={15} className="text-gray-500 ml-1.5" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Najít místo (např. Liberec)…"
          className="bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none w-56"
        />
        {searchErr && <span className="text-xs text-amber-400 mr-1">{searchErr}</span>}
        <button type="submit" disabled={searching} className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-50">
          {searching ? <Loader2 size={14} className="animate-spin" /> : 'Jdi'}
        </button>
      </form>

      {/* ovládací panel */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1.5 p-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur">
        <button onClick={onBackToEditor} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-200 hover:bg-gray-800 transition-colors">
          <Box size={15} /> Editor
        </button>
        <div className="h-px bg-gray-700 my-0.5" />
        <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Podklad</div>
        <ToggleBtn active={base === 'ortofoto'} onClick={() => setBase('ortofoto')} icon={<Image size={15} />} label="Ortofoto ČR" />
        <ToggleBtn active={base === 'zm'} onClick={() => setBase('zm')} icon={<MapIcon size={15} />} label={base === 'zm' ? `Topografická mapa (${ztmTier})` : 'Topografická mapa ČR'} />
        <ToggleBtn active={base === 'google'} onClick={() => setBase('google')} icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="3D realita (Google)" />
        {base === 'google' ? (
          <div className="px-1 text-[10px] text-gray-500 max-w-[180px] leading-snug">
            {googleErr
              ? <span className="text-amber-400">{googleErr}</span>
              : <>Fotorealistické 3D jako Google Earth (přes ion token).</>}
          </div>
        ) : (
          <>
            <div className="h-px bg-gray-700 my-0.5" />
            <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Překryv</div>
            <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
          </>
        )}
        <ToggleBtn active={osmOn} onClick={() => setOsmOn(v => !v)} icon={osmLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="Budovy (OSM)" />
        <ToggleBtn active={districtsOn} onClick={toggleDistricts} icon={districtsLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} label="Městské části Liberce" />
        <div className="h-px bg-gray-700 my-0.5" />
        <ToggleBtn active={parcelMode} onClick={toggleParcel} icon={parcelLoading ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} label={parcelMode ? 'Klikni na parcelu' : 'Vybrat parcelu'} />
        <ToggleBtn active={areaMode} onClick={toggleAreaMode} icon={areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Hexagon size={15} />} label={areaMode ? `Klikej body (${areaPtCount})` : 'Vybrat oblast'} />
        {areaMode && areaPtCount >= 3 && (
          <button onClick={finalizeArea} disabled={areaLoading} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-orange-600 hover:bg-orange-500 text-white transition-colors disabled:opacity-50">
            <Check size={15} /> Vybrat parcely uvnitř
          </button>
        )}
        <ToggleBtn active={tileMode} onClick={toggleTileMode} icon={<Grid3x3 size={15} />} label={tileMode ? `Klikej / táhni (${tileCount})` : 'Vybrat dlaždice'} />
        {tileMode && (
          <div className="flex flex-col gap-1 px-1 pb-0.5">
            <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
              Tažením maluješ přes víc dlaždic; tah, co začne na vybrané, naopak odebírá.
              <span className="text-gray-400"> Mapu tady posouváš pravým tlačítkem, zoom kolečkem.</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 w-11 shrink-0">Dlaždice</span>
              {TILE_SIZES.map(s => (
                <button
                  key={s}
                  onClick={() => changeTileSize(s)}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${tileSize === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{s} m</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 w-11 shrink-0">Textura</span>
              {TEX_SIZES.map(s => (
                <button
                  key={s}
                  onClick={() => setTexSize(s)}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${texSize === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{s}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 w-11 shrink-0">Terén</span>
              {MESH_STEPS.map(s => (
                <button
                  key={s}
                  onClick={() => setMeshStep(s)}
                  title={s === 3 ? 'Sedne na zdrojová data (body DMR 5G mají rozteč ~2,8 m)' : s === 2 ? 'Hustší než zdroj — jen interpoluje, 2× víc trojúhelníků' : 'Řidší než zdroj — ubere detail, ušetří trojúhelníky'}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${meshStep === s ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{s} m</button>
              ))}
            </div>
            <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
              Ortofoto {(tileSize / texSize * 100).toFixed(0)} cm/px{tileSize / texSize < 0.2 ? ' (nad nativních 20 cm)' : ''}
              {' · '}
              {meshStep === 3 ? 'terén sedne na zdroj (body 5G mají ~2,8 m)' : meshStep === 2 ? 'terén hustší než zdroj — jen interpolace' : `terén po ${meshStep} m — řidší než zdroj`}
            </div>
            <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
              Vyveze se v reálných S-JTSK souřadnicích, bez posunu.
            </div>
          </div>
        )}
        <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">
          <Upload size={15} /> Import modelu
        </button>
      </div>

      {/* vybraná městská část */}
      {districtsOn && selectedDistrict && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/85 border border-cyan-500/40 backdrop-blur text-sm">
          <Sparkles size={14} className="text-cyan-400" />
          <span className="text-gray-100 font-medium">{districtsRef.current.get(selectedDistrict)?.name}</span>
          <button onClick={() => selectDistrict('')} title="Zrušit zvýraznění" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* lišta vybraných dlaždic */}
      {tileCount > 0 && (
        <div className={`absolute ${parcelCount > 0 ? 'bottom-16' : 'bottom-3'} left-3 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur text-sm`}>
          <Grid3x3 size={14} className="text-cyan-400" />
          <span className="text-gray-200">Dlaždice: <span className="font-medium">{tileCount}</span> × {tileSize} m</span>
          <span className="text-gray-500 text-xs">
          {(() => {
            const n = gridSize({ ix: 0, iy: 0, size: tileSize }, meshStep)
            const tris = tileCount * 2 * (n - 1) ** 2
            const mb = estimateObjBytes(tileCount, tileSize, meshStep) / 1e6
            const heavy = mb > 150
            return (
              <span className={heavy ? 'text-amber-400 text-xs' : 'text-gray-500 text-xs'} title={heavy ? 'Velký OBJ — zvaž řidší mřížku terénu nebo míň dlaždic' : undefined}>
                {tris >= 1e6 ? `~${(tris / 1e6).toFixed(1)} M trojúh.` : `~${Math.round(tris / 1e3)} k trojúh.`}
                {' · OBJ ~'}{mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`}
              </span>
            )
          })()}
          </span>
          <button
            onClick={exportTilesObj}
            disabled={tileBusy}
            title="Čistý terén DMR 5G s ortofoto texturou → zip s OBJ + MTL + JPEG pro 3ds Max"
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs disabled:opacity-50"
          >
            {tileBusy ? <><Loader2 size={13} className="animate-spin" /> {tileProgress}</> : <><Download size={13} /> Terén + ortofoto (OBJ)</>}
          </button>
          <button onClick={clearTiles} title="Zrušit výběr dlaždic" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* lišta vybraných parcel (multi) */}
      {parcelCount > 0 && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur text-sm">
          <MapPin size={14} className="text-cyan-400" />
          <span className="text-gray-200">Parcely: <span className="font-medium">{parcelCount}</span></span>
          <button onClick={buildDmrPatches} disabled={dmrLoading} className="ml-1 flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs disabled:opacity-50">
            {dmrLoading ? <Loader2 size={13} className="animate-spin" /> : <Mountain size={13} />} Detailní terén
          </button>
          <button onClick={exportParcelsDxf} disabled={exporting} title="Export hranic parcel jako křivky (DXF pro 3ds Max)" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50">
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} hranice (DXF)
          </button>
          {patchCount > 0 && (
            <>
              <button onClick={exportDmrGlb} title="Export do glb (reimport na stejné místo)" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs">
                <Download size={13} /> glb
              </button>
              <button onClick={exportDmrObj} title="Export do OBJ (pro 3ds Max apod.)" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-xs">
                <Download size={13} /> OBJ
              </button>
              <button onClick={removeAllPatches} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs">
                <Mountain size={13} /> Odebrat terén
              </button>
            </>
          )}
          <button onClick={clearAllParcels} title="Zrušit výběr všech parcel" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* panel Scéna — seznam objektů */}
      {objects.length > 0 && (
        <div className="absolute top-3 right-3 z-10 w-64 flex flex-col gap-1 p-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur max-h-[40vh] overflow-auto">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1 mb-0.5">Scéna</div>
          {objects.map(o => (
            <div
              key={o.id}
              onClick={() => o.kind === 'model' ? selectObject(o.id) : selectObject(null)}
              className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm cursor-pointer ${
                selectedId === o.id ? 'bg-emerald-600/25 text-emerald-100' : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span className="text-[10px] text-gray-500 w-9 shrink-0">{o.kind === 'model' ? 'model' : o.kind === 'parcel' ? 'parc' : o.kind === 'dmr' ? 'terén' : 'ploch'}</span>
              {renamingId === o.id ? (
                <input
                  autoFocus value={renameDraft}
                  onChange={e => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                  onClick={e => e.stopPropagation()}
                  className="flex-1 min-w-0 bg-gray-800 rounded px-1 text-gray-100 outline-none"
                />
              ) : (
                <span
                  className="flex-1 min-w-0 truncate"
                  onDoubleClick={e => { if (o.kind === 'model') { e.stopPropagation(); setRenamingId(o.id); setRenameDraft(o.name) } }}
                  title={o.name}
                >{o.name}</span>
              )}
              <button onClick={e => { e.stopPropagation(); toggleVisible(o) }} title="Zobrazit/skrýt" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100">
                {o.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button onClick={e => { e.stopPropagation(); deleteObject(o) }} title="Smazat" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300 opacity-0 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* panel manipulace s vybraným modelem */}
      {placement && (
        <div className="absolute z-10 w-64 flex flex-col gap-3 p-3 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur" style={{ top: `calc(1.75rem + ${Math.min(objects.length, 6) * 1.85 + 2}rem)`, right: '0.75rem' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-gray-100 truncate">{objects.find(o => o.id === selectedId)?.name ?? 'Model'}</div>
            <button onClick={() => selectedId && deleteModel(selectedId)} title="Odebrat model" className="shrink-0 p-1 rounded-lg text-gray-400 hover:text-red-300 hover:bg-gray-800">
              <Trash2 size={15} />
            </button>
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={toggleMove}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                moveMode ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
            >
              <Move size={14} /> {moveMode ? 'Táhni model' : 'Přesunout'}
            </button>
            <button onClick={focusModel} title="Zaměřit kameru na model" className="px-2 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700">
              <Crosshair size={15} />
            </button>
          </div>

          <button onClick={dropToGround} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-200 hover:bg-gray-700">
            <ArrowDownToLine size={14} /> Posadit na terén
          </button>

          <button
            onClick={() => setSectionOn(s => !s)}
            title="Odříznout terén/Google svislou rovinou → profil model+terén (stavební řez)"
            className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
              sectionOn ? 'bg-cyan-600 text-white hover:bg-cyan-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
            }`}
          >
            <Layers size={14} /> {sectionOn ? 'Řez zapnutý' : 'Řez terénem'}
          </button>
          {sectionOn && (
            <div className="flex flex-col gap-2 pl-1 border-l-2 border-cyan-700/50">
              <NumRow label="Natočení řezu" value={sectionAz} min={0} max={359} step={1} unit="°" onChange={v => setSectionAz(v)} />
              <NumRow label="Posun řezu" value={sectionOffset} min={-500} max={500} step={1} unit="m" onChange={v => setSectionOffset(v)} />
              <button onClick={() => setSectionFlip(f => !f)} className="flex items-center justify-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-gray-800 text-gray-300 hover:bg-gray-700">
                <RotateCcw size={13} /> Otočit stranu řezu
              </button>
            </div>
          )}

          {selectedId && modelsRef.current.get(selectedId)?.excavCells && (
            <button
              onClick={() => selectedId && toggleExcavation(selectedId)}
              title="Vyhloubit terén/Google pod modelem (jáma podél trasy)"
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                modelsRef.current.get(selectedId)?.excavate ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
            >
              <Mountain size={14} /> {modelsRef.current.get(selectedId)?.excavate ? 'Výkop zapnutý' : 'Vyhloubit terén'}
            </button>
          )}

          <NumRow label="Výška nad terénem" value={placement.heightOffset} min={-20} max={200} step={0.1} unit="m" onChange={v => patch({ heightOffset: v })} />
          <NumRow label="Otočení" value={placement.heading} min={0} max={359} step={1} unit="°" onChange={v => patch({ heading: v })} />
          <NumRow label="Náklon (pitch)" value={placement.pitch} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ pitch: v })} />
          <NumRow label="Náklon (roll)" value={placement.roll} min={-45} max={45} step={0.5} unit="°" onChange={v => patch({ roll: v })} />
          <NumRow label="Měřítko" value={placement.scale} min={0.1} max={20} step={0.1} unit="×" onChange={v => patch({ scale: v })} />

          <button onClick={() => patch({ heading: 0, pitch: 0, roll: 0 })} className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-300 hover:bg-gray-700">
            <RotateCcw size={13} /> Reset natočení
          </button>

          <div className="text-[10px] text-gray-500 leading-snug">
            {placement.lat.toFixed(5)}, {placement.lon.toFixed(5)}
          </div>
        </div>
      )}
    </div>
  )
}

function NumRow({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div>
      <div className="flex justify-between items-center text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min} max={max} step={step}
            value={Number(value.toFixed(2))}
            onChange={e => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange(clamp(n)) }}
            className="w-16 bg-gray-800 rounded px-1.5 py-0.5 text-right text-gray-100 tabular-nums outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <span className="text-gray-500 w-2 text-center">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  )
}

function ToggleBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
        active ? 'bg-emerald-600/25 text-emerald-200 border border-emerald-500/40' : 'text-gray-400 hover:bg-gray-800 border border-transparent'
      }`}
    >
      {icon} {label}
    </button>
  )
}
