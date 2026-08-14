import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import * as THREE from 'three'
import concaveman from 'concaveman'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { Zip, ZipDeflate, ZipPassThrough, zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import {
  TILE_SIZES, MESH_STEPS, MESH_STEP_DEFAULT, TEX_SIZES, type TileSize, type MeshStep, type TexSize,
  type Tile, type Offset, tileKey, tileName, tileAt, tilesBounds, tileRingLL, wgsOf, sjtskOf,
  pool, fetchTileHeights, fetchTileOrtho, fetchRetry, fetchJpegRetry, buildTileObj, buildMtl, buildMaxScript, buildMaxScriptFiles, medianHeight,
  gridSize, stepOf, concatBytes, estimateObjBytes, mapBboxUrl, pickTopoTier, type MapLayer,
} from './tiles'
import { cacheGet, cachePut, cacheStats, cacheClear, bakedGet, bakedPut, bakedAllKeys, bakedClear } from './cache'
import { fetchOrthoUrl, orthoExport4326Url } from './orthoTiles'
import { fetchBuildings, buildBuildingsObj, BUILDING_MTL } from './buildings'
import { solveSimilarity, type V3 } from './similarity'
import { dxfToPrims, type DrawParse, type DrawPrim } from './dxf'
import proj4 from 'proj4'
import { fromArrayBuffer } from 'geotiff'
import cdt2d from 'cdt2d'
import polygonClipping from 'polygon-clipping'
import { toast } from 'sonner'
import { Box, Layers, Map as MapIcon, Image, Search, Loader2, Building2, Upload, Move, Crosshair, Trash2, ArrowDownToLine, RotateCcw, MapPin, Mountain, Download, Eye, EyeOff, Hexagon, Check, Sparkles, Grid3x3, X, ChevronRight, ChevronDown, Landmark } from 'lucide-react'

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined

// Zrušený export: fetch(...,{signal}) i naše ruční `throw` házejí DOMException s name 'AbortError'.
const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

// ── Přepínače funkcí (skrýt, ne mazat) ─────────────────────────────────────────────
// Pro nasazení v task-manageru nepotřebujeme Google 3D, OSM budovy ani městské části Liberce.
// Vypnutím zmizí jen tlačítka; funkce (ensureGoogle/ensureOsm/toggleDistricts) v kódu zůstávají,
// takže se to kdykoliv vrátí přepnutím na true. Vše je líné → skryté tlačítko = nula výkonu.
// POZOR: ion token používá JEN Google 3D a OSM budovy. Když jsou oba false, token není potřeba
// (terén DMR i ortofoto jedou přímo z ČÚZK) → odpadá i celý problém s 401 na ion.
const ENABLE_GOOGLE_3D = true
const ENABLE_OSM_BUILDINGS = false
const ENABLE_LIBEREC_DISTRICTS = false
const NEEDS_ION = ENABLE_GOOGLE_3D || ENABLE_OSM_BUILDINGS

// Google Photorealistic 3D Tiles streamované přes Cesium ion (stačí ion token, žádný Google klíč).
// Asset je nutné jednorázově přidat ve svém ion účtu (Asset Depot → Google Photorealistic 3D Tiles).
const GOOGLE_3D_ION_ASSET = 2275207

// TEST: Gaussian splat (Schillerova rozhledna nad Kryry) nahraný do Cesium ion → 3D Tiles.
const SPLAT_ASSET_ID = 5137495
const SPLAT_ANCHOR = { lon: 13.42995, lat: 50.17221, h: 383 } // věž ~383 m n.m. (Bpv)
// Splat z COLMAPu chodí otočený o 90° (Y-up vs Cesium Z-up) → výchozí roll narovná nastojato.
const SPLAT_BASE_ROLL = -90
const SPLAT_PLACEMENT_KEY = `geo.splat.placement.${SPLAT_ASSET_ID}` // uložené ruční usazení (localStorage)
const SPLAT_ON_KEY = `geo.splat.on.${SPLAT_ASSET_ID}` // „splat byl zapnutý" → po startu se sám načte

// S-JTSK / Křovák (EPSG:5514) — katastr WFS vrací geometrii v něm, přepočítáváme na WGS84.
// Definice (7-param Helmert) je v ./tiles, který se načte dřív než tenhle modul.

// ── ČÚZK WMS služby (ověřeno přes GetCapabilities — všechny podporují EPSG:3857) ──

// větší dlaždice = méně requestů = méně opakujících se ČÚZK log v mapě
const WMS_TILE = 512

// Volitelný externí lokální dlaždicový server (viz scripts/tile-server.mjs) — má přednost.
const LOCAL_TILES = import.meta.env.VITE_LOCAL_TILES as string | undefined

// Index napečených ortofoto dlaždic („lokální mapa") v paměti — synchronní kontrola v requestImage.
// Klíč = 'owms/{level}/{x}/{y}' (GEOGRAPHIC dlaždice WMS). Plní se z IndexedDB (store BAKED) při startu.
const bakedKeys = new Set<string>()

// čerstvá průhledná 1×1 dlaždice (Cesium ImageBitmap po použití zavírá → nesdílet jednu instanci)
function blankTile(): Promise<ImageBitmap> {
  const c = document.createElement('canvas'); c.width = 1; c.height = 1
  return createImageBitmap(c)
}

/**
 * Ortofoto WMS s lokální dlaždicovou pyramidou. Zobrazení jde DÁL přes WMS (`super.requestImage`) —
 * jen dlaždice NAPEČENÉ do localu (`bakedKeys`) se vezmou z IndexedDB (nativní rozlišení, offline,
 * okamžité). Prázdný `bakedKeys` = 100 % čisté WMS → mapa se nemůže rozbít. Napečené dlaždice se
 * dekódují STEJNOU cestou jako živé WMS (`Resource.fetchImage` s flipY) → orientace/zarovnání sedí.
 */
class CachedWmsOrtho extends Cesium.WebMapServiceImageryProvider {
  requestImage(x: number, y: number, level: number, request?: Cesium.Request): Promise<Cesium.ImageryTypes> | undefined {
    const key = `owms/${level}/${x}/${y}`
    if (!bakedKeys.has(key)) return super.requestImage(x, y, level, request) // nenapečené = živé WMS jako dosud
    return bakedGet(key).then(b => {
      if (!b) return (super.requestImage(x, y, level, request) ?? blankTile()) as Promise<Cesium.ImageryTypes>
      const url = URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/jpeg' }))
      const img = new Cesium.Resource({ url }).fetchImage({ preferImageBitmap: true, flipY: true })
      return Promise.resolve((img ?? blankTile()) as Promise<Cesium.ImageryTypes>).finally(() => URL.revokeObjectURL(url))
    })
  }
}

function ortofotoProvider() {
  if (LOCAL_TILES) {
    return new Cesium.UrlTemplateImageryProvider({
      url: `${LOCAL_TILES.replace(/\/$/, '')}/orto/{z}/{x}/{y}.jpg`,
      rectangle: LIBEREC_EXTENT,
      minimumLevel: 10,
      maximumLevel: 19,
      tileWidth: 256,
      tileHeight: 256,
    })
  }
  return new CachedWmsOrtho({
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
      // trvalá cache (disk) — přežije refresh; klíč odlišený od exportních dlaždic (jiné dláždění + GEOID)
      const dbKey = `dmrterr/${level}/${x}/${y}`
      const disk = await cacheGet(dbKey)
      if (disk && disk.byteLength === W * H * 4) {
        const out = new Float32Array(disk.slice().buffer)
        dmrTileCache.set(key, out)
        return out
      }
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
        void cachePut(dbKey, new Uint8Array(out.buffer.slice(0)))
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
  footprint?: Cesium.Cartesian3[][] // obrys(y) půdorysu ve světě (S-JTSK přes kotvu) pro skrytí mapy
  excavate?: boolean                // skrýt mapu (ortofoto/topo + terén + Google) pod/nad modelem
  outline?: boolean                 // svítící obrys (silhouette) kolem modelu; výchozí vypnuto
}
// položka panelu Scéna
type SceneObj = { id: string; kind: 'model' | 'parcel' | 'surface' | 'drawing'; name: string; visible: boolean }
// jedna hladina výkresu — vlastní Cesium primitivy, aby šla samostatně zapnout/vypnout
type DrawLayer = { name: string; color: number; visible: boolean; prim: Cesium.Primitive | null; labels: Cesium.LabelCollection | null; points: Cesium.PointPrimitiveCollection | null }
type DrawingEntry = { layers: DrawLayer[]; bounds: Cesium.Rectangle | null }
const EMPTY_NAMESET: ReadonlySet<string> = new Set()

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
function buildDxf(polylines: [number, number, number][][], layer = 'PARCELY'): string {
  return buildDxfLayers([{ layer, polylines }])
}

/** Jako buildDxf, ale víc pojmenovaných hladin v jednom výkresu (např. parcely + obrys území). */
function buildDxfLayers(groups: { layer: string; polylines: [number, number, number][][] }[]): string {
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

/** Výškový rastr z ČÚZK ImageServeru (dmr5g/dmp1g) → vzorkovací funkce lon/lat → výška (Bpv). */
async function fetchElevSampler(service: 'dmr5g' | 'dmp1g', minLon: number, minLat: number, maxLon: number, maxLat: number, size: number): Promise<(lon: number, lat: number) => number | null> {
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
async function fetchElevSamplerSJTSK(service: 'dmr5g' | 'dmp1g', minX: number, minY: number, maxX: number, maxY: number, sw: number, sh: number, signal?: AbortSignal): Promise<(x: number, y: number) => number | null> {
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

/**
 * Budovy ČÚZK pro S-JTSK obdélník → OBJ objekt „budovy" (výška i tvar střechy z DMR5G/DMP1G).
 * Vrací kus OBJ textu k připojení, počet přidaných vrcholů a řádek do info.txt.
 */
async function buildingsObjChunk(minX: number, minY: number, maxX: number, maxY: number, vBase: number, signal: AbortSignal): Promise<{ obj: string; vCount: number; line: string }> {
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

/** Nejnižší bod modelu (gltf Y-up = cesium Z-up). null = nezměřeno. */
async function computeBottomZ(file: File): Promise<number | null> {
  try {
    const buf = await file.arrayBuffer()
    const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
      getGltfLoader().parse(buf, '', g => resolve(g as unknown as { scene: THREE.Object3D }), reject)
    })
    const box = new THREE.Box3().setFromObject(gltf.scene)
    return Number.isFinite(box.min.y) ? box.min.y : null
  } catch { return null }
}

/**
 * Model z 3ds Max s reálnými S-JTSK (EPSG:5514) souřadnicemi v geometrii → přemapuje každý vrchol
 * proj4 (S-JTSK→WGS84) + výška Bpv→elipsoid a zapeče do lokálního ENU rámce (E,U,-N) kolem těžiště,
 * stejnou konvencí jako náš export. Vrací glb URL + geo-kotvu. null = nevypadá jako S-JTSK (necháme ruční).
 * Osy/znaménko se detekují z dat: výška = osa s nejmenší velikostí, horizontály dle velikosti (v ČR |Y|>|X|),
 * proj4 chce záporné hodnoty.
 */
// ── Půdorys modelu (konkávní obal) pro skrytí mapy pod/nad modelem ────────────────────
const FOOT_GRID_M = 0.15       // sjednocení bodů do mřížky (hustá síť má statisíce vrcholů → výkon)
const FOOT_CONCAVITY = 2       // concaveman: menší = detailnější obrys
const FOOT_MIN_INLET_M = 0.5   // zálivy kratší než tohle se vyhladí
const FOOT_SIMPLIFY_M = 0.2    // tolerance zjednodušení obrysu (Douglas–Peucker), v metrech
const FOOT_MAX_PTS = 250       // strop bodů obrysu — víc Cesium clip polygon spolehlivě neořízne
const FOOT_MAX_TRIS_UNION = 40000 // nad tolik trojúhelníků je 2D union pomalý → fallback na konkávní obal
// objekty v modelu, které slouží JEN jako maska ořezu (podle názvu). Když nějaké jsou, obrys se
// počítá z nich (každý zvlášť); jinak z celého modelu.
const MASK_NAME_RE = /maska|mask|clip|ořez|orez|výřez|vyrez|object006|object007/i

/** Douglas–Peucker (iterativně, bez rekurze) na otevřenou lomenou čáru; krajní body zachová. */
function simplifyRDP(pts: [number, number][], eps: number): [number, number][] {
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
function simplifyRingCapped(ring: [number, number][]): [number, number][] | null {
  if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (a[0] === b[0] && a[1] === b[1]) ring = ring.slice(0, -1) }
  if (ring.length < 3) return null
  // Cesium clip polygon zvládne jen omezený počet bodů → zvyšuj toleranci, dokud nejsme pod stropem
  let eps = FOOT_SIMPLIFY_M
  let simp = simplifyRDP(ring, eps)
  while (simp.length > FOOT_MAX_PTS && eps < 100) { eps *= 1.7; simp = simplifyRDP(ring, eps) }
  return simp.length >= 3 ? simp : null
}

/** Konkávní obal 2D bodů → zjednodušený prstenec [[x,y],…] bez děr; null když málo bodů. */
function concaveFootprint(pts: [number, number][]): [number, number][] | null {
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
function unionOutlines(tris: [number, number][][]): [number, number][][] {
  if (!tris.length) return []
  const polys = tris.map(t => [[t[0], t[1], t[2], t[0]]] as [number, number][][])
  let merged: [number, number][][][]
  try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as unknown as [number, number][][][] }
  catch (e) { console.error('Union masky selhal:', e); return [] }
  const rings: [number, number][][] = []
  for (const poly of merged) { const outer = poly[0]; if (outer && outer.length >= 4) rings.push(outer.map(([x, y]) => [x, y] as [number, number])) }
  return rings
}

async function georeferenceSjtskGlb(file: File): Promise<{ url: string; anchor: Anchor; bottomZ: number; footprint: Cesium.Cartesian3[][] | null } | null> {
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
  const allPts: [number, number][] = [] // ENU (east, north) všech vrcholů — fallback obrys celého modelu
  const maskTris = new Map<string, [number, number][][]>() // ENU trojúhelníky maskovacích objektů (podle názvu)

  const meshes: THREE.Mesh[] = []
  scene.traverse(obj => { const m = obj as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry
    const pos = g.attributes.position as THREE.BufferAttribute
    const wm = m.matrixWorld
    const isMask = MASK_NAME_RE.test(m.name)
    const meshEN: [number, number][] = isMask ? new Array(pos.count) : [] // ENU vrcholy jen u masky (pro trojúhelníky)
    for (let i = 0; i < pos.count; i++) {
      vw.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm) // do světových souřadnic (respektuj hierarchii)
      const [sx, sy, up] = toSjtsk(vw)
      const [lon, lat] = proj4('EPSG:5514', 'EPSG:4326', [sx, sy]) as [number, number]
      const e = Cesium.Cartesian3.fromDegrees(lon, lat, up + GEOID_CZ)
      s.x = e.x; s.y = e.y; s.z = e.z
      Cesium.Matrix4.multiplyByPoint(inv, s, o) // (east, north, up) v ENU kolem kotvy
      pos.setXYZ(i, o.x, o.z, -o.y)             // gltf (E, U, -N) — stejné jako buildExportScene
      if (o.z < minU) minU = o.z
      allPts.push([o.x, o.y])                   // ENU (east, north)
      if (isMask) meshEN[i] = [o.x, o.y]
    }
    if (isMask) {
      let tris = maskTris.get(m.name); if (!tris) { tris = []; maskTris.set(m.name, tris) }
      const idx = g.index
      if (idx) { for (let t = 0; t + 2 < idx.count; t += 3) tris.push([meshEN[idx.getX(t)], meshEN[idx.getX(t + 1)], meshEN[idx.getX(t + 2)]]) }
      else { for (let t = 0; t + 2 < meshEN.length; t += 3) tris.push([meshEN[t], meshEN[t + 1], meshEN[t + 2]]) }
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }
  // world transformy jsou zapečené do vrcholů → vynuluj všechny node transformy
  scene.traverse(obj => { obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix() })
  scene.updateMatrixWorld(true)

  const glbBuf = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(scene, r => res(r as ArrayBuffer), rej, { binary: true }))
  const url = URL.createObjectURL(new Blob([glbBuf], { type: 'model/gltf-binary' }))

  // obrys(y) půdorysu → svět přes kotvu (přesné, nezávislé na Cesium korekci os).
  // Maskovací objekty: přesný obrys geometrie (union trojúhelníků) → vhloubení zůstanou nevyříznutá.
  // Bez masek: konkávní obal celého modelu.
  const F = Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF)
  const enToWorld = (e: number, n: number) => Cesium.Matrix4.multiplyByPoint(F, new Cesium.Cartesian3(e, n, 0), new Cesium.Cartesian3())
  const footprint: Cesium.Cartesian3[][] = []
  if (maskTris.size) {
    for (const [name, tris] of maskTris) {
      let rings: [number, number][][]
      if (tris.length > FOOT_MAX_TRIS_UNION) { const cf = concaveFootprint(tris.flat()); rings = cf ? [cf] : []; console.warn(`Maska „${name}": ${tris.length} trojúhelníků je moc na přesný obrys → použit konkávní obal`) }
      else rings = unionOutlines(tris)
      for (const r of rings) { const simp = simplifyRingCapped(r); if (simp) footprint.push(simp.map(([e, n]) => enToWorld(e, n))) }
    }
  } else {
    const ring = concaveFootprint(allPts)
    if (ring) footprint.push(ring.map(([e, n]) => enToWorld(e, n)))
  }
  return { url, anchor, bottomZ: Number.isFinite(minU) ? minU : 0, footprint: footprint.length ? footprint : null }
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

// ── Správní jednotky (kraj/okres/obec + k.ú.) z ČÚZK RÚIAN (ArcGIS REST) ─────────────────
// RÚIAN MapServer má vrstvy s názvy i kódy a jde dotazovat bodem/jménem/kódem obce.
type AdminUnit = { level: string; name: string; kod: number; layer: number; obec?: number; rings?: [number, number][][] }
const RUIAN = 'https://ags.cuzk.gov.cz/arcgis/rest/services/RUIAN/MapServer'
const RUIAN_LEVELS: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec']] // od největší po nejmenší

/** Dotaz na RÚIAN vrstvu (Esri JSON, geometrie v S-JTSK). geom=true → i prstence. */
async function ruianQuery(layer: number, where: string, geom: boolean): Promise<Array<{ kod: number; nazev: string; obec?: number; rings: [number, number][][] }>> {
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
async function ruianAtPoint(layer: number, lon: number, lat: number): Promise<{ kod: number; nazev: string } | null> {
  const url = `${RUIAN}/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=kod,nazev&returnGeometry=false&f=json`
  const res = await fetch(url); if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string } }> }
  const a = data.features?.[0]?.attributes
  return a?.nazev ? { kod: Number(a.kod), nazev: a.nazev.trim() } : null
}

/** Kraj/okres/obec obsahující bod (bez geometrie — ta se dotáhne až při výběru). */
async function fetchAdminUnits(lon: number, lat: number): Promise<AdminUnit[]> {
  const out: AdminUnit[] = []
  for (const [layer, level] of RUIAN_LEVELS) {
    try { const u = await ruianAtPoint(layer, lon, lat); if (u) out.push({ level, name: u.nazev, kod: u.kod, layer, obec: level === 'Obec' ? u.kod : undefined }) } catch { /* přeskoč */ }
  }
  return out
}
/** Katastrální území dané obce (kód obce) — názvy + kódy, bez geometrie. */
async function fetchAdminParts(obecKod: number): Promise<AdminUnit[]> {
  const ku = await ruianQuery(7, `obec=${obecKod}`, false)
  return ku.filter(u => u.nazev).map(u => ({ level: 'k.ú.', name: u.nazev, kod: u.kod, layer: 7 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}
/** Dotáhne prstence (S-JTSK) jednotky podle vrstvy+kódu. */
async function fetchAdminGeom(layer: number, kod: number): Promise<[number, number][][]> {
  const r = await ruianQuery(layer, `kod=${kod}`, true)
  return r[0]?.rings || []
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
  // multi-parcela: vybrané parcely (klíč = id parcely)
  const parcelsRef = useRef<Map<string, { positions: Cesium.Cartesian3[]; ring: number[][]; ents: Cesium.Entity[] }>>(new Map())
  // nahrané výkresy (DXF/DWG): čáry/popisky/body po hladinách + obalové bounds
  const drawingsRef = useRef<Map<string, DrawingEntry>>(new Map())
  const fileRef = useRef<HTMLInputElement>(null)
  const dwgRef = useRef<HTMLInputElement>(null)

  const [base, setBase] = useState<Base>('ortofoto')
  const [ztmTier, setZtmTier] = useState<string>('ZTM250')
  const [katastrOn, setKatastrOn] = useState(false)
  // ořez podle vybraných parcel: 'hide' = skryj parcelu, 'only' = nech jen parcelu (inverse)
  // 'g3d' = topo/ortofoto všude + Google 3D realita JEN uvnitř vybraných parcel (inverzní ořez)
  const [parcelClip, setParcelClip] = useState<'off' | 'hide' | 'only' | 'g3d'>('off')
  const [parcelBuffer, setParcelBuffer] = useState(0) // odsazení hranice parcel při ořezu (m, ±)
  // „Jen parcelu": izolace ztlumením okolí (poloprůhledný překryv s dírou v parcele).
  // okoliVis = viditelnost okolí (0 = černé/skryté, 1 = plně vidět)
  const [okoliVis, setOkoliVis] = useState(0)
  const [keep3DAround, setKeep3DAround] = useState(true) // u „Jen parcelu": defaultně nechat vidět okolní 3D budovy
  const dimEntityRef = useRef<Cesium.Entity | null>(null)
  const dimAlphaRef = useRef(0)               // aktuální (animovaná) alfa překryvu
  const dimTargetRef = useRef(0)              // cílová alfa
  const dimRafRef = useRef<number | null>(null)
  const [parcelHl, setParcelHl] = useState(true) // zvýraznění (tyrkys výplň+obrys) vybraných parcel
  // zvýraznění správního území (kraj/okres/obec): klik → vnořené jednotky → izolace ztlumením okolí
  const [regionMode, setRegionMode] = useState(false)
  const [regionBusy, setRegionBusy] = useState(false)
  const [regionChoices, setRegionChoices] = useState<AdminUnit[]>([])
  const [regionName, setRegionName] = useState<string | null>(null)
  const [regionDim, setRegionDim] = useState(0.2) // viditelnost okolí (0 = černé, 1 = plné)
  const [regionQuery, setRegionQuery] = useState('')
  const [regionParts, setRegionParts] = useState<AdminUnit[]>([]) // katastrální území vybrané obce
  const regionEntsRef = useRef<Cesium.Entity[]>([])
  const regionDimEntRef = useRef<Cesium.Entity | null>(null)
  const regionActiveRef = useRef<{ name: string; worldRings: Cesium.Cartesian3[][]; sjtskRings: [number, number][][] } | null>(null)
  const regionPrimsRef = useRef<Cesium.Primitive[]>([]) // hranice jako primitivy (vždy viditelné)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleErr, setGoogleErr] = useState<string | null>(null)
  const [googleAlpha, setGoogleAlpha] = useState(1)               // průhlednost 3D reality (1 = plná, 0 = jen mapa pod ní)
  const [googleUnder, setGoogleUnder] = useState<'ortofoto' | 'zm' | 'none'>('none') // plochá mapa pod 3D; default 'none' = čistě 3D

  // scéna: seznam objektů + vybraný + umístění vybraného modelu
  const [objects, setObjects] = useState<SceneObj[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // rozbalené výkresy v panelu Scéna (ukazují seznam hladin)
  const [expandedDrawings, setExpandedDrawings] = useState<Set<string>>(new Set())
  // text pro filtrování hladin, klíč = id objektu výkresu
  const [layerFilter, setLayerFilter] = useState<Record<string, string>>({})
  // výběr hladin (multi-select klikáním i tažením), klíč = id objektu výkresu → množina názvů hladin
  const [layerSel, setLayerSel] = useState<Record<string, Set<string>>>({})
  const lastLayerClick = useRef<Record<string, string>>({}) // poslední klik pro Shift-rozsah
  // aktivní tažení výběru: přes které hladiny přejedeš se stejným režimem přidají/odeberou
  const dragRef = useRef<{ oid: string; mode: 'add' | 'remove' } | null>(null)
  useEffect(() => { const up = () => { dragRef.current = null }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up) }, [])
  const [placement, setPlacement] = useState<Placement | null>(null)
  // TEST: Gaussian splat (Kryry) — samostatná manipulace mimo model systém (tileset, ne Model)
  const splatRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const [splatOn, setSplatOn] = useState(false)
  const [splatShow, setSplatShow] = useState(true)  // zobrazit/skrýt splat (ať je vidět terén pod ním)
  const [splatMove, setSplatMove] = useState(false) // tažení splatu po terénu
  const [splatCP, setSplatCP] = useState(false)     // vlícovací režim (kontrolní body)
  const [cpCount, setCpCount] = useState(0)
  const [cpPending, setCpPending] = useState(false) // čeká se na mapový bod k rozklikanému bodu splatu
  const cpRef = useRef<{ s: V3; q: V3 }[]>([])       // dvojice (bod ve světě splatu, bod na reálné mapě)
  const cpPendingRef = useRef<V3 | null>(null)
  const cpEntsRef = useRef<Cesium.Entity[]>([])      // vizuální značky kliknutých bodů
  const [splatLoading, setSplatLoading] = useState(false)
  const [splatP, setSplatP] = useState<Placement>(() => {
    try { const s = localStorage.getItem(SPLAT_PLACEMENT_KEY); if (s) return JSON.parse(s) as Placement } catch { /* ignore */ }
    return { lon: SPLAT_ANCHOR.lon, lat: SPLAT_ANCHOR.lat, groundH: SPLAT_ANCHOR.h + GEOID_CZ, heightOffset: 0, heading: 0, pitch: 0, roll: SPLAT_BASE_ROLL, scale: 1 }
  })
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
  const [cutoutBusy, setCutoutBusy] = useState(false)      // export výřezu (terén+ortofoto) běží
  const [cutoutPct, setCutoutPct] = useState(-1)           // 0..1 určitý průběh, -1 = neurčitý
  const [cutoutProgress, setCutoutProgress] = useState('') // textový popis fáze
  // výběr oblasti: naklikat body → vybrat všechny parcely uvnitř polygonu
  const [areaMode, setAreaMode] = useState(false)
  const [areaPtCount, setAreaPtCount] = useState(0)
  const [areaLoading, setAreaLoading] = useState(false)
  const areaPtsRef = useRef<Cesium.Cartesian3[]>([])
  const areaEntsRef = useRef<Cesium.Entity[]>([])

  const [tileMode, setTileMode] = useState(false)
  const [tileSize, setTileSize] = useState<TileSize>(1000)
  const [texSize, setTexSize] = useState<TexSize>(2048)
  const [meshStep, setMeshStep] = useState<MeshStep>(MESH_STEP_DEFAULT)
  // strop delší strany spojené 2D mapy (px). 16384 ≈ hranice canvasu prohlížeče (~1 GB paměti).
  const [stitchMax, setStitchMax] = useState(8192)
  const [tileCount, setTileCount] = useState(0)
  const [tileBusy, setTileBusy] = useState(false)
  const [tileProgress, setTileProgress] = useState('')
  const [tilePct, setTilePct] = useState(-1) // 0..1 = určitý průběh (stahování), -1 = neurčitý (skládání apod.)
  const abortRef = useRef<AbortController | null>(null) // pro zrušení běžícího exportu
  const tilesRef = useRef<Map<string, { tile: Tile; ent: Cesium.Entity }>>(new Map())
  // mřížka dlaždic přes viditelnou oblast (jako kladení listů na ČÚZK) — zap/vyp overlay s názvy
  const [gridOn, setGridOn] = useState(false)
  const [gridNote, setGridNote] = useState('')
  const gridEntsRef = useRef<Cesium.Entity[]>([])
  // přibalit do exportu i hranice parcel (katastr) jako DXF křivky
  const [exportKatastr, setExportKatastr] = useState(false)
  const [exportBuildings, setExportBuildings] = useState(false)
  const [drawingLoading, setDrawingLoading] = useState(false)
  // trvalá cache dlaždic (IndexedDB) — stav pro UI
  const [cacheInfo, setCacheInfo] = useState<{ count: number; bytes: number; pinnedBytes: number }>({ count: 0, bytes: 0, pinnedBytes: 0 })
  const refreshCache = () => { cacheStats().then(setCacheInfo).catch(() => {}) }
  useEffect(() => { refreshCache(); const id = setInterval(refreshCache, 4000); return () => clearInterval(id) }, [])
  // „Lokální mapa" = dlaždicová pyramida napečená do IndexedDB (store BAKED). `bakedInfo` = počet
  // dlaždic (pro UI). Při startu načteme klíče do `bakedKeys`, ať je requestImage bere lokálně.
  const [bakedInfo, setBakedInfo] = useState(0)
  useEffect(() => { bakedAllKeys().then(ks => { ks.forEach(k => bakedKeys.add(k)); setBakedInfo(bakedKeys.size) }).catch(() => {}) }, [])
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
      contextOptions: { webgl: { preserveDrawingBuffer: true } }, // nutné pro snímky (canvas.toBlob)
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
    try { if (localStorage.getItem(SPLAT_ON_KEY)) void loadSplat(false) } catch { /* ignore */ } // splat byl zapnutý → načti sám (bez přeletu)

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
    // ── plynulejší načítání rastrových dlaždic ČÚZK (ortofoto/topo) + terénu DMR ──
    // Větší cache dlaždic → míň „reload" bliknutí při návratu na místo (default 100). Terén i imagery
    // se cachují společně. `preloadSiblings` = natáhni i sousední dlaždice → při posunu jsou hotové dřív.
    // Pozn.: ZTM ČÚZK je při paralelní zátěži FLAKY (bílé dlaždice) → víc požadavků = větší riziko;
    // kdyby topo bílalo, `preloadSiblings` je první podezřelý na vypnutí.
    viewer.scene.globe.tileCacheSize = 1000
    viewer.scene.globe.preloadSiblings = true

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
    // ── ladění streamování/LOD, ať je „skákání" dlaždic klidnější (kompromis detail ↔ výkon/data) ──
    // Nižší SSE = jemnější dlaždice načtené dřív (i z dálky), takže přiblížení není tak skokové.
    ts.maximumScreenSpaceError = 8                       // default 16 → víc detailu dřív
    ts.cacheBytes = 1024 * 1024 * 1024                   // 1 GB (default 512 MB) → míň „reload" lupnutí při návratu
    ts.maximumCacheOverflowBytes = 768 * 1024 * 1024     // dočasný přetok, ať se nezahazuje při špičce
    ts.preloadFlightDestinations = true                  // při flyTo natáhni cíl předem (default true, explicitně)
    ts.preloadWhenHidden = true                          // drž načtené i když je dočasně schované (míň reloadů)
    ts.foveatedScreenSpaceError = true                   // priorita na střed obrazovky (default true)
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

  // skryje mapu (ortofoto/topo + terén na globu i Google dlaždice) pod modely s maskou nebo uvnitř
  // vybraných parcel ('hide'). „Jen parcelu" ('only') se řeší ztlumením okolí v updateDim, ne ořezem.
  // Každý cíl (globe / Google) potřebuje vlastní instanci kolekce (nesdílet).
  // sjednotí vybrané parcely (S-JTSK) a robustně odsadí jejich vnější hranici o buffer m. Odsazení
  // NEdělá per-vrchol miter (ten se u úzkých/konkávních míst protne a začne odečítat), ale Minkowského
  // pás (kvádry na hranách + disky na vrcholech) → union (zvětšení) / difference (zmenšení), takže se
  // protínající odsazení samo srovná. Vrací world prstence pro ořez i masku.
  function parcelUnionRings(bufferM: number): Cesium.Cartesian3[][] {
    const src = [...parcelsRef.current.values()].filter(p => p.ring && p.ring.length >= 3)
    if (!src.length) return []
    const polys = src.map(p => {
      const r = p.ring.map(([lo, la]) => sjtskOf(lo, la) as [number, number])
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
      return [r] as [number, number][][]
    })
    let mp: [number, number][][][]
    try { mp = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] } catch { mp = polys }

    if (Math.abs(bufferM) > 1e-6) {
      const R = Math.abs(bufferM), seg = 12
      const band: [number, number][][][] = []
      const disc = (cx: number, cy: number): [number, number][][] => {
        const ring: [number, number][] = []
        for (let i = 0; i <= seg; i++) { const a = 2 * Math.PI * i / seg; ring.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]) }
        return [ring]
      }
      for (const poly of mp) for (const ring of poly) {
        for (let i = 0; i + 1 < ring.length; i++) { // prstenec je uzavřený (poslední == první)
          const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]
          let dx = x2 - x1, dy = y2 - y1; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L
          const nx = dy * R, ny = -dx * R
          band.push([[[x1 - nx, y1 - ny], [x2 - nx, y2 - ny], [x2 + nx, y2 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny]]])
          band.push(disc(x1, y1))
        }
      }
      if (band.length) {
        try {
          const bandMP = polygonClipping.union(band[0], ...band.slice(1))
          mp = (bufferM > 0 ? polygonClipping.union(mp, bandMP) : polygonClipping.difference(mp, bandMP)) as [number, number][][][]
        } catch (e) { console.error('Odsazení parcel selhalo:', e) }
      }
    }

    const out: Cesium.Cartesian3[][] = []
    for (const poly of mp) {
      const simp = simplifyRingCapped(poly[0].map(([x, y]) => [x, y] as [number, number]))
      if (!simp) continue
      out.push(simp.map(([x, y]) => { const [lon, lat] = wgsOf(x, y) as number[]; return Cesium.Cartesian3.fromDegrees(lon, lat) }))
    }
    return out
  }

  function updateExcavation() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const modelRings: Cesium.Cartesian3[][] = []
    for (const m of modelsRef.current.values()) if (m.excavate && m.footprint) modelRings.push(...m.footprint)
    const parcelR = parcelClip !== 'off' ? parcelUnionRings(parcelBuffer) : []
    const mk = (rings: Cesium.Cartesian3[][], inverse: boolean) => rings.length
      ? new Cesium.ClippingPolygonCollection({ polygons: rings.map(r => new Cesium.ClippingPolygon({ positions: r })), inverse })
      : undefined
    // GLOBUS (zem): model masky + (hide → parcela dovnitř). U „only" glóbus neklipe — zem ztmaví překryv.
    // „g3d": když je 3D plné (alpha ~1), schovej topo POD ním (ořez glóbu uvnitř parcely) → neprosvítá/nebliká;
    // když se 3D zprůhlední, topo necháme, ať přes něj prosvítá.
    const g3dHideTopo = parcelClip === 'g3d' && googleAlpha >= 0.95
    const globeRings = (parcelClip === 'hide' || g3dHideTopo) ? [...modelRings, ...parcelR] : [...modelRings]
    v.scene.globe.clippingPolygons = mk(globeRings, false) as Cesium.ClippingPolygonCollection
    // GOOGLE dlaždice:
    //  „g3d" → INVERZNÍ ořez na parcelu = Google se vykreslí JEN uvnitř výběru (topo zůstane všude);
    //  „only" → inverzní ořez na parcelu (okolní budovy fakt zmizí = skutečná izolace);
    //  „hide" → ořez dovnitř; jinak jen model masky.
    if (googleRef.current) {
      const gPoly =
        parcelClip === 'g3d' ? mk(parcelR, true)
          : parcelClip === 'only' ? (keep3DAround ? mk([...modelRings], false) : mk(parcelR, true))
            : mk(parcelClip === 'hide' ? [...modelRings, ...parcelR] : [...modelRings], false)
      googleRef.current.clippingPolygons = gPoly as Cesium.ClippingPolygonCollection
    }
  }

  // „Jen parcelu": ztlumí okolí poloprůhledným tmavým překryvem (díra = parcela). Alfa se animuje
  // (plynulý fade in/out) přes dimAlphaRef; materiál ji čte přes CallbackProperty.
  const dimTarget = () => (parcelClip === 'only' && parcelsRef.current.size > 0) ? Math.min(1, Math.max(0, 1 - okoliVis)) : 0
  function buildDimEntity() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null }
    const holes = parcelUnionRings(parcelBuffer).map(r => new Cesium.PolygonHierarchy(r))
    if (!holes.length) return
    const R = CR_EXTENT
    const outer = [
      Cesium.Cartesian3.fromRadians(R.west, R.south), Cesium.Cartesian3.fromRadians(R.east, R.south),
      Cesium.Cartesian3.fromRadians(R.east, R.north), Cesium.Cartesian3.fromRadians(R.west, R.north),
    ]
    dimEntityRef.current = v.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, holes),
        material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => Cesium.Color.BLACK.withAlpha(dimAlphaRef.current), false)),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
  }
  function animateDim() {
    dimTargetRef.current = dimTarget()
    if (dimRafRef.current != null) return // tween už běží, jen si přebere nový cíl
    let last = performance.now()
    const step = () => {
      const now = performance.now(), dt = (now - last) / 1000; last = now
      const cur = dimAlphaRef.current, tgt = dimTargetRef.current
      const dir = Math.sign(tgt - cur)
      dimAlphaRef.current = Math.abs(tgt - cur) < 0.02 ? tgt : cur + dir * Math.min(Math.abs(tgt - cur), dt * 3.5)
      if (dimAlphaRef.current === tgt) {
        dimRafRef.current = null
        if (tgt <= 0.001) { const v = viewerRef.current; if (v && !v.isDestroyed() && dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null } }
        return
      }
      dimRafRef.current = requestAnimationFrame(step)
    }
    dimRafRef.current = requestAnimationFrame(step)
  }
  // rebuild = přestav geometrii (změna parcel/okraje/zapnutí); jinak jen doanimuj na nový cíl
  function syncDim(rebuild: boolean) {
    if (rebuild && dimTarget() > 0) buildDimEntity()
    animateDim()
  }
  useEffect(() => { updateExcavation(); syncDim(true) }, [parcelClip, parcelBuffer, keep3DAround, googleAlpha])
  useEffect(() => { syncDim(false) }, [okoliVis])

  // ── Zvýraznění správního území (kraj/okres/obec) ──────────────────────────────────────
  // klik na mapu → stáhne vnořené jednotky obsahující bod → nabídne je k výběru
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !regionMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction(async (evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) return
      setRegionBusy(true)
      try {
        const units = await fetchAdminUnits(g.lon, g.lat)
        setRegionParts([]); setRegionChoices(units)
        if (!units.length) toast.info('Tady jsem žádné území nenašel')
      } catch (e) { console.error('Načtení území selhalo:', e); toast.error('Načtení území selhalo') }
      finally { setRegionBusy(false) }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [regionMode])

  function clearRegionEnts() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) {
      for (const e of regionEntsRef.current) v.entities.remove(e)
      if (regionDimEntRef.current) v.entities.remove(regionDimEntRef.current)
      for (const p of regionPrimsRef.current) v.scene.primitives.remove(p)
    }
    regionEntsRef.current = []; regionDimEntRef.current = null; regionPrimsRef.current = []
  }
  function clearRegion() {
    clearRegionEnts()
    regionActiveRef.current = null
    setRegionName(null); setRegionChoices([]); setRegionParts([])
  }
  // překreslí tmavý překryv okolí (díra = území) podle aktuální viditelnosti regionDim
  function drawRegionDim() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (regionDimEntRef.current) { v.entities.remove(regionDimEntRef.current); regionDimEntRef.current = null }
    const a = regionActiveRef.current
    if (!a) return
    const alpha = Math.min(1, Math.max(0, 1 - regionDim))
    if (alpha <= 0.01) return
    const R = CR_EXTENT
    const outer = [
      Cesium.Cartesian3.fromRadians(R.west, R.south), Cesium.Cartesian3.fromRadians(R.east, R.south),
      Cesium.Cartesian3.fromRadians(R.east, R.north), Cesium.Cartesian3.fromRadians(R.west, R.north),
    ]
    const holes = a.worldRings.map(r => new Cesium.PolygonHierarchy(r))
    regionDimEntRef.current = v.entities.add({
      polygon: { hierarchy: new Cesium.PolygonHierarchy(outer, holes), material: Cesium.Color.BLACK.withAlpha(alpha), classificationType: Cesium.ClassificationType.BOTH },
    })
  }
  useEffect(() => { drawRegionDim() }, [regionDim])

  // vybere jednotku: dotáhne geometrii (líně), ztlumí okolí (překryv na globu) a přeletí na ni.
  // Bez viditelné hranice — území je dané tím, že okolí zšedne (uvnitř zůstane plná mapa).
  async function isolateRegion(u: AdminUnit) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setRegionBusy(true)
    try {
      const rings = u.rings ?? await fetchAdminGeom(u.layer, u.kod)
      if (!rings.length) { toast.error('Území nemá geometrii'); return }
      if (v.isDestroyed()) return
      exclusiveSelect('region') // území aktivní → zruš parcely/oblast/dlaždice (jen jeden zdroj naráz)
      clearRegionEnts()
      const worldRings = rings.map(r => r.map(([x, y]) => { const [lo, la] = wgsOf(x, y) as number[]; return Cesium.Cartesian3.fromDegrees(lo, la) }))
      regionActiveRef.current = { name: u.name, worldRings, sjtskRings: rings }
      drawRegionDim()
      setRegionName(u.name)
      // nabídku NEcháváme otevřenou → jde rovnou vybrat jinou část/jednotku
      const all = worldRings.flat()
      if (all.length) v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(all), { duration: 1.2 })
    } catch (e) { console.error('Zobrazení území selhalo:', e); toast.error('Zobrazení území selhalo') }
    finally { setRegionBusy(false) }
  }

  // vypíše katastrální území (části) vybrané obce
  async function loadParts(obecKod: number) {
    setRegionBusy(true)
    try {
      const parts = await fetchAdminParts(obecKod)
      setRegionParts(parts)
      if (!parts.length) toast.info('Obec nemá další katastrální území')
    } catch (e) { console.error('Načtení částí selhalo:', e); toast.error('Načtení částí selhalo') }
    finally { setRegionBusy(false) }
  }

  // vyhledání území podle názvu: nejdřív přímo v RÚIAN (kraj/okres/obec/k.ú.), Nominatim jako záloha
  async function searchRegion(e: React.FormEvent) {
    e.preventDefault()
    const q = regionQuery.trim()
    if (!q || regionBusy) return
    setRegionBusy(true)
    try {
      const like = `UPPER(nazev) LIKE UPPER('%${q.replace(/'/g, "''")}%')`
      const layers: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec'], [7, 'k.ú.']]
      const found: AdminUnit[] = []
      for (const [layer, level] of layers) {
        try { for (const r of (await ruianQuery(layer, like, false)).slice(0, 15)) found.push({ level, name: r.nazev, kod: r.kod, layer }) } catch { /* přeskoč */ }
      }
      if (found.length) {
        const parts = found.filter(u => u.level === 'k.ú.')
        const choices = found.filter(u => u.level !== 'k.ú.')
        setRegionChoices(choices); setRegionParts(parts)
        if (found.length === 1) await isolateRegion(found[0]) // jediná shoda → rovnou zobraz
        return
      }
      // záloha: geokód (Nominatim) → bod → jednotky v tom bodě
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=cz&limit=1&q=${encodeURIComponent(q)}`
      const data = await (await fetch(url, { headers: { 'Accept-Language': 'cs' } })).json() as Array<{ lat: string; lon: string }>
      const hit = data[0]
      if (!hit) { toast.info('Nic nenalezeno'); return }
      const lon = Number(hit.lon), lat = Number(hit.lat)
      const v = viewerRef.current
      if (v && !v.isDestroyed()) v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 20000) })
      const units = await fetchAdminUnits(lon, lat)
      setRegionParts([]); setRegionChoices(units)
      if (!units.length) toast.info('Pro to místo jsem nenašel správní jednotky')
    } catch (err) { console.error('Vyhledání území selhalo:', err); toast.error('Vyhledání území selhalo') }
    finally { setRegionBusy(false) }
  }

  // počká, až se dokreslí terén i Google dlaždice (nebo timeout) — ať snímek není rozmazaný/nedočtený
  function waitTilesLoaded(v: Cesium.Viewer, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now()
      let stable = 0
      const tick = () => {
        if (signal.aborted) return resolve()
        const loaded = v.scene.globe.tilesLoaded && (googleRef.current ? googleRef.current.tilesLoaded : true)
        stable = loaded ? stable + 1 : 0
        if (stable >= 4 || performance.now() - start > timeoutMs) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  async function captureCanvasPng(v: Cesium.Viewer): Promise<Uint8Array> {
    v.render()
    const blob = await new Promise<Blob | null>(res => v.scene.canvas.toBlob(res, 'image/png'))
    if (!blob) throw new Error('Snímek se nepovedl (canvas)')
    return new Uint8Array(await blob.arrayBuffer())
  }

  // 4 snímky vybrané budovy ze světových stran (kamera obletí, počká na dlaždice, vyfotí) → zip PNG
  async function captureParcelViews() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    if (parcelsRef.current.size === 0) { toast.error('Vyber parcelu s budovou'); return }
    if (cutoutBusy) return
    const pts: Cesium.Cartesian3[] = []
    for (const p of parcelsRef.current.values()) if (p.positions) pts.push(...p.positions)
    if (pts.length < 3) { toast.error('Vybraná parcela nemá platný obrys'); return }
    const bs = Cesium.BoundingSphere.fromPoints(pts)
    const range = Math.max(35, bs.radius * 2.6)
    const pitch = Cesium.Math.toRadians(-18)
    const dirs = [{ n: '1_predni', h: 0 }, { n: '2_prava', h: 90 }, { n: '3_zadni', h: 180 }, { n: '4_leva', h: 270 }]
    const ac = new AbortController(); abortRef.current = ac
    setCutoutBusy(true); setCutoutPct(0); setCutoutProgress('připravuji pohledy…')
    const ents = [...parcelsRef.current.values()].flatMap(p => p.ents)
    const prevShow = ents.map(e => e.show)
    ents.forEach(e => { e.show = false }) // schovej tyrkysové zvýraznění → čisté snímky
    const prevScale = v.resolutionScale
    v.resolutionScale = (window.devicePixelRatio || 1) >= 2 ? 1.5 : 2 // ostřejší snímek
    try {
      const files: Record<string, Uint8Array> = {}
      let i = 0
      for (const d of dirs) {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        i++; setCutoutProgress(`pohled ${i}/4…`); setCutoutPct(i / 4)
        v.camera.lookAt(bs.center, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(d.h), pitch, range))
        await waitTilesLoaded(v, ac.signal, 9000)
        files[`pohled_${d.n}.png`] = await captureCanvasPng(v)
      }
      download(zipSync(files), 'pohledy_budova.zip', 'application/zip')
      toast.success('Vyvedeny 4 pohledy (PNG)')
    } catch (e) {
      if (isAbortError(e)) toast.info('Snímkování zrušeno')
      else { console.error('Snímkování selhalo:', e); toast.error(e instanceof Error ? e.message : 'Snímkování selhalo') }
    } finally {
      v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY) // uvolni kameru zpět do volného režimu
      v.resolutionScale = prevScale
      ents.forEach((e, k) => { e.show = prevShow[k] })
      abortRef.current = null; setCutoutBusy(false); setCutoutProgress(''); setCutoutPct(-1)
    }
  }

  // přepínání podkladu: ČÚZK imagery (ortofoto/ZTM/katastr na glóbu) vs Google 3D dlaždice
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const google = base === 'google'
    // „Google jen ve výběru" (parcelClip==='g3d'): podklad zůstává topo/ortofoto (google=false),
    // ale Google dlaždice se přesto načtou a zobrazí — jen je updateExcavation inverzně ořízne na parcely.
    const googleWanted = google || parcelClip === 'g3d'
    // v google režimu zůstane pod 3D vidět plochá mapa (googleUnder) → jde přes ni „prosvítat"
    const showOrto = google ? googleUnder === 'ortofoto' : base === 'ortofoto'
    const showZtm = google ? googleUnder === 'zm' : base === 'zm'
    if (ortoRef.current) ortoRef.current.show = showOrto
    for (const t of ZTM_TIERS) {
      const layer = ztmRefs.current[t.code]
      if (layer) layer.show = showZtm && t.code === ztmTier
    }
    if (katastrRef.current) katastrRef.current.show = katastrOn
    v.scene.globe.show = google ? googleUnder !== 'none' : true // 'none' = čistě 3D, glóbus schovat

    if (googleWanted) {
      setGoogleErr(null)
      setGoogleLoading(true)
      ensureGoogle(v)
        .then(ts => { if (ts) { applyGoogleAlpha(); updateExcavation() } }) // po načtení nastav i ořez (g3d)
        .catch((e: unknown) => {
          console.error('Google 3D Tiles selhalo:', e)
          // Cesium RequestErrorEvent nese statusCode; podle něj poznáme, co je vážně špatně,
          // místo abychom natvrdo hlásili „chybí asset" (což bývá nejmíň častá příčina).
          const code = (e as { statusCode?: number })?.statusCode
          const msg = e instanceof Error ? e.message : String(e)
          if (code === 401 || /401|unauthor|token/i.test(msg))
            setGoogleErr('Google 3D: ion token odmítnut (401). Zkontroluj, že token v nasazené appce je platný a nemá doménové omezení, které blokuje tuhle stránku.')
          else if (code === 404)
            setGoogleErr('Google 3D: asset 2275207 nenalezen (404) — přidej „Google Photorealistic 3D Tiles" ve svém ion účtu (Asset Depot).')
          else
            setGoogleErr(`Google 3D se nenačetlo${code ? ` (HTTP ${code})` : ''}: ${msg}`)
        })
        .finally(() => setGoogleLoading(false))
    } else if (googleRef.current) {
      googleRef.current.show = false
      googleRef.current.style = undefined
    }
  }, [base, ztmTier, katastrOn, googleUnder, parcelClip])

  // průhlednost Google 3D dlaždic (přes styl) → nižší = víc prosvítá plochá mapa pod nimi
  function applyGoogleAlpha() {
    const ts = googleRef.current
    if (!ts) return
    if (base !== 'google') {
      // „Google jen ve výběru": tvar dělá inverzní ořez (updateExcavation), průhlednost přes googleAlpha. Jinak skrýt.
      if (parcelClip === 'g3d') {
        ts.show = googleAlpha > 0.005
        ts.style = googleAlpha >= 0.995 ? undefined : new Cesium.Cesium3DTileStyle({ color: `color('white', ${googleAlpha.toFixed(3)})` })
      } else ts.show = false
      return
    }
    ts.show = googleAlpha > 0.005
    ts.style = googleAlpha >= 0.995 ? undefined : new Cesium.Cesium3DTileStyle({ color: `color('white', ${googleAlpha.toFixed(3)})` })
  }
  useEffect(() => { applyGoogleAlpha() }, [googleAlpha, base])

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

  // reset ořezu: vypni parcelový ořez, ztlumení i masky modelů → zase je vidět celá mapa (i Google 3D)
  function resetClipping() {
    const v = viewerRef.current
    for (const m of modelsRef.current.values()) m.excavate = false
    setParcelBuffer(0)
    setOkoliVis(0)
    setKeep3DAround(true)
    setParcelClip('off')
    if (v && !v.isDestroyed()) {
      v.scene.globe.clippingPolygons = undefined as unknown as Cesium.ClippingPolygonCollection
      if (googleRef.current) googleRef.current.clippingPolygons = undefined as unknown as Cesium.ClippingPolygonCollection
      if (dimRafRef.current != null) { cancelAnimationFrame(dimRafRef.current); dimRafRef.current = null }
      dimAlphaRef.current = 0
      if (dimEntityRef.current) { v.entities.remove(dimEntityRef.current); dimEntityRef.current = null }
    }
    setObjects(list => [...list]) // překreslit panel (tlačítka masek modelů)
  }

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

  // TEST: tažení splatu po terénu (posun jeho kotvy). Levé táhne splat, pravé posouvá mapu (jako dlaždice).
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !splatMove) return
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes, prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    let dragging = false
    const moveTo = (screen: Cesium.Cartesian2) => { const g = pickTerrain(v, screen); if (g) updateSplat({ lon: g.lon, lat: g.lat, groundH: g.height }) }
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => { dragging = true; cam.enableInputs = false; moveTo(e.position) }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => { if (dragging) moveTo(e.endPosition) }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const end = () => { if (dragging) { dragging = false; cam.enableInputs = true } }
    handler.setInputAction(end, Cesium.ScreenSpaceEventType.LEFT_UP)
    window.addEventListener('pointerup', end)
    return () => {
      handler.destroy(); window.removeEventListener('pointerup', end)
      if (!v.isDestroyed()) { cam.enableInputs = true; cam.rotateEventTypes = prevRotate; cam.zoomEventTypes = prevZoom }
    }
  }, [splatMove])

  // TEST: vlícovací režim — klikni bod NA SPLATU (depth buffer), pak TENTÝŽ bod NA MAPĚ (terén).
  // LEFT_CLICK (ne drag) → kamera se dá pořád normálně ovládat tažením mezi kliky.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !splatCP) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    // Splaty NEzapisují hloubku → pickPosition by vracelo terén za nimi. Proto obojí bereme jako bod
    // na TERÉNU (ray na globus): u ZEMNÍCH prvků (pata zdi, značka) je terén pod nakresleným prvkem ≈
    // aktuální světová poloha toho prvku ve splatu — spolehlivé bez závislosti na hloubce splatu.
    const mark = (w: Cesium.Cartesian3, color: Cesium.Color) => {
      cpEntsRef.current.push(v.entities.add({
        position: w,
        point: { pixelSize: 13, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }))
    }
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickTerrain(v, e.position)
      if (!g) { toast.error('Miř na terén/mapu (u země)'); return }
      const w = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      if (!cpPendingRef.current) {
        cpPendingRef.current = [w.x, w.y, w.z]; setCpPending(true) // ➊ kde prvek JE ve splatu teď
        mark(w, Cesium.Color.CYAN)
      } else {
        const from = Cesium.Cartesian3.unpack(cpPendingRef.current)
        mark(w, Cesium.Color.LIME) // ➋ kam PATŘÍ
        cpEntsRef.current.push(v.entities.add({ polyline: { positions: [from, w], width: 2, arcType: Cesium.ArcType.NONE, material: Cesium.Color.YELLOW } }))
        cpRef.current.push({ s: cpPendingRef.current, q: [w.x, w.y, w.z] })
        cpPendingRef.current = null; setCpPending(false); setCpCount(cpRef.current.length)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [splatCP])

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
    exclusiveSelect('parcel'); setParcelMode(false) // oblast plní parcely → parcely nemazat, jen ostatní
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
    if (tileMode) { setTileMode(false); setGridOn(false); return } // ať mřížka nezůstane viset bez tlačítka
    exclusiveSelect('tile') // zruš parcely/oblast/území — jen jeden zdroj výběru naráz
    setTileMode(true)
  }

  // jiná velikost = jiná mřížka; míchat čtverce dvou velikostí by dělalo překryvy
  function changeTileSize(s: TileSize) {
    if (s === tileSize) return
    clearTiles()
    setTileSize(s)
  }

  // ── Overlay mřížky dlaždic s názvy (jako kladení listů na ČÚZK) ──────────────────
  // Přepočítává se podle pohledu kamery. Aby to nezahltilo scénu, čáry i názvy mají strop:
  // moc dlaždic ve výřezu → napíšeme „přibliž" místo tisíců entit.
  const GRID_MAX_LINES = 4000  // nad tolik dlaždic nekreslíme ani čáry
  const GRID_MAX_LABELS = 400  // nad tolik jen čáry, názvy až po přiblížení

  function clearGrid() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) for (const e of gridEntsRef.current) v.entities.remove(e)
    gridEntsRef.current = []
  }

  function redrawGrid() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    clearGrid()
    if (!gridOn) { setGridNote(''); return }

    // co je vidět (obdélník lon/lat); při pohledu k horizontu je undefined
    const rect = v.camera.computeViewRectangle(v.scene.globe.ellipsoid)
    if (!rect) { setGridNote('Naklop kameru na mapu'); return }
    const wLon = Cesium.Math.toDegrees(rect.west), eLon = Cesium.Math.toDegrees(rect.east)
    const sLat = Cesium.Math.toDegrees(rect.south), nLat = Cesium.Math.toDegrees(rect.north)

    // rohy výřezu do S-JTSK → obálka v Křováku (mřížka je zarovnaná na S-JTSK)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [lo, la] of [[wLon, sLat], [eLon, sLat], [eLon, nLat], [wLon, nLat]] as [number, number][]) {
      const [x, y] = sjtskOf(lo, la)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const size = tileSize
    const ix0 = Math.floor(minX / size), ix1 = Math.floor(maxX / size)
    const iy0 = Math.floor(minY / size), iy1 = Math.floor(maxY / size)
    const nx = ix1 - ix0 + 1, ny = iy1 - iy0 + 1
    const count = nx * ny
    if (count <= 0 || count > GRID_MAX_LINES) { setGridNote(count > GRID_MAX_LINES ? 'Přibliž pro zobrazení mřížky' : ''); return }

    // přímka v S-JTSK je ve WGS84 mírně zakřivená → zhustit body na hranách buněk
    const linePts = (x0: number, y0: number, x1: number, y1: number, seg: number) => {
      const out: Cesium.Cartesian3[] = []
      for (let k = 0; k <= seg; k++) { const t = k / seg; const [lo, la] = wgsOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); out.push(Cesium.Cartesian3.fromDegrees(lo, la)) }
      return out
    }
    const gridColor = MODEL_GLOW.withAlpha(0.55)
    // svislé čáry mřížky (na každé hranici ix)
    for (let ix = ix0; ix <= ix1 + 1; ix++) {
      gridEntsRef.current.push(v.entities.add({
        polyline: { positions: linePts(ix * size, iy0 * size, ix * size, (iy1 + 1) * size, ny + 1), width: 1, material: gridColor, clampToGround: true },
      }))
    }
    // vodorovné čáry mřížky (na každé hranici iy)
    for (let iy = iy0; iy <= iy1 + 1; iy++) {
      gridEntsRef.current.push(v.entities.add({
        polyline: { positions: linePts(ix0 * size, iy * size, (ix1 + 1) * size, iy * size, nx + 1), width: 1, material: gridColor, clampToGround: true },
      }))
    }

    // názvy do středů buněk — jen když jich není moc, jinak by se překrývaly a brzdily
    if (count > GRID_MAX_LABELS) { setGridNote(`${count} dlaždic — přibliž pro názvy`); return }
    setGridNote('')
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const [lo, la] = wgsOf((ix + 0.5) * size, (iy + 0.5) * size)
        gridEntsRef.current.push(v.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lo, la),
          label: {
            text: `${ix}, ${iy}`,
            font: 'bold 12px monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2000, 1.0, 30000, 0.5),
          },
        }))
      }
    }
  }

  // překresli mřížku při zapnutí, změně velikosti dlaždice a po každém pohybu kamery
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    redrawGrid()
    if (!gridOn) return
    const off = () => redrawGrid()
    v.camera.moveEnd.addEventListener(off)
    return () => { v.camera.moveEnd.removeEventListener(off); clearGrid() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, tileSize])

  /**
   * Hranice parcel (katastr) pro obálku dlaždic → DXF v REÁLNÉM S-JTSK, výšky z DMR.
   * Sedí to na terén i OBJ bez přepočtu: WFS vrací parcely rovnou v EPSG:5514 (stejná soustava
   * jako vrcholy dlaždic) a DMR výšky jsou Bpv (stejné jako Z terénu). Vrací DXF text + počet parcel.
   */
  /**
   * Jádro katastru: parcely v S-JTSK obálce → 3D křivky (raw S-JTSK, výšky z DMR). Volitelný
   * `filter` (S-JTSK polygony území) nechá jen parcely, jejichž těžiště leží uvnitř. Vrací i
   * vzorkovač výšek `sampleZ`, aby na týž terén šel drapovat i obrys území ve stejném rámci.
   */
  async function fetchKatastrPolylines(minX: number, minY: number, maxX: number, maxY: number, filter?: [number, number][][]):
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

  async function fetchKatastrDxf(minX: number, minY: number, maxX: number, maxY: number): Promise<{ dxf: string; count: number } | null> {
    const r = await fetchKatastrPolylines(minX, minY, maxX, maxY)
    return r ? { dxf: buildDxf(r.polylines), count: r.count } : null
  }

  /**
   * Vyveze vybrané dlaždice jako zip: teren.obj + teren.mtl + JPEG na dlaždici.
   * Každá dlaždice = vlastní objekt s vlastním materiálem, souřadnice v rovině S-JTSK
   * mínus zadaný posun (viz buildTileObj). 3ds Max importuje OBJ nativně i s texturami.
   */
  async function exportTilesObj() {
    const tiles = [...tilesRef.current.values()].map(t => t.tile)
    if (!tiles.length || tileBusy) return
    const ac = new AbortController()
    abortRef.current = ac
    setTileBusy(true)
    setTilePct(0)
    setTileProgress(`0/${tiles.length}`)
    try {
      let done = 0
      const fetched = await pool(tiles, 3, async tile => {
        const [grid, jpg] = await Promise.all([fetchTileHeights(tile, meshStep, ac.signal), fetchTileOrtho(tile, texSize, ac.signal)])
        done++
        setTilePct(done / tiles.length)
        setTileProgress(`${done}/${tiles.length}`)
        return { tile, grid, jpg }
      })
      setTilePct(-1)
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
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        objF.push(strToU8(buildTileObj(f.tile, f.grid, off, fallbackH, vBase) + '\n'), false)
        vBase += f.grid.n * f.grid.n
        check()
        if (++built % 5 === 0 || built === fetched.length) {
          setTilePct(built / fetched.length)
          setTileProgress(`skládám ${built}/${fetched.length}`)
          await new Promise(r => setTimeout(r, 0)) // pustit UI k slovu
        }
      }
      // volitelně: budovy ČÚZK (výška i tvar střechy z DMR5G/DMP1G) jako samostatný objekt „budovy"
      let buildingsLine = 'Budovy: ne'
      let hasBuildings = false
      if (exportBuildings) {
        setTilePct(-1)
        setTileProgress('budovy…')
        try {
          const bch = await buildingsObjChunk(minX, minY, maxX, maxY, vBase, ac.signal)
          if (bch.obj) { objF.push(strToU8(bch.obj), false); check(); vBase += bch.vCount; hasBuildings = true }
          buildingsLine = bch.line
        } catch (e) {
          if (isAbortError(e)) throw e
          console.error('Budovy do exportu selhaly:', e); buildingsLine = 'Budovy: stažení selhalo (viz konzole)'
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
      addText('teren.mtl', buildMtl(tiles) + (hasBuildings ? '\n' + BUILDING_MTL : ''))
      addText('vray_material.ms', buildMaxScript(tiles))

      // volitelně: hranice parcel (katastr) jako DXF křivky v témže S-JTSK rámci
      let katastrLine = 'Katastr: ne'
      if (exportKatastr) {
        setTilePct(-1)
        setTileProgress('katastr…')
        try {
          const k = await fetchKatastrDxf(minX, minY, maxX, maxY)
          if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
          if (k) { addText('katastr.dxf', k.dxf); katastrLine = `Katastr: katastr.dxf (${k.count} parcel, hranice jako 3D křivky)` }
          else katastrLine = 'Katastr: v oblasti nenalezeny žádné parcely'
        } catch (e) {
          if (isAbortError(e)) throw e
          console.error('Katastr do exportu selhal:', e); katastrLine = 'Katastr: stažení selhalo (viz konzole)'
        }
      }

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
        katastrLine,
        buildingsLine,
        'Budovy (je-li): objekt „budovy" = půdorysy ČÚZK, výška z DMP1G−DMR5G, střecha',
        'rozpoznaná (plochá/sedlová/valbová) jako čistá low-poly hmota, hnědý materiál bez textury.',
        'Y je mřížkový sever Křováku, ne pravý sever (meridiánová konvergence ~7°).',
        '',
        'katastr.dxf (je-li): hranice parcel jako uzavřené 3D křivky (DXF R12), stejný S-JTSK',
        'rámec i výšky jako terén → v Maxu lícuje. Import: File > Import > katastr.dxf.',
        '',
        `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
      ].join('\n'))

      zip.end()
      check()
      download(concatBytes(chunks), `teren_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
      toast.success(`Vyvezeno ${tiles.length}× dlaždice ${tileSize} m s ortofotem`)
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error('Export dlaždic selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export dlaždic selhal')
    } finally {
      abortRef.current = null
      setTileBusy(false)
      setTileProgress('')
      setTilePct(-1)
    }
  }

  // Spojená 2D mapa přes obálku výběru: ortofoto i topo mapa jako jeden georeferencovaný obrázek.
  // Stahuje se po velkých blocích (ne po dlaždicích) → stylovaná topo mapa nemá ořezané popisky
  // na švech. Výsledek je zastropovaný (paměť canvasu); u velké oblasti klesne rozlišení.
  const STITCH_CHUNK_PX = 4096  // strop ČÚZK REST na jeden požadavek
  const STITCH_RES_M = 0.2      // cílové rozlišení (ortofoto má nativně 20 cm/px)
  const STITCH_MAX_AREA = 16384 * 16384 // pojistka na paměť canvasu (~1 GB), ať to nespadne
  const TOPO_MAX_PX = 4096      // topo mapa je jen orientační podklad → vždy menší (a ZTM míň zlobí)

  /**
   * Stáhne jeden blok mapy jako ImageBitmap — s ověřením a opakováním. ČÚZK ArcGIS (hlavně ZTM)
   * u větších/paralelních požadavků občas vrátí 200 s prázdným (bílým) obrázkem. Velikost je na
   * detekci nepoužitelná (chyba mívá i 3 MB, reálný list i 10 kB), spolehlivé je jen to, že prázdná
   * mapa je JEDNOLITÁ plocha → zmenšíme na 16×16 a změříme rozptyl. Reálná mapa má obrovský.
   */
  async function loadMapChunk(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
    const probe = document.createElement('canvas'); probe.width = 16; probe.height = 16
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (signal?.aborted) throw new DOMException('Zrušeno', 'AbortError')
      try {
        const res = await fetch(url, { signal })
        const ct = res.headers.get('content-type') || ''
        if (!res.ok || !ct.startsWith('image/')) throw new Error(`HTTP ${res.status} (${ct || 'bez typu'})`)
        const bmp = await createImageBitmap(await res.blob())
        if (pctx) {
          pctx.clearRect(0, 0, 16, 16)
          pctx.drawImage(bmp, 0, 0, 16, 16)
          const d = pctx.getImageData(0, 0, 16, 16).data
          let mn = 255, mx = 0
          for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; if (v < mn) mn = v; if (v > mx) mx = v }
          if (mx - mn < 6) { bmp.close?.(); throw new Error('prázdný/jednolitý obrázek (výpadek ČÚZK)') }
        }
        return bmp
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e // uživatel zrušil → nezkoušet znovu
        lastErr = e
        if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt)) // narůstající pauza
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  // Stáhne ortofoto vybrané oblasti NATRVALO do prohlížeče (IndexedDB, připnuté). Používá GEOGRAPHIC
  // dlaždice STEJNÉ soustavy jako WMS (klíč owms/level/x/y) → po stažení se ta oblast bere z cache,
  // Znovu vytvoří ortofoto vrstvu → Cesium přepošle žádosti o dlaždice (napečené se hned vezmou z localu,
  // bez nutnosti popojet/refreshovat). Zachová pozici ve stacku i viditelnost.
  function refreshOrtoLayer() {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !ortoRef.current) return
    const layers = v.scene.imageryLayers
    const idx = layers.indexOf(ortoRef.current)
    const show = ortoRef.current.show
    layers.remove(ortoRef.current, true)
    const layer = layers.addImageryProvider(ortofotoProvider(), idx >= 0 ? idx : undefined)
    layer.show = show
    ortoRef.current = layer
  }

  // Smaže celou lokální mapu (napečené dlaždice) → zpět na živé ČÚZK.
  function clearBaked() {
    bakedClear().then(() => { bakedKeys.clear(); setBakedInfo(0); refreshOrtoLayer() }).catch(() => {})
  }

  // Jádro „Načíst 2D lokálně": pro danou lon/lat obálku NAPEČE ortofoto DLAŽDICE (pyramidu) do localu
  // v nativním rozlišení. Používá STEJNOU GeographicTilingScheme jako WMS zobrazení (klíč owms/L/x/y),
  // takže se napečené dlaždice zobrazí přesně na svém místě a dekódují se identicky jako živé WMS.
  // Úrovně 12..18 (18 ≈ 15 cm/px, nad nativem ortofota 20 cm); maxLevel se sníží, aby počet dlaždic
  // nepřekročil strop. Kvalita se NEZHORŠUJE s velikostí (načítá se jen viditelné). Jednorázové,
  // zrušitelné, RESUMABLE (co je napečené, znovu nestahuje), uložené natrvalo (přežije refresh/offline).
  async function bakeAreaPyramid(minLon: number, minLat: number, maxLon: number, maxLat: number) {
    const v = viewerRef.current
    const provider = ortoRef.current?.imageryProvider
    if (!v || v.isDestroyed() || tileBusy) return
    if (!(provider instanceof CachedWmsOrtho)) { toast.error('Lokální mapa není v tomto režimu k dispozici'); return }
    if (!(maxLon > minLon && maxLat > minLat)) { toast.error('Neplatná oblast'); return }
    const ts = provider.tilingScheme as Cesium.GeographicTilingScheme
    const sw = Cesium.Cartographic.fromDegrees(minLon, minLat), ne = Cesium.Cartographic.fromDegrees(maxLon, maxLat)
    const MIN_LEVEL = 12, CAP = 12000
    const rangeAt = (level: number) => {
      const a = ts.positionToTileXY(sw, level), b = ts.positionToTileXY(ne, level)
      if (!a || !b) return null
      return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) }
    }
    const countTo = (top: number) => { let n = 0; for (let L = MIN_LEVEL; L <= top; L++) { const r = rangeAt(L); if (r) n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) } return n }
    let maxLevel = 18
    while (maxLevel > 14 && countTo(maxLevel) > CAP) maxLevel-- // velká oblast → o úroveň hrubší, ať to nezabije ČÚZK/disk
    const list: { x: number; y: number; level: number }[] = []
    for (let L = MIN_LEVEL; L <= maxLevel; L++) { const r = rangeAt(L); if (!r) continue; for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) list.push({ x, y, level: L }) }
    if (!list.length) { toast.error('Oblast nemá dlaždice'); return }
    const cmpx = (180 / Math.pow(2, maxLevel)) / WMS_TILE * 111320 * 100 // ~cm/px v zeměpisné šířce na maxLevel

    const ac = new AbortController(); abortRef.current = ac
    setTileBusy(true); setTilePct(0); setTileProgress(`0/${list.length} dlaždic…`)
    let done = 0, fail = 0, added = 0
    try {
      await pool(list, 4, async ({ x, y, level }) => {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        const key = `owms/${level}/${x}/${y}`
        if (!bakedKeys.has(key)) {
          let bytes = await bakedGet(key) // resumable: co je napečené, znovu nestahuj
          if (!bytes) {
            const rct = ts.tileXYToRectangle(x, y, level)
            const url = orthoExport4326Url(Cesium.Math.toDegrees(rct.west), Cesium.Math.toDegrees(rct.south), Cesium.Math.toDegrees(rct.east), Cesium.Math.toDegrees(rct.north), WMS_TILE)
            bytes = await fetchOrthoUrl(url, ac.signal)
          }
          if (bytes) { await bakedPut(key, bytes); bakedKeys.add(key); added++ } else fail++
        }
        done++
        if (done % 20 === 0 || done === list.length) { setTilePct(done / list.length); setTileProgress(`${done}/${list.length} dlaždic…`) }
      })
      setBakedInfo(bakedKeys.size)
      refreshOrtoLayer() // napečené dlaždice se hned použijí bez pan/refresh
      toast.success(`Lokální mapa napečena: ${added} dlaždic (~${cmpx.toFixed(0)} cm/px, z${maxLevel})${fail ? ` — ${fail} selhalo, pusť znovu` : ''}. Uloženo, přežije refresh.`)
    } catch (e) {
      setBakedInfo(bakedKeys.size)
      if (isAbortError(e)) toast.info(`Napékání zrušeno (${added} dlaždic zůstává uloženo)`)
      else { console.error('Napékání lokální mapy selhalo:', e); toast.error('Napékání selhalo') }
    } finally {
      abortRef.current = null; setTileBusy(false); setTileProgress(''); setTilePct(-1)
    }
  }

  // lokální mapa z VÝBĚRU DLAŽDIC (obálka S-JTSK dlaždic → lon/lat)
  async function loadLocal2DMap() {
    const tiles = [...tilesRef.current.values()].map(t => t.tile)
    if (!tiles.length || tileBusy) return
    let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
    for (const t of tiles) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
    const minXm = ix0 * tileSize, maxXm = (ix1 + 1) * tileSize, minYm = iy0 * tileSize, maxYm = (iy1 + 1) * tileSize
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const [x, y] of [[minXm, minYm], [maxXm, minYm], [maxXm, maxYm], [minXm, maxYm]] as [number, number][]) {
      const [lo, la] = wgsOf(x, y)
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
    }
    await bakeAreaPyramid(minLon, minLat, maxLon, maxLat)
  }

  // lokální mapa z VYHLEDANÉHO ÚZEMÍ (obálka prstenců území v S-JTSK → lon/lat)
  async function loadRegionLocal2D() {
    const a = regionActiveRef.current
    if (!a || tileBusy) return
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const ring of a.sjtskRings) for (const [x, y] of ring) {
      const [lo, la] = wgsOf(x, y)
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la)
    }
    await bakeAreaPyramid(minLon, minLat, maxLon, maxLat)
  }

  // ── TEST: Gaussian splat (Kryry) přes Cesium ion ──
  // Splat přijde v NÁHODNÉ lokální soustavě → posadíme přes buildMatrix (ENU + hpr + scale) na věž a
  // uživatel doladí měřítko/otočení/výšku ručně (přesný georef by chtěl kontrolní body).
  function applySplatMatrix(p: Placement) {
    if (splatRef.current) splatRef.current.modelMatrix = buildMatrix(p, Cesium.Cartesian3.ZERO)
  }
  function updateSplat(part: Partial<Placement>) {
    setSplatP(p => { const np = { ...p, ...part }; applySplatMatrix(np); return np })
  }
  async function loadSplat(fly = true) {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || splatRef.current || splatLoading) return
    setSplatLoading(true)
    try {
      const ts = await Cesium.Cesium3DTileset.fromIonAssetId(SPLAT_ASSET_ID)
      if (v.isDestroyed()) return
      v.scene.primitives.add(ts)
      splatRef.current = ts
      applySplatMatrix(splatP)
      setSplatOn(true); setSplatShow(true)
      try { localStorage.setItem(SPLAT_ON_KEY, '1') } catch { /* ignore */ } // ať se po restartu načte sám
      if (fly) {
        v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(SPLAT_ANCHOR.lon, SPLAT_ANCHOR.lat, SPLAT_ANCHOR.h + GEOID_CZ + 500) })
        toast.success('Splat načten (Kryry). Dolaď měřítko/otočení/výšku vpravo.')
      }
    } catch (e) { console.error('Splat load selhal:', e); if (fly) toast.error('Splat se nepodařilo načíst (asset ID / ion token / přístup k assetu?)') }
    finally { setSplatLoading(false) }
  }
  function removeSplat() {
    const v = viewerRef.current
    if (splatRef.current && v && !v.isDestroyed()) { try { v.scene.primitives.remove(splatRef.current) } catch { /* už není */ } }
    splatRef.current = null; setSplatOn(false); setSplatMove(false); setSplatCP(false); cpRef.current = []; cpPendingRef.current = null; setCpCount(0); setCpPending(false); clearCpEnts()
    try { localStorage.removeItem(SPLAT_ON_KEY) } catch { /* ignore */ } // po odebrání se sám nenačte
  }
  function flyToSplat() {
    const v = viewerRef.current
    if (v && !v.isDestroyed() && splatRef.current) v.flyTo(splatRef.current, { duration: 1.2 }).catch(() => {})
  }
  function toggleSplatShow() { setSplatShow(s => { const nv = !s; if (splatRef.current) splatRef.current.show = nv; return nv }) }
  // Snap na Kryry + odhad rozumné velikosti (z bounding sphere → cíl ~40 m poloměr) + narovnání.
  // Dobrý výchozí bod, když splat lítá / je obří / mrňavý.
  function resetSplat() {
    const ts = splatRef.current, v = viewerRef.current
    if (!ts || !v || v.isDestroyed()) return
    let scale = splatP.scale
    const r = ts.boundingSphere?.radius ?? 0
    if (r > 0 && splatP.scale > 0) { const localR = r / splatP.scale; if (localR > 1e-6) scale = 40 / localR }
    const np: Placement = { lon: SPLAT_ANCHOR.lon, lat: SPLAT_ANCHOR.lat, groundH: SPLAT_ANCHOR.h + GEOID_CZ, heightOffset: 0, heading: 0, pitch: 0, roll: SPLAT_BASE_ROLL, scale }
    setSplatP(np); applySplatMatrix(np)
    v.flyTo(ts, { duration: 1.0 }).catch(() => {})
  }
  // uloží ruční usazení splatu (přežije refresh; splat se pak načte rovnou zarovnaný)
  function saveSplat() {
    try { localStorage.setItem(SPLAT_PLACEMENT_KEY, JSON.stringify(splatP)); toast.success('Usazení splatu uloženo — přežije refresh.') }
    catch { toast.error('Uložení selhalo') }
  }
  function clearCpEnts() {
    const v = viewerRef.current
    if (v && !v.isDestroyed()) for (const e of cpEntsRef.current) v.entities.remove(e)
    cpEntsRef.current = []
  }
  function clearCP() { cpRef.current = []; cpPendingRef.current = null; setCpPending(false); setCpCount(0); clearCpEnts() }
  // z nasbíraných dvojic spočítá similarity transformaci (Umeyama/Horn) a přemístí splat co nejblíž.
  function computeCP() {
    const pairs = cpRef.current
    if (pairs.length < 3) { toast.error('Potřebuju aspoň 3 body'); return }
    const sol = solveSimilarity(pairs.map(p => p.s), pairs.map(p => p.q))
    if (!sol) { toast.error('Body jsou v přímce/degenerované — vyber je rozházené a v různých výškách'); return }
    const { c, R, t, rms } = sol
    // C (svět→svět): q = c·R·s + t  (Matrix4 konstruktor = row-major argumenty)
    const C = new Cesium.Matrix4(
      c * R[0], c * R[1], c * R[2], t[0],
      c * R[3], c * R[4], c * R[5], t[1],
      c * R[6], c * R[7], c * R[8], t[2],
      0, 0, 0, 1,
    )
    const M0 = buildMatrix(splatP, Cesium.Cartesian3.ZERO)
    const M1 = Cesium.Matrix4.multiply(C, M0, new Cesium.Matrix4()) // nová modelMatrix = C·M0
    // rozklad M1 → Placement (aby posuvníky dál seděly)
    const t1 = Cesium.Matrix4.getTranslation(M1, new Cesium.Cartesian3())
    const carto = Cesium.Cartographic.fromCartesian(t1)
    if (!carto) { toast.error('Rozklad polohy selhal'); return }
    const scl = Cesium.Matrix4.getScale(M1, new Cesium.Cartesian3())
    const c1 = (scl.x + scl.y + scl.z) / 3
    const R3 = Cesium.Matrix4.getMatrix3(M1, new Cesium.Matrix3())
    Cesium.Matrix3.multiplyByScalar(R3, 1 / c1, R3) // odstraň měřítko → čistá rotace
    const rigid = Cesium.Matrix4.fromRotationTranslation(R3, t1, new Cesium.Matrix4())
    const hpr = Cesium.Transforms.fixedFrameToHeadingPitchRoll(rigid)
    const np: Placement = {
      lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude),
      groundH: carto.height, heightOffset: 0,
      heading: Cesium.Math.toDegrees(hpr.heading), pitch: Cesium.Math.toDegrees(hpr.pitch), roll: Cesium.Math.toDegrees(hpr.roll),
      scale: c1,
    }
    setSplatP(np); applySplatMatrix(np)
    clearCP() // splat se posunul → staré značky/body zahoď (klidně naklikej další kolo)
    toast.success(`Zarovnáno z ${pairs.length} bodů (odchylka ~${rms.toFixed(2)} m). Zbytek dolaď ručně a ulož.`)
  }

  async function exportStitchedMaps() {
    const tiles = [...tilesRef.current.values()].map(t => t.tile)
    if (!tiles.length || tileBusy) return
    const ac = new AbortController()
    abortRef.current = ac
    setTileBusy(true)
    setTilePct(0)
    setTileProgress('mapa…')
    try {
      // S-JTSK obálka výběru (dlaždice jsou souvislé čtverce)
      let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
      for (const t of tiles) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
      const minX = ix0 * tileSize, maxX = (ix1 + 1) * tileSize
      const minY = iy0 * tileSize, maxY = (iy1 + 1) * tileSize
      await stitchMapsCore(minX, minY, maxX, maxY, ac.signal, (d, t, m) => { setTilePct(d / t); setTileProgress(m) })
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error('Export spojené mapy selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export mapy selhal')
    } finally {
      abortRef.current = null
      setTileBusy(false)
      setTileProgress('')
      setTilePct(-1)
    }
  }


  // spojená 2D mapa (ortofoto + topo) pro vybrané správní území — přes obálku území
  async function exportRegionMaps() {
    const a = regionActiveRef.current
    if (!a || cutoutBusy) { if (!a) toast.error('Nejdřív vyber a zobraz území'); return }
    const ac = new AbortController(); abortRef.current = ac
    setCutoutBusy(true); setCutoutPct(0); setCutoutProgress('mapa…')
    try {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const r of a.sjtskRings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
      // ořez přesně na tvar území (jako výřez terénu) → PNG s alfou, okolí průhledné
      await stitchMapsCore(minX, minY, maxX, maxY, ac.signal, (d, t, m) => { setCutoutPct(d / t); setCutoutProgress(m) }, a.sjtskRings)
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error('Export mapy území selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export mapy selhal')
    } finally {
      abortRef.current = null
      setCutoutBusy(false)
      setCutoutProgress('')
      setCutoutPct(-1)
    }
  }

  // jádro spojené 2D mapy (ortofoto + topo) přes zadanou S-JTSK obálku → zip s georef. obrázky (world file).
  // `clip` (S-JTSK prstence) = ořezat výstup přesně na ten tvar (průhledno kolem) → ortofoto pak jde
  // do PNG s alfou (JPEG průhlednost neumí), stejně jako výřez terénu. World file zůstává na obálce.
  async function stitchMapsCore(minX: number, minY: number, maxX: number, maxY: number, signal: AbortSignal, report: (done: number, total: number, msg: string) => void, clip?: [number, number][][]) {
      const spanX = maxX - minX, spanY = maxY - minY
      const tier = pickTopoTier(Math.max(spanX, spanY))
      const clipMode = !!(clip && clip.length)

      // Rozměr výstupu na vrstvu: ortofoto je hlavní (plný strop), topo jen orientační podklad
      // (menší strop) → míň/menší ZTM požadavků = rychlejší a spolehlivější (ZTM zlobí nejvíc).
      const dims = (cap: number) => {
        const nW = spanX / STITCH_RES_M, nH = spanY / STITCH_RES_M
        let sc = Math.min(1, cap / Math.max(nW, nH))
        if (nW * sc * nH * sc > STITCH_MAX_AREA) sc = Math.sqrt(STITCH_MAX_AREA / (nW * nH))
        return { W: Math.max(1, Math.round(nW * sc)), H: Math.max(1, Math.round(nH * sc)), sc }
      }
      const bounds = (len: number, n: number) => Array.from({ length: n + 1 }, (_, i) => Math.round(i * len / n))

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D kontext se nepodařilo získat')

      const files: Record<string, Uint8Array | [Uint8Array, { level: number }]> = {}
      const toBytes = async (mime: string, quality?: number): Promise<Uint8Array> => {
        const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, mime, quality))
        if (!blob) throw new Error('canvas.toBlob selhal')
        return new Uint8Array(await blob.arrayBuffer())
      }

      // ve výřezovém režimu musí i ortofoto nést alfu → PNG (.png/.pgw); jinak zůstává úsporný JPEG
      const layers: { layer: MapLayer; file: string; mime: string; wfile: string; cap: number; q?: number }[] = [
        clipMode
          ? { layer: 'ortofoto', file: 'ortofoto.png', mime: 'image/png', wfile: 'ortofoto.pgw', cap: stitchMax }
          : { layer: 'ortofoto', file: 'ortofoto.jpg', mime: 'image/jpeg', wfile: 'ortofoto.jgw', cap: stitchMax, q: 0.9 },
        { layer: 'topo', file: 'topografie.png', mime: 'image/png', wfile: 'topografie.pgw', cap: TOPO_MAX_PX },
      ]
      // spočítej celkový počet bloků pro průběh
      const layerPlan = layers.map(L => { const d = dims(L.cap); return { L, ...d, nCols: Math.ceil(d.W / STITCH_CHUNK_PX), nRows: Math.ceil(d.H / STITCH_CHUNK_PX) } })
      let done = 0
      const total = layerPlan.reduce((s, p) => s + p.nCols * p.nRows, 0)
      const meta: Record<string, { W: number; H: number; cm: number; native: boolean }> = {}

      for (const { L, W, H, sc, nCols, nRows } of layerPlan) {
        canvas.width = W; canvas.height = H
        ctx.clearRect(0, 0, W, H)
        const cx = bounds(W, nCols), cy = bounds(H, nRows)
        const chunks: { c: number; r: number }[] = []
        for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) chunks.push({ c, r })
        // souběh jen 2 — ČÚZK ArcGIS je při paralelní zátěži nespolehlivý (proto ty výpadky)
        const imgs = await pool(chunks, 2, async ({ c, r }) => {
          const pxW = cx[c + 1] - cx[c], pxH = cy[r + 1] - cy[r]
          // blok v S-JTSK (pixelové hranice → poměrná část obálky); sever = horní okraj
          const bx0 = minX + spanX * cx[c] / W, bx1 = minX + spanX * cx[c + 1] / W
          const by1 = maxY - spanY * cy[r] / H, by0 = maxY - spanY * cy[r + 1] / H
          const bmp = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, pxW, pxH, L.layer, tier), signal)
          done++
          report(done, total, `mapa ${done}/${total}`)
          return { c, r, bmp, pxW, pxH }
        })
        for (const { c, r, bmp, pxW, pxH } of imgs) { ctx.drawImage(bmp, cx[c], cy[r], pxW, pxH); bmp.close?.() }
        if (clipMode) {
          // ořez na tvar: nakresli polygon(y) území a nech jen to, co je uvnitř (zbytek průhledný)
          ctx.save()
          ctx.globalCompositeOperation = 'destination-in'
          ctx.beginPath()
          for (const ring of clip!) {
            ring.forEach(([x, y], k) => {
              const px = (x - minX) / spanX * W, py = (maxY - y) / spanY * H
              if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
            })
            ctx.closePath()
          }
          ctx.fillStyle = '#000'
          ctx.fill('evenodd') // even-odd zvládne i díry / více oddělených částí území
          ctx.restore()
        }
        files[L.file] = [await toBytes(L.mime, L.q), { level: 0 }] // obrázky už komprimované
        // world file (na vlastní rozměr vrstvy): pixel → S-JTSK, levý-horní pixel = SZ roh
        const psX = spanX / W, psY = spanY / H
        files[L.wfile] = strToU8([psX, 0, 0, -psY, minX + psX / 2, maxY - psY / 2].map(n => n.toFixed(6)).join('\n') + '\n')
        meta[L.layer] = { W, H, cm: spanX / W * 100, native: sc >= 1 }
      }

      const o = meta.ortofoto, tp = meta.topo
      const ortoName = layers[0].file
      files['info.txt'] = strToU8([
        'Spojená mapa (ČÚZK) — ortofoto + topografická mapa',
        ...(clipMode ? ['Ořezáno na tvar území (okolí průhledné) — ortofoto je PNG s alfou.'] : []),
        '',
        `Oblast S-JTSK (EPSG:5514): X ${minX} … ${maxX}, Y ${minY} … ${maxY}`,
        `Rozsah: šířka ${spanX.toFixed(0)} m, výška ${spanY.toFixed(0)} m`,
        '',
        `${ortoName.padEnd(15)}${o.W} × ${o.H} px, ${o.cm.toFixed(1)} cm/px${o.native ? ' (nativní)' : ' (zmenšeno kvůli stropu; menší výběr = ostřejší)'}`,
        `topografie.png: ${tp.W} × ${tp.H} px, ${tp.cm.toFixed(1)} cm/px — jen orientační podklad (${tier})`,
        '',
        'Obě vrstvy kryjí STEJNOU oblast, jen v jiném rozlišení — georeference je ve',
        'world file (.jgw/.pgw) v S-JTSK, takže při stejné velikosti na scéně lícují.',
        clipMode
          ? 'Výřez i world file mají STEJNOU obálku → v AE dej obě na plane přes celou oblast, alfa udělá tvar.'
          : 'GIS/CAD je umístí sám; v AE/Max dej každou na plane přes celou oblast.',
        '',
        `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
      ].join('\n'))

      const zipped = zipSync(files as Parameters<typeof zipSync>[0], { level: 6 })
      download(zipped, `mapa_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
      toast.success(`Spojená mapa: ortofoto ${o.W}×${o.H} px + topo ${tp.W}×${tp.H} px`)
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
      show: parcelHl,
      polygon: { hierarchy: new Cesium.PolygonHierarchy(parcel.positions), material: Cesium.Color.CYAN.withAlpha(0.25), classificationType: Cesium.ClassificationType.BOTH },
    })
    const border = v.entities.add({
      show: parcelHl,
      polyline: { positions: [...parcel.positions, parcel.positions[0]], width: 3, material: Cesium.Color.CYAN, clampToGround: true },
    })
    parcelsRef.current.set(pid, { positions: parcel.positions, ring, ents: [fill, border] })
    upsertObj({ id: `parcel-${pid}`, kind: 'parcel', name: `Parcela ${parcel.id || ''}`.trim(), visible: true })
    setParcelCount(parcelsRef.current.size)
    if (parcelClip !== 'off') { updateExcavation(); syncDim(true) } // ořez i ztlumení sledují výběr parcel
  }

  function removeParcel(pid: string) {
    const v = viewerRef.current
    const p = parcelsRef.current.get(pid)
    if (p && v && !v.isDestroyed()) p.ents.forEach(e => v.entities.remove(e))
    parcelsRef.current.delete(pid)
    removeObj(`parcel-${pid}`)
    setParcelCount(parcelsRef.current.size)
    if (parcelClip !== 'off') { updateExcavation(); syncDim(true) }
  }

  function clearAllParcels() {
    for (const pid of [...parcelsRef.current.keys()]) removeParcel(pid)
    if (parcelClip !== 'off') setParcelClip('off') // vypni ořez i ztlumení (effect přepočítá)
  }

  // zap/vyp tyrkysové zvýraznění vybraných parcel (výběr i ořez/ztlumení zůstávají) → koukat „načisto"
  function toggleParcelHighlight() {
    const nv = !parcelHl
    for (const p of parcelsRef.current.values()) for (const e of p.ents) e.show = nv
    setParcelHl(nv)
  }

  async function exportParcelsDxf() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    await exportDxfRings([...parcelsRef.current.values()].map(p => p.ring.map(([lo, la]) => [lo, la] as [number, number])))
  }

  // hranice vybraného správního území jako uzavřená 3D křivka (DXF), drapovaná na DMR
  async function exportRegionDxf() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    await exportDxfRings(a.sjtskRings.map(r => r.map(([x, y]) => wgsOf(x, y) as [number, number])))
  }

  /**
   * Katastr vyhledaného území jako DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys
   * území (hladina HRANICE_UZEMI) v jednom výkresu. Reálné S-JTSK (EPSG:5514), výšky Bpv z DMR —
   * stejný rámec jako „Terén (OBJ)" i export dlaždic, takže v CADu / 3ds Max lícuje s terénem.
   */
  async function exportRegionKatastrDxf() {
    const a = regionActiveRef.current
    if (!a || exporting) { if (!a) toast.error('Nejdřív vyber a zobraz území'); return }
    setExporting(true)
    try {
      // S-JTSK obálka území
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const r of a.sjtskRings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }

      const kp = await fetchKatastrPolylines(minX, minY, maxX, maxY, a.sjtskRings)
      const groups: { layer: string; polylines: [number, number, number][][] }[] = []
      if (kp) groups.push({ layer: 'PARCELY', polylines: kp.polylines })

      // obrys území ve stejném rámci (výšky z téhož DMR vzorkovače, jinak plochý fallback)
      const outline = a.sjtskRings
        .map(r => { const c = r.slice(); if (c.length > 1) { const p = c[0], q = c[c.length - 1]; if (Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6) c.pop() } return c })
        .filter(r => r.length >= 3)
        .map(r => r.map(([x, y]) => [x, y, kp ? kp.sampleZ(x, y) : 0] as [number, number, number]))
      if (outline.length) groups.push({ layer: 'HRANICE_UZEMI', polylines: outline })

      if (!groups.some(g => g.polylines.length)) { toast.error('V oblasti nenalezeny žádné parcely ani obrys'); return }
      download(buildDxfLayers(groups), `katastr_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.dxf`, 'application/dxf')
      toast.success(`Katastr (DXF): ${kp?.count ?? 0} parcel + obrys území`)
    } catch (e) {
      console.error('Export katastru území selhal:', e)
      toast.error('Export katastru selhal')
    } finally {
      setExporting(false)
    }
  }

  // jádro: hranice (lon/lat prstence) jako uzavřené 3D křivky (DXF pro 3ds Max), drapované na DMR.
  // Použije stejnou kotvu jako terén (pokud je postaven) → DXF lícuje s glb/obj exportem.
  async function exportDxfRings(lonLatRings: [number, number][][]) {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || exporting) return
    const rings = lonLatRings.filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Žádná hranice k exportu'); return }
    setExporting(true)
    try {
      // kotva ze středu bboxu hranic
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
      for (const r of rings)
        for (const [lo, la] of r) { minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la) }
      const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2
      const cc = [Cesium.Cartographic.fromDegrees(midLon, midLat)]
      await Cesium.sampleTerrain(v.terrainProvider, 18, cc)
      const anchor = { lon: midLon, lat: midLat, h: Number.isFinite(cc[0].height) ? cc[0].height : 0 }
      const anchorECEF = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.h)
      const inv = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(anchorECEF), new Cesium.Matrix4())
      const s = new Cesium.Cartesian3(), o = new Cesium.Cartesian3()
      const toLocalENU = (x: number, y: number, z: number): [number, number, number] => { s.x = x; s.y = y; s.z = z; Cesium.Matrix4.multiplyByPoint(inv, s, o); return [o.x, o.y, o.z] } // east, north, up

      const LIFT = 0.1
      const polylines: [number, number, number][][] = []
      for (const r0 of rings) {
        const ring = r0.slice()
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
      toast.error('Export DXF selhal')
    } finally {
      setExporting(false)
    }
  }

  /**
   * Výřez podle katastru jako export STEJNÝ jako dlaždice: čistý terén DMR 5G + zapečené ortofoto,
   * jen ořezaný na hranici vybraných parcel/oblasti (ne celé čtverce). Zip: vyrez.obj + vyrez.mtl +
   * vyrez.jpg + vray_material.ms + info.txt. Souřadnice v REÁLNÉM S-JTSK (EPSG:5514), bez posunu,
   * výšky Bpv → lícuje s exportem dlaždic i s modely z Maxu. UV se berou z polohy v bboxu výřezu,
   * takže jedno ortofoto přes celý výběr sedí na terén 1:1.
   */
  // ortofoto textura pro výřez: do 4096 px jeden požadavek, jinak složí z ≤4096 dlaždic (ostřejší)
  async function fetchOrthoTexture(minX: number, minY: number, maxX: number, maxY: number, longPx: number, signal: AbortSignal): Promise<Uint8Array> {
    const spanX = maxX - minX, spanY = maxY - minY, longSpan = Math.max(spanX, spanY)
    const W = Math.max(1, Math.round(longPx * spanX / longSpan)), H = Math.max(1, Math.round(longPx * spanY / longSpan))
    if (W <= 4096 && H <= 4096) return await fetchJpegRetry(mapBboxUrl(minX, minY, maxX, maxY, W, H, 'ortofoto', 'ZTM250'), signal, 'Ortofoto')
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas 2D nedostupný')
    const nCols = Math.ceil(W / 4096), nRows = Math.ceil(H / 4096)
    const bx = Array.from({ length: nCols + 1 }, (_, i) => Math.round(i * W / nCols))
    const by = Array.from({ length: nRows + 1 }, (_, i) => Math.round(i * H / nRows))
    const total = nCols * nRows; let done = 0
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
      if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
      const pxW = bx[c + 1] - bx[c], pxH = by[r + 1] - by[r]
      const x0 = minX + spanX * bx[c] / W, x1 = minX + spanX * bx[c + 1] / W
      const yTop = maxY - spanY * by[r] / H, yBot = maxY - spanY * by[r + 1] / H
      const bmp = await loadMapChunk(mapBboxUrl(x0, yBot, x1, yTop, pxW, pxH, 'ortofoto', 'ZTM250'), signal)
      ctx.drawImage(bmp, bx[c], by[r], pxW, pxH); bmp.close?.()
      setCutoutProgress(`stahuji ortofoto ${++done}/${total}…`)
    }
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.92))
    if (!blob) throw new Error('Textura ortofota selhala')
    return new Uint8Array(await blob.arrayBuffer())
  }

  async function exportParcelCutout() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    const polys = [...parcelsRef.current.values()].map(p => {
      const r = p.ring.map(([lo, la]) => [lo, la] as [number, number])
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
      return [r] as [number, number][][]
    })
    await exportCutout(polys)
  }

  // export terénu (DMR 5G) + zapečené ortofoto ořezaný na vybrané správní území
  async function exportRegionCutout() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    const polys = a.sjtskRings.map(r => {
      const ll = r.map(([x, y]) => wgsOf(x, y) as [number, number])
      if (ll.length && (ll[0][0] !== ll[ll.length - 1][0] || ll[0][1] !== ll[ll.length - 1][1])) ll.push([ll[0][0], ll[0][1]])
      return [ll] as [number, number][][]
    })
    await exportCutout(polys)
  }

  // Jádro výřezu: DMR 5G + zapečené ortofoto ořezané na zadané polygony (lon/lat). Sdílené pro parcely
  // i území. Zip: vyrez.obj + mtl + jpg + V-Ray + info; reálné S-JTSK (EPSG:5514), výšky Bpv.
  async function exportCutout(polys: [number, number][][][]) {
    if (cutoutBusy) return
    const ac = new AbortController()
    abortRef.current = ac
    setCutoutBusy(true)
    setCutoutPct(-1)
    setCutoutProgress('připravuji…')
    try {
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
      setCutoutProgress('stahuji výšky (DMR)…')
      const demLong = Math.min(2048, Math.max(64, Math.ceil(longSpan / 2)))
      const demW = Math.max(2, Math.round(demLong * spanX / longSpan))
      const demH = Math.max(2, Math.round(demLong * spanY / longSpan))
      const sampler = await fetchElevSamplerSJTSK('dmr5g', minX, minY, maxX, maxY, demW, demH, ac.signal)

      // 4) ortofoto jako textura — míří na nativních 20 cm/px, strop 8192 px na delší stranu;
      //    nad 4096 px se skládá z dlaždic (ČÚZK dá max 4096 px na jeden požadavek)
      setCutoutProgress('stahuji ortofoto…')
      const texLong = Math.min(8192, Math.max(1024, Math.ceil(longSpan / 0.2)))
      const texW = Math.max(1, Math.round(texLong * spanX / longSpan))
      const texH = Math.max(1, Math.round(texLong * spanY / longSpan))
      const jpg = await fetchOrthoTexture(minX, minY, maxX, maxY, texLong, ac.signal)

      // 5) triangulace každého výseku v S-JTSK, ořez hranicí, UV z polohy v bboxu
      setCutoutProgress('skládám…')
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
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        const part = buildPatch(sp, vBase)
        if (part) {
          objF.push(strToU8(part.text + '\n'), false)
          vBase += part.nv
          totalTris += part.nf
          check()
        }
        setCutoutPct(++built / patches.length)
        setCutoutProgress(`skládám ${built}/${patches.length}`)
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
      toast.success(`Vyvezen výřez (${patches.length} ${patches.length === 1 ? 'plocha' : 'ploch'}) s ortofotem`)
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error('Export výřezu selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export výřezu selhal')
    } finally {
      abortRef.current = null
      setCutoutBusy(false)
      setCutoutProgress('')
      setCutoutPct(-1)
    }
  }

  /**
   * REFERENČNÍ export meshe z Google 3D dlaždic pro vybranou oblast (parcely). Vytáhne geometrii
   * z aktuálně vykreslených dlaždic (`_selectedTiles`), přetransformuje do reálného S-JTSK (lícuje
   * s exportem terénu) a ořízne na hranici výběru. Bez textur (jen geometrie jako reference výšek/tvarů).
   * POZOR: Google Photorealistic 3D Tiles mají v licenci omezení na odvozené modely — jen interní reference.
   */
  async function exportGoogleMesh() {
    const v = viewerRef.current
    const ts = googleRef.current
    if (!v || v.isDestroyed()) return
    if (base !== 'google' || !ts) { toast.error('Nejdřív zapni „3D realita (Google)" a najeď kamerou na oblast'); return }
    if (parcelsRef.current.size === 0) { toast.error('Vyber parcelu/oblast pro ořez'); return }
    const tiles = (ts as unknown as { _selectedTiles: Array<{ _contentResource?: Cesium.Resource; content?: unknown; computedTransform: Cesium.Matrix4 }> })._selectedTiles
    if (!tiles || !tiles.length) { toast.error('Google dlaždice ještě nejsou vykreslené — počkej, až se scéna dokreslí'); return }
    if (cutoutBusy) return
    const ac = new AbortController(); abortRef.current = ac
    setCutoutBusy(true); setCutoutPct(-1); setCutoutProgress('připravuji…')
    try {
      // 1) výběr → S-JTSK obrysy + bbox (stejná konvence jako výřez terénu, aby to lícovalo)
      const polys = [...parcelsRef.current.values()].map(p => {
        const r = p.ring.map(([lo, la]) => [lo, la] as [number, number])
        if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
        return [r] as [number, number][][]
      })
      let merged: [number, number][][][]
      try { merged = polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] } catch { merged = polys }
      const rings: number[][][] = []
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const poly of merged) {
        const outer = poly[0].map(([lo, la]) => sjtskOf(lo, la) as number[])
        if (outer.length < 3) continue
        for (const [x, y] of outer) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
        rings.push(outer)
      }
      if (!rings.length) throw new Error('Výběr nemá platnou plochu')
      const inSel = (x: number, y: number) => rings.some(r => pointInRing(x, y, r))

      // 2) unikátní dlaždice s obsahem
      const uniq = new Map<string, { _contentResource?: Cesium.Resource; computedTransform: Cesium.Matrix4 }>()
      for (const t of tiles) { const cr = t._contentResource; if (cr && t.content) uniq.set(cr.url, t) }
      if (!uniq.size) throw new Error('Žádné načtené Google dlaždice s obsahem')

      // 3) projdi dlaždice, vytáhni trojúhelníky uvnitř výběru
      const loader = getGltfLoader()
      const YUP = (Cesium.Axis as unknown as { Y_UP_TO_Z_UP: Cesium.Matrix4 }).Y_UP_TO_Z_UP // v typech chybí, runtime OK
      const world = new Cesium.Matrix4(), ecef = new Cesium.Cartesian3(), vwT = new THREE.Vector3()
      const dedup = new Map<string, number>()
      const vChunks: string[] = [], fChunks: string[] = []
      let vCount = 0, triKept = 0
      const vIndex = (sx: number, sy: number, sz: number): number => {
        const key = `${sx.toFixed(2)}_${sy.toFixed(2)}_${sz.toFixed(2)}`
        let id = dedup.get(key)
        if (id === undefined) { vChunks.push(`v ${sx.toFixed(3)} ${sy.toFixed(3)} ${sz.toFixed(3)}`); id = ++vCount; dedup.set(key, id) }
        return id
      }
      let done = 0
      for (const [, tile] of uniq) {
        if (ac.signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
        setCutoutProgress(`zpracovávám dlaždice ${done + 1}/${uniq.size}`); setCutoutPct(done / uniq.size); done++
        let buf: ArrayBuffer | undefined
        try { buf = await tile._contentResource!.clone().fetchArrayBuffer() } catch { continue }
        if (!buf) continue
        let gltf: { scene: THREE.Object3D }
        try { gltf = await new Promise((res, rej) => loader.parse(buf, '', g => res(g as unknown as { scene: THREE.Object3D }), rej)) } catch { continue }
        Cesium.Matrix4.multiply(tile.computedTransform, YUP, world)
        gltf.scene.updateMatrixWorld(true)
        const meshes: THREE.Mesh[] = []
        gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
        for (const m of meshes) {
          const g = m.geometry as THREE.BufferGeometry
          const pos = g.attributes.position as THREE.BufferAttribute | undefined
          if (!pos) continue
          const idx = g.index
          const nodeMat = m.matrixWorld
          const nTri = idx ? idx.count / 3 : pos.count / 3
          const toS = (i: number): [number, number, number] => {
            vwT.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(nodeMat)
            ecef.x = vwT.x; ecef.y = vwT.y; ecef.z = vwT.z
            Cesium.Matrix4.multiplyByPoint(world, ecef, ecef)
            const carto = Cesium.Cartographic.fromCartesian(ecef)
            const lon = Cesium.Math.toDegrees(carto.longitude), lat = Cesium.Math.toDegrees(carto.latitude)
            const sj = sjtskOf(lon, lat) as number[]
            return [sj[0], sj[1], carto.height - GEOID_CZ]
          }
          for (let t = 0; t < nTri; t++) {
            const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
            const A = toS(a), B = toS(b), C = toS(c)
            if (!inSel((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3)) continue
            fChunks.push(`f ${vIndex(A[0], A[1], A[2])} ${vIndex(B[0], B[1], B[2])} ${vIndex(C[0], C[1], C[2])}`)
            triKept++
          }
          g.dispose()
        }
        await new Promise(r => setTimeout(r, 0))
      }

      console.log(`Google mesh: ${uniq.size} dlaždic → ${triKept} trojúhelníků, ${vCount} vrcholů`)
      if (!triKept) throw new Error('V oblasti nejsou žádné Google trojúhelníky — přibliž kameru (načtou se detailnější dlaždice) a zkus znovu')

      // 4) streamovaný zip (velký mesh)
      const chunks: Uint8Array[] = []
      let zipErr: unknown = null
      const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
      const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }
      const objF = new ZipDeflate('google_mesh.obj', { level: 1 }); zip.add(objF)
      objF.push(strToU8('o google\ng google\n'), false)
      for (let i = 0; i < vChunks.length; i += 10000) { objF.push(strToU8(vChunks.slice(i, i + 10000).join('\n') + '\n'), false); check() }
      for (let i = 0; i < fChunks.length; i += 10000) { objF.push(strToU8(fChunks.slice(i, i + 10000).join('\n') + '\n'), false); check() }
      objF.push(new Uint8Array(0), true); check()
      const addText = (name: string, text: string) => { const d = new ZipDeflate(name, { level: 6 }); zip.add(d); d.push(strToU8(text), true); check() }
      addText('info.txt', [
        'Mesh z Google Photorealistic 3D Tiles — REFERENCE (jen geometrie, bez textur).',
        'Souřadnice: reálné S-JTSK (EPSG:5514, proj4), výšky Bpv → lícuje s exportem terénu i modely.',
        'Ořezáno na hranici vybraných parcel. Kvalita = fotogrammetrická „tavenina" (jen jako reference výšek a tvarů).',
        'POZOR: licence Google zakazuje odvozené modely — pouze pro interní referenci při modelování.',
        `Trojúhelníků: ${triKept}, vrcholů: ${vCount}`,
        `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
      ].join('\n'))
      zip.end(); check()
      download(concatBytes(chunks), `google_mesh_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
      toast.success(`Vyveden Google mesh (${triKept} trojúhelníků)`)
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error('Export Google meshe selhal:', e)
      toast.error(e instanceof Error ? e.message : 'Export Google meshe selhal')
    } finally {
      abortRef.current = null; setCutoutBusy(false); setCutoutProgress(''); setCutoutPct(-1)
    }
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

  // Jen JEDEN zdroj výběru naráz: parcely (klik/oblast) × dlaždice × území. Při zapnutí jednoho
  // vyčisti ostatní (jejich VÝBĚR i REŽIM), ať nejde mít „zaškrtnuté" víc věcí současně.
  function exclusiveSelect(keep: 'parcel' | 'tile' | 'region') {
    setMoveMode(false)
    if (keep !== 'parcel') { clearAllParcels(); setParcelMode(false); clearArea(); setAreaMode(false) }
    if (keep !== 'tile') { clearTiles(); setTileMode(false); setGridOn(false) }
    if (keep !== 'region') clearRegion()
  }

  function toggleMove() { setMoveMode(m => { const nv = !m; if (nv) { setParcelMode(false); setTileMode(false); if (areaMode) { clearArea(); setAreaMode(false) } } return nv }) }
  function toggleParcel() { setParcelMode(m => { const nv = !m; if (nv) { exclusiveSelect('parcel'); if (areaMode) { clearArea(); setAreaMode(false) } } return nv }) }

  // ── Výkresy (DXF/DWG) ──────────────────────────────────────────────────────────────
  const dwgColor = (rgb: number) => Cesium.Color.fromBytes((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255)

  // nastaví viditelnost všech Cesium primitivů jedné hladiny (čáry + popisky + body)
  const setLayerShow = (ly: DrawLayer, show: boolean) => { if (ly.prim) ly.prim.show = show; if (ly.labels) ly.labels.show = show; if (ly.points) ly.points.show = show }

  function removeDrawing(id: string) {
    const v = viewerRef.current
    const d = drawingsRef.current.get(id)
    if (d && v && !v.isDestroyed()) {
      for (const ly of d.layers) {
        if (ly.prim) v.scene.primitives.remove(ly.prim)
        if (ly.labels) v.scene.primitives.remove(ly.labels)
        if (ly.points) v.scene.primitives.remove(ly.points)
      }
    }
    drawingsRef.current.delete(id)
    removeObj(`drawing-${id}`)
  }

  // Nakreslí parse na mapu: čáry/popisky/body seskupené po hladinách (každá hladina = vlastní
  // primitivy, aby šly samostatně vypínat). Vše v jedné ploché výšce blízko terénu, vždy viditelné.
  // Souřadnice: rozpozná S-JTSK (proj4 záporné i „civilní" kladné) → reálné umístění; jinak lokální
  // (střed kresby položí do středu pohledu).
  async function renderDrawing(parse: DrawParse, name: string) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const { minX, minY, maxX, maxY } = parse
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    let toLL: (x: number, y: number) => [number, number]
    let mode: string
    if (cx > -950000 && cx < -380000 && cy > -1260000 && cy < -890000) { toLL = (x, y) => wgsOf(x, y) as [number, number]; mode = 'S-JTSK' }
    else if (cx > 380000 && cx < 950000 && cy > 890000 && cy < 1260000) { toLL = (x, y) => wgsOf(-x, -y) as [number, number]; mode = 'S-JTSK (kladné)' }
    else {
      const g = viewCenterGround(v)
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height))
      const tmp = new Cesium.Cartesian3(), out = new Cesium.Cartesian3()
      toLL = (x, y) => {
        tmp.x = x - cx; tmp.y = y - cy; tmp.z = 0
        Cesium.Matrix4.multiplyByPoint(enu, tmp, out)
        const c = Cesium.Cartographic.fromCartesian(out)
        return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]
      }
      mode = 'lokální (umístěno do středu pohledu)'
    }

    // Jedna plochá výška blízko terénu (vzorek DMR ve středu výkresu). Výkres se ZÁMĚRNĚ nedrapuje
    // na terén — leží v jedné rovině a vykresluje se s vypnutým depth testem, aby byl vidět vždy,
    // i když je místy pod terénem.
    const [clon, clat] = toLL(cx, cy)
    let h0 = 300 + GEOID_CZ
    try {
      const dd = 0.001
      const es = await fetchElevSampler('dmr5g', clon - dd, clat - dd, clon + dd, clat + dd, 4)
      const bpv = es(clon, clat)
      if (bpv != null) h0 = bpv + GEOID_CZ
    } catch { /* nech výchozí */ }
    if (v.isDestroyed()) return

    let wlon = Infinity, elon = -Infinity, slat = Infinity, nlat = -Infinity
    const seen = (lon: number, lat: number) => { if (lon < wlon) wlon = lon; if (lon > elon) elon = lon; if (lat < slat) slat = lat; if (lat > nlat) nlat = lat }

    // seskup prvky podle hladiny → každá hladina má vlastní čáry/popisky/body, aby šla samostatně vypínat
    const byLayer = new Map<string, DrawPrim[]>()
    for (const p of parse.prims) { const arr = byLayer.get(p.layer); if (arr) arr.push(p); else byLayer.set(p.layer, [p]) }

    const layers: DrawLayer[] = []
    let labelBudget = 1500 // strop popisků kvůli výkonu (napříč hladinami)
    for (const [lname, lprims] of byLayer) {
      const instances: Cesium.GeometryInstance[] = []
      for (const p of lprims) {
        if (p.kind !== 'poly') continue
        const deg: number[] = []
        for (const [x, y] of p.pts) { const [lon, lat] = toLL(x, y); deg.push(lon, lat, h0); seen(lon, lat) }
        if (deg.length < 6) continue
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(dwgColor(p.color)) },
        }))
      }
      // depthTest vypnutý → čáry se kreslí přes vše, takže výkres je vidět i pod terénem
      const prim = instances.length
        ? v.scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PolylineColorAppearance({ renderState: { lineWidth: 1, depthTest: { enabled: false }, depthMask: false, blending: Cesium.BlendingState.ALPHA_BLEND } }),
            asynchronous: false,
          }))
        : null

      let labels: Cesium.LabelCollection | null = null
      const texts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'text' }> => p.kind === 'text')
      if (texts.length && labelBudget > 0) {
        labels = new Cesium.LabelCollection()
        for (const t of texts) {
          if (labelBudget-- <= 0) break
          const [lon, lat] = toLL(t.pt[0], t.pt[1]); seen(lon, lat)
          labels.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, h0), text: t.text, font: '13px sans-serif', fillColor: dwgColor(t.color), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, scale: 0.85 })
        }
        v.scene.primitives.add(labels)
      }

      let points: Cesium.PointPrimitiveCollection | null = null
      const pts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'point' }> => p.kind === 'point')
      if (pts.length) {
        points = new Cesium.PointPrimitiveCollection()
        for (const pt of pts) { const [lon, lat] = toLL(pt.pt[0], pt.pt[1]); seen(lon, lat); points.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, h0), pixelSize: 5, color: dwgColor(pt.color), disableDepthTestDistance: Number.POSITIVE_INFINITY }) }
        v.scene.primitives.add(points)
      }

      if (prim || labels || points) layers.push({ name: lname || '0', color: lprims[0].color, visible: true, prim, labels, points })
    }
    layers.sort((a, b) => a.name.localeCompare(b.name, 'cs'))

    const id = `${Date.now()}`
    const pad = 0.0004
    const bounds = (elon > wlon && nlat > slat) ? Cesium.Rectangle.fromDegrees(wlon - pad, slat - pad, elon + pad, nlat + pad) : null
    drawingsRef.current.set(id, { layers, bounds })
    upsertObj({ id: `drawing-${id}`, kind: 'drawing', name: `Výkres ${name}`, visible: true })
    console.log(`Výkres „${name}": ${parse.prims.length} prvků, umístění ${mode}`)
    if (bounds) v.camera.flyTo({ destination: bounds, duration: 1.2 })
  }

  // odletí kamerou na daný objekt (výkres / model / parcela)
  function locateObject(o: SceneObj) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    try {
      if (o.kind === 'drawing') {
        const d = drawingsRef.current.get(o.id.replace('drawing-', ''))
        if (d?.bounds) { v.camera.flyTo({ destination: d.bounds, duration: 1.0 }); return }
      } else if (o.kind === 'model') {
        const bs = modelsRef.current.get(o.id)?.model?.boundingSphere
        if (bs) { v.camera.flyToBoundingSphere(bs, { duration: 1.0 }); return }
      } else if (o.kind === 'parcel') {
        const p = parcelsRef.current.get(o.id.replace('parcel-', ''))
        if (p?.positions?.length) { v.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(p.positions), { duration: 1.0 }); return }
      }
      toast.info('Polohu tohoto objektu neumím zaměřit')
    } catch (e) { console.error('Zaměření selhalo:', e) }
  }

  async function loadDrawing(file: File) {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    setDrawingLoading(true)
    try {
      let parse: DrawParse
      if (file.name.toLowerCase().endsWith('.dwg')) {
        const { dwgToPrims } = await import('./dwg') // WASM převodník se natáhne až teď
        parse = await dwgToPrims(await file.arrayBuffer())
      } else {
        parse = dxfToPrims(await file.text())
      }
      await renderDrawing(parse, file.name)
      toast.success(`Výkres „${file.name}" načten (${parse.prims.length} prvků)`)
    } catch (e) {
      console.error('Načtení výkresu selhalo:', e)
      toast.error(e instanceof Error ? e.message : 'Načtení výkresu selhalo')
    } finally { setDrawingLoading(false) }
  }

  async function importModel(file: File) {
    if (!/\.(glb|gltf|obj)$/i.test(file.name)) return
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return

    const isGlb = /\.(glb|gltf)$/i.test(file.name)
    // glb URL pro Cesium (OBJ převedeme přes three) + promise na nejnižší bod + případná geo-kotva
    let url: string
    let bottomPromise: Promise<number | null>
    let anchor = parseAnchor(file.name) // kotva z názvu (geo_lon_lat_h.*) → reimport našeho exportu
    let footprint: Cesium.Cartesian3[][] | null = null // obrys(y) půdorysu ve světě pro skrytí mapy (jen S-JTSK)
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
        footprint = geo.footprint
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
      })
      if (v.isDestroyed()) { URL.revokeObjectURL(url); return }
      v.scene.primitives.add(model)
      model.environmentMapManager.enabled = true
      model.environmentMapManager.atmosphereScatteringIntensity = 4.0
      model.environmentMapManager.brightness = 1.3
      // svítící obrys (glow) kolem modelu — výchozí VYPNUTÝ (jde zapnout v panelu modelu)
      model.silhouetteColor = MODEL_GLOW
      model.silhouetteSize = 0

      const id = crypto.randomUUID()
      const entry: ModelEntry = {
        id, name: file.name.replace(/\.(glb|gltf|obj)$/i, ''),
        model, url, center: Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO), yawDeg, placement: p, visible: true,
        footprint: footprint ?? undefined, excavate: false, outline: false,
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
          if (entry.excavate) updateExcavation() // matice se změnila → přepočítej masku
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
    if (e.excavate) updateExcavation() // uklidit masku po smazaném modelu
    setObjects(list => list.filter(o => o.id !== id))
    if (selectedIdRef.current === id) selectObject(null)
  }

  // zapnout/vypnout skrytí mapy (ortofoto/topo + terén + Google) pod/nad vybraným modelem
  function toggleExcavation(id: string) {
    const e = modelsRef.current.get(id)
    if (!e || !e.footprint) return
    e.excavate = !e.excavate
    updateExcavation()
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  // zapnout/vypnout svítící obrys (silhouette) kolem vybraného modelu
  function toggleOutline(id: string) {
    const e = modelsRef.current.get(id)
    if (!e) return
    e.outline = !e.outline
    e.model.silhouetteSize = e.outline ? 2.0 : 0
    setObjects(list => [...list]) // překreslit panel (stav se čte z ref)
  }

  function toggleVisible(o: SceneObj) {
    const vis = !o.visible
    if (o.kind === 'model') { const e = modelsRef.current.get(o.id); if (e) { e.model.show = vis; e.visible = vis } }
    else if (o.kind === 'parcel') parcelsRef.current.get(o.id.replace('parcel-', ''))?.ents.forEach(en => { en.show = vis })
    else if (o.kind === 'drawing') { const d = drawingsRef.current.get(o.id.replace('drawing-', '')); if (d) for (const ly of d.layers) setLayerShow(ly, vis && ly.visible) }
    setObjects(list => list.map(x => x.id === o.id ? { ...x, visible: vis } : x))
  }

  // přepne jednu hladinu výkresu (viditelnost = master výkresu && stav hladiny)
  function toggleLayer(drawingId: string, layerName: string) {
    const d = drawingsRef.current.get(drawingId)
    if (!d) return
    const ly = d.layers.find(l => l.name === layerName)
    if (!ly) return
    ly.visible = !ly.visible
    const master = objects.find(o => o.id === `drawing-${drawingId}`)?.visible ?? true
    setLayerShow(ly, master && ly.visible)
    setObjects(list => [...list]) // překreslit panel (stav hladin se čte z ref)
  }

  // hromadně nastaví viditelnost více hladin naráz (výběr / výsledek hledání)
  function setLayersVisibility(drawingId: string, names: string[], visible: boolean) {
    const d = drawingsRef.current.get(drawingId)
    if (!d) return
    const master = objects.find(o => o.id === `drawing-${drawingId}`)?.visible ?? true
    const set = new Set(names)
    for (const ly of d.layers) if (set.has(ly.name)) { ly.visible = visible; setLayerShow(ly, master && ly.visible) }
    setObjects(list => [...list])
  }

  // stisk na hladině: Shift = rozsah od posledního kliku; jinak zahájí tažení (přidávání/odebírání
  // podle toho, jestli hladina ve výběru už je) a rovnou přepne tu první
  function startLayerDrag(oid: string, name: string, shownNames: string[], shift: boolean) {
    const cur = new Set(layerSel[oid] ?? [])
    const last = lastLayerClick.current[oid]
    if (shift && last) {
      const a = shownNames.indexOf(last), b = shownNames.indexOf(name)
      if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) cur.add(shownNames[k])
      setLayerSel(prev => ({ ...prev, [oid]: cur }))
      lastLayerClick.current[oid] = name
      return // Shift = jen rozsah, ne tažení
    }
    const mode: 'add' | 'remove' = cur.has(name) ? 'remove' : 'add'
    dragRef.current = { oid, mode }
    if (mode === 'add') cur.add(name); else cur.delete(name)
    setLayerSel(prev => ({ ...prev, [oid]: cur }))
    lastLayerClick.current[oid] = name
  }
  // přejezd přes hladinu během tažení = přidá/odebere ji stejným režimem jako začátek tažení
  function dragOverLayer(oid: string, name: string) {
    const d = dragRef.current
    if (!d || d.oid !== oid) return
    setLayerSel(prev => {
      const cur = new Set(prev[oid] ?? [])
      if (d.mode === 'add') cur.add(name); else cur.delete(name)
      return { ...prev, [oid]: cur }
    })
  }
  const selectAllLayers = (oid: string, names: string[]) => setLayerSel(prev => ({ ...prev, [oid]: new Set(names) }))
  const clearLayerSel = (oid: string) => setLayerSel(prev => ({ ...prev, [oid]: new Set() }))

  const toggleExpand = (id: string) => setExpandedDrawings(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  function deleteObject(o: SceneObj) {
    if (o.kind === 'model') deleteModel(o.id)
    else if (o.kind === 'parcel') removeParcel(o.id.replace('parcel-', ''))
    else if (o.kind === 'drawing') removeDrawing(o.id.replace('drawing-', ''))
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
      <input
        ref={dwgRef}
        type="file"
        accept=".dxf,.dwg"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) loadDrawing(f); e.target.value = '' }}
      />

      {NEEDS_ION && !ION_TOKEN && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-amber-900/80 border border-amber-600/50 text-amber-200 text-xs">
          Chybí VITE_CESIUM_ION_TOKEN — Google 3D / OSM budovy nepoběží
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
        {ENABLE_GOOGLE_3D && (
          <ToggleBtn active={base === 'google'} onClick={() => setBase('google')} icon={googleLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="3D realita (Google)" />
        )}
        {ENABLE_GOOGLE_3D && base === 'google' ? (
          <div className="flex flex-col gap-1 px-1 max-w-[190px]">
            <div className="text-[10px] text-gray-500 leading-snug">
              {googleErr ? <span className="text-amber-400">{googleErr}</span> : <>Fotorealistické 3D. Posuvníkem prosvítíš mapu pod ním.</>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400 w-9 shrink-0">3D</span>
              <input type="range" min={0} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="flex-1 min-w-0 accent-cyan-500" title="Průhlednost 3D reality — vlevo jen mapa, vpravo plná 3D" />
              <span className="text-[10px] text-gray-300 tabular-nums w-8">{Math.round(googleAlpha * 100)}%</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400 w-9 shrink-0">Pod</span>
              <button onClick={() => setGoogleUnder('ortofoto')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'ortofoto' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>ortofoto</button>
              <button onClick={() => setGoogleUnder('zm')} className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'zm' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>topo</button>
              <button onClick={() => setGoogleUnder('none')} title="Čistě 3D bez podkladu (skryje glóbus)" className={`px-1.5 py-0.5 rounded text-[11px] ${googleUnder === 'none' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>nic</button>
            </div>
            <div className="h-px bg-gray-700 my-0.5" />
            <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
          </div>
        ) : (
          <>
            <div className="h-px bg-gray-700 my-0.5" />
            <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Překryv</div>
            <ToggleBtn active={katastrOn} onClick={() => setKatastrOn(v => !v)} icon={<Layers size={15} />} label="Katastr" />
          </>
        )}
        {ENABLE_OSM_BUILDINGS && (
          <ToggleBtn active={osmOn} onClick={() => setOsmOn(v => !v)} icon={osmLoading ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />} label="Budovy (OSM)" />
        )}
        {ENABLE_LIBEREC_DISTRICTS && (
          <ToggleBtn active={districtsOn} onClick={toggleDistricts} icon={districtsLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} label="Městské části Liberce" />
        )}
        <div className="h-px bg-gray-700 my-0.5" />
        <ToggleBtn active={parcelMode} onClick={toggleParcel} icon={parcelLoading ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} label={parcelMode ? 'Klikni na parcelu' : 'Vybrat parcelu'} />
        <ToggleBtn active={areaMode} onClick={toggleAreaMode} icon={areaLoading ? <Loader2 size={15} className="animate-spin" /> : <Hexagon size={15} />} label={areaMode ? `Klikej body (${areaPtCount})` : 'Vybrat oblast'} />
        {areaMode && areaPtCount >= 3 && (
          <button onClick={finalizeArea} disabled={areaLoading} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-orange-600 hover:bg-orange-500 text-white transition-colors disabled:opacity-50">
            <Check size={15} /> Vybrat parcely uvnitř
          </button>
        )}
        <ToggleBtn active={tileMode} onClick={toggleTileMode} icon={<Grid3x3 size={15} />} label={tileMode ? `Klikej / táhni (${tileCount})` : 'Vybrat dlaždice'} />
        <ToggleBtn active={regionMode} onClick={() => setRegionMode(m => !m)} icon={regionBusy ? <Loader2 size={15} className="animate-spin" /> : <Landmark size={15} />} label={regionMode ? 'Klikni na mapu (kraj/obec)' : 'Vybrat území'} />
        {regionMode && (
          <div className="flex flex-col gap-1 px-1 pb-0.5 max-w-[200px]">
            <div className="text-[10px] text-gray-500 leading-snug">Klikni na mapu, nebo napiš název:</div>
            <form onSubmit={searchRegion} className="flex items-center gap-1">
              <input value={regionQuery} onChange={e => setRegionQuery(e.target.value)} placeholder="obec / kraj…" className="flex-1 min-w-0 bg-gray-800 rounded px-2 py-1 text-xs text-gray-100 outline-none placeholder:text-gray-600" />
              <button type="submit" title="Vyhledat" className="shrink-0 p-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700">{regionBusy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}</button>
            </form>
          </div>
        )}
        {tileMode && (
          <div className="flex flex-col gap-1 px-1 pb-0.5">
            <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
              Tažením maluješ přes víc dlaždic; tah, co začne na vybrané, naopak odebírá.
              <span className="text-gray-400"> Mapu tady posouváš pravým tlačítkem, zoom kolečkem.</span>
            </div>
            <button
              onClick={() => setGridOn(g => !g)}
              className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${gridOn ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {gridOn ? <Eye size={13} /> : <EyeOff size={13} />} Mřížka s názvy
            </button>
            {gridOn && (
              <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                {gridNote || `Názvy odpovídají „dlazdice_<X>_<Y>" v exportu.`}
              </div>
            )}
            <button
              onClick={() => setExportKatastr(v => !v)}
              title="Přibalit do zipu i hranice parcel (katastr) jako DXF křivky"
              className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${exportKatastr ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {exportKatastr ? <Check size={13} /> : <Layers size={13} />} Přidat katastr (DXF)
            </button>
            <button
              onClick={() => setExportBuildings(v => !v)}
              title="Přidat budovy z ČÚZK — výška a tvar střechy (plochá/sedlová/valbová) z výškových modelů, low-poly, hnědý materiál"
              className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs transition-colors ${exportBuildings ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {exportBuildings ? <Check size={13} /> : <Building2 size={13} />} Přidat budovy
            </button>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 w-11 shrink-0" title="Strop rozlišení spojené 2D mapy">Mapa px</span>
              {[8192, 12288, 16384].map(s => (
                <button
                  key={s}
                  onClick={() => setStitchMax(s)}
                  title={s === 16384 ? 'Nejostřejší, ale ~1 GB paměti — u velkých oblastí může spadnout' : undefined}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${stitchMax === s ? 'bg-teal-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{s / 1024}k</button>
              ))}
            </div>
            {tileCount > 0 && (() => {
              // odhad rozlišení spojené mapy pro aktuální výběr (nativní 20 cm/px, zastropováno)
              let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
              for (const t of tilesRef.current.values()) { ix0 = Math.min(ix0, t.tile.ix); ix1 = Math.max(ix1, t.tile.ix); iy0 = Math.min(iy0, t.tile.iy); iy1 = Math.max(iy1, t.tile.iy) }
              const spanX = (ix1 - ix0 + 1) * tileSize, spanY = (iy1 - iy0 + 1) * tileSize
              const nW = spanX / 0.2, nH = spanY / 0.2
              let sc = Math.min(1, stitchMax / Math.max(nW, nH))
              if (nW * sc * nH * sc > 16384 * 16384) sc = Math.sqrt(16384 * 16384 / (nW * nH))
              const cmpx = 0.2 / sc * 100
              const W = Math.round(nW * sc), H = Math.round(nH * sc)
              return (
                <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                  Ortofoto: {W}×{H} px · {cmpx.toFixed(0)} cm/px{sc >= 1 ? ' (nativní)' : ''}<br />
                  <span className="text-gray-600">topo jen orientační podklad (menší)</span>
                </div>
              )
            })()}
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
        <button onClick={() => dwgRef.current?.click()} disabled={drawingLoading} title="Nahrát výkres DXF/DWG a zobrazit ho na mapě (v S-JTSK se umístí na správné místo; DWG se převede přes WASM)" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
          {drawingLoading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Nahrát výkres (DXF/DWG)
        </button>
        <button onClick={() => loadSplat()} disabled={splatLoading || splatOn} title="TEST: načíst Gaussian splat (Schillerova rozhledna, Kryry) z Cesium ion a posadit na mapu" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-fuchsia-600 hover:bg-fuchsia-500 text-white transition-colors disabled:opacity-50">
          {splatLoading ? <Loader2 size={15} className="animate-spin" /> : <Box size={15} />} Splat (Kryry)
        </button>
        {cacheInfo.count > 0 && (
          <>
            <div className="h-px bg-gray-700 my-0.5" />
            <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
              <span title="Data terénu a mapy uložená na disku prohlížeče (přežijí refresh, zrychlují návraty). LRU maže nejstarší přes strop.">
                Cache: {(cacheInfo.bytes / 1e6).toFixed(0)} MB · {cacheInfo.count} pol.
              </span>
              <button
                onClick={() => cacheClear().then(refreshCache)}
                title="Smazat data z disku prohlížeče (cache terénu a mapy)"
                className="text-gray-500 hover:text-red-300"
              >vymazat</button>
            </div>
          </>
        )}
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
          {tileBusy ? (
            <>
              <div className="flex items-center gap-2 ml-1">
                <div className="w-40 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                  {tilePct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(tilePct * 100))}%` }} />
                    : <div className="h-full w-1/3 bg-emerald-500/70 animate-pulse" />}
                </div>
                <span className="text-gray-300 text-xs tabular-nums whitespace-nowrap">{tileProgress || 'pracuji…'}</span>
              </div>
              <button
                onClick={() => abortRef.current?.abort()}
                title="Zrušit stahování"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs"
              >
                <X size={13} /> Zrušit
              </button>
            </>
          ) : (
            <>
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
                title="Čistý terén DMR 5G s ortofoto texturou → zip s OBJ + MTL + JPEG pro 3ds Max"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs"
              >
                <Download size={13} /> Terén + ortofoto (OBJ)
              </button>
              <button
                onClick={exportStitchedMaps}
                title="Spojená 2D mapa přes výběr — ortofoto i topografická mapa jako jeden georeferencovaný obrázek (world file)"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs"
              >
                <Image size={13} /> Spojená mapa (2D)
              </button>
              {!LOCAL_TILES && (
                <button
                  onClick={loadLocal2DMap}
                  title="Napéct ortofoto vybrané oblasti do localu jako dlaždicovou pyramidu (nativní rozlišení, kvalita se nezhoršuje s velikostí, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u větší oblasti to chvíli trvá), pak lokální/offline a uložené natrvalo. Nenapečené oblasti jedou dál z ČÚZK."
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs"
                >
                  <ArrowDownToLine size={13} /> Načíst 2D lokálně
                </button>
              )}
              <button onClick={clearTiles} title="Zrušit výběr dlaždic" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      )}

      {/* lokální mapa (napečené dlaždice) aktivní — kolik + možnost smazat, i bez výběru */}
      {bakedInfo > 0 && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/85 border border-indigo-500/40 backdrop-blur text-sm">
          <MapIcon size={14} className="text-indigo-400" />
          <span className="text-gray-100">Lokální mapa: <span className="font-medium">{bakedInfo}</span> dl. · ~{Math.round(bakedInfo * 0.06)} MB</span>
          <button onClick={clearBaked} title="Smazat celou lokální mapu (napečené dlaždice) — zpět na živé ČÚZK" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* TEST: doladění Gaussian splatu (Kryry) — syrový splat je v náhodné soustavě, tady ho srovnáš */}
      {splatOn && (
        <div className="absolute top-16 right-3 z-10 w-60 flex flex-col gap-2 px-3 py-2.5 rounded-xl bg-gray-900/90 border border-fuchsia-500/40 backdrop-blur text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-100 font-medium flex items-center gap-1"><Box size={14} className="text-fuchsia-400" /> Splat (Kryry)</span>
            <div className="flex items-center gap-1">
              <button onClick={toggleSplatShow} title="Zobrazit/skrýt splat (ať vidíš ortofoto/terén pod ním)" className={`p-0.5 rounded ${splatShow ? 'text-fuchsia-300 hover:text-fuchsia-200' : 'text-gray-500 hover:text-gray-300'}`}>{splatShow ? <Eye size={14} /> : <EyeOff size={14} />}</button>
              <button onClick={removeSplat} title="Odebrat splat" className="p-0.5 rounded text-gray-400 hover:text-red-300"><Trash2 size={14} /></button>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={resetSplat} title="Skočit na Kryry + odhadnout velikost + narovnat — výchozí bod, když splat lítá/je obří/mrňavý" className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 flex items-center gap-1"><RotateCcw size={13} /> Na Kryry</button>
            <button onClick={() => setSplatMove(m => { const nv = !m; if (nv) setSplatCP(false); return nv })} title="Táhni splat levým tlačítkem po terénu; mapu posouváš pravým tlačítkem" className={`flex-1 px-2 py-1 rounded-lg text-xs flex items-center justify-center gap-1 ${splatMove ? 'bg-fuchsia-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <Move size={13} /> {splatMove ? 'Táhni (pravé=mapa)' : 'Posunout'}
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-gray-400 w-12 shrink-0">Měřítko</span>
            <button onClick={() => updateSplat({ scale: splatP.scale / 2 })} className="px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200">÷2</button>
            <input type="number" value={splatP.scale} step="0.1" onChange={e => updateSplat({ scale: Number(e.target.value) || 0.0001 })} className="w-full min-w-0 bg-gray-800 rounded px-1 py-0.5 text-gray-100 text-center" />
            <button onClick={() => updateSplat({ scale: splatP.scale * 2 })} className="px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200">×2</button>
          </div>
          {([['Otočení', 'heading', -180, 180], ['Sklon', 'pitch', -180, 180], ['Náklon', 'roll', -180, 180], ['Výška', 'heightOffset', -300, 300]] as const).map(([lbl, key, mn, mx]) => (
            <label key={key} className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 w-12 shrink-0">{lbl}</span>
              <input type="range" min={mn} max={mx} step={1} value={splatP[key]} onChange={e => updateSplat({ [key]: Number(e.target.value) } as Partial<Placement>)} className="flex-1 min-w-0" />
              <span className="text-gray-300 w-9 text-right tabular-nums shrink-0">{Math.round(splatP[key])}</span>
            </label>
          ))}
          <div className="border-t border-gray-700 pt-2 mt-0.5 flex flex-col gap-1.5">
            <button onClick={() => setSplatCP(m => { const nv = !m; if (nv) setSplatMove(false); return nv })} title="Vlícování: naklikej 3+ dvojice (bod na splatu ↔ tentýž bod na mapě), spočítám nejlepší usazení a splat skočí co nejblíž" className={`px-2 py-1 rounded-lg text-xs flex items-center justify-center gap-1 ${splatCP ? 'bg-fuchsia-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
              <Crosshair size={13} /> {splatCP ? 'Vlícování zapnuto' : 'Vlícovat body (auto)'}
            </button>
            {splatCP && (
              <>
                <div className="text-[10px] leading-snug text-gray-400">
                  <span className={cpPending ? 'text-amber-300' : 'text-fuchsia-300'}>
                    {cpPending ? '➋ Klikni, KAM to patří na ortofotu (skryj splat okem).' : '➊ SHORA klikni zem POD prvkem splatu (pata zdi, roh u země).'}
                  </span>{' '}Dvojic: <span className="text-gray-200">{cpCount}</span> · klik vždy padne na TERÉN (splat chytit nejde) → koukej kolmo shora a měj splat postavený na zemi. Body rozházené (ne v přímce). Nehýbej splatem během klikání.
                </div>
                <div className="flex gap-1.5">
                  <button onClick={computeCP} disabled={cpCount < 3} className="flex-1 px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">Spočítat ({cpCount})</button>
                  <button onClick={clearCP} className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Vymazat</button>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <button onClick={saveSplat} title="Uložit polohu/měřítko/natočení — splat se pak načte rovnou takhle zarovnaný (přežije refresh)" className="flex-1 px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white">Uložit</button>
            <button onClick={flyToSplat} title="Zaostřit kameru na splat" className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Doletět</button>
          </div>
        </div>
      )}

      {/* panel správního území — nabídka jednotek + izolace */}
      {(regionChoices.length > 0 || regionParts.length > 0 || regionName) && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col gap-1.5 px-3 py-2 rounded-xl bg-gray-900/90 border border-gray-700 backdrop-blur text-sm max-w-[92vw]">
          {regionChoices.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Landmark size={14} className="text-cyan-400 shrink-0" />
              <span className="text-gray-400 text-xs shrink-0">Vyber:</span>
              {regionChoices.map((u, i) => (
                <button key={i} onClick={() => isolateRegion(u)} title={`${u.level}: ${u.name}`} className="px-2 py-0.5 rounded-lg text-xs bg-gray-800 text-gray-200 hover:bg-emerald-600 hover:text-white">
                  <span className="text-gray-500">{u.level}:</span> {u.name}
                </button>
              ))}
              {regionChoices.some(c => c.level === 'Obec') && (
                <button onClick={() => { const o = regionChoices.find(c => c.level === 'Obec'); if (o) loadParts(o.kod) }} title="Rozbalit katastrální území (části) obce" className="px-2 py-0.5 rounded-lg text-xs bg-gray-800 text-cyan-300 hover:bg-gray-700 flex items-center gap-1">
                  {regionBusy ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />} Části (k.ú.)
                </button>
              )}
              <button onClick={() => setRegionChoices([])} title="Zavřít nabídku" className="p-0.5 rounded text-gray-400 hover:text-red-300"><X size={13} /></button>
            </div>
          )}
          {regionParts.length > 0 && (
            <div className="flex items-start gap-1.5">
              <span className="text-gray-400 text-xs shrink-0 mt-1">Části:</span>
              <div className="flex items-center gap-1 flex-wrap max-h-24 overflow-auto">
                {regionParts.map((u, i) => (
                  <button key={i} onClick={() => isolateRegion(u)} title={u.name} className="px-2 py-0.5 rounded-lg text-xs bg-gray-800 text-gray-200 hover:bg-emerald-600 hover:text-white">{u.name}</button>
                ))}
              </div>
              <button onClick={() => setRegionParts([])} title="Zavřít části" className="p-0.5 rounded text-gray-400 hover:text-red-300 mt-0.5"><X size={13} /></button>
            </div>
          )}
          {regionName && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-gray-200">Zvýrazněno: <span className="font-medium">{regionName}</span></span>
              <div className="flex items-center gap-1.5" title="Viditelnost okolí — 0 % = tmavé, 100 % = plně vidět">
                <span className="text-[11px] text-gray-400">Okolí</span>
                <input type="range" min={0} max={1} step={0.05} value={regionDim} onChange={e => setRegionDim(parseFloat(e.target.value))} className="w-24 accent-emerald-500" />
                <span className="text-[11px] text-gray-300 tabular-nums w-9">{Math.round(regionDim * 100)} %</span>
              </div>
              {cutoutBusy ? (
                <>
                  <span className="text-gray-300 text-xs flex items-center gap-1"><Loader2 size={13} className="animate-spin" /> {cutoutProgress || 'exportuji…'}</span>
                  <button onClick={() => abortRef.current?.abort()} title="Zrušit export" className="p-1 rounded text-gray-400 hover:text-red-300"><X size={13} /></button>
                </>
              ) : (
                <>
                  <button onClick={exportRegionCutout} title="Výřez terénu DMR 5G + zapečené ortofoto ořezaný na hranici území → OBJ (velké území = hrubší mřížka / velký soubor)" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-sky-600 hover:bg-sky-500 text-white"><Download size={13} /> Terén (OBJ)</button>
                  <button onClick={exportRegionMaps} title="Spojená 2D mapa ořezaná na tvar území (jako výřez terénu) — ortofoto (PNG s alfou) + topo jako georeferencovaný obrázek (world file), okolí průhledné" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-teal-600 hover:bg-teal-500 text-white"><Image size={13} /> Spojená mapa (2D)</button>
                  {!LOCAL_TILES && (
                    <button onClick={loadRegionLocal2D} title="Napéct ortofoto území do localu jako dlaždicovou pyramidu (nativní rozlišení, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u velkého území to chvíli trvá), pak lokální/offline a uložené natrvalo." className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white"><ArrowDownToLine size={13} /> Načíst 2D lokálně</button>
                  )}
                  <button onClick={exportRegionKatastrDxf} disabled={exporting} title="Katastr území do DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys území (HRANICE_UZEMI), reálné S-JTSK + výšky DMR → lícuje s Terén (OBJ) i dlaždicemi" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Katastr (DXF)</button>
                  <button onClick={exportRegionDxf} disabled={exporting} title="Jen obrys území jako uzavřená 3D křivka (DXF R12) drapovaná na DMR — lokální ENU rámec" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Obrys (DXF)</button>
                </>
              )}
              <button onClick={clearRegion} title="Zrušit zvýraznění území" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-gray-800 text-gray-200 hover:bg-gray-700"><RotateCcw size={13} /> Zrušit</button>
            </div>
          )}
        </div>
      )}

      {/* lišta vybraných parcel (multi) */}
      {parcelCount > 0 && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur text-sm">
          <MapPin size={14} className="text-cyan-400" />
          <span className="text-gray-200">Parcely: <span className="font-medium">{parcelCount}</span></span>
          {cutoutBusy ? (
            <>
              <div className="flex items-center gap-2 ml-1">
                <div className="w-40 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                  {cutoutPct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(cutoutPct * 100))}%` }} />
                    : <div className="h-full w-1/3 bg-emerald-500/70 animate-pulse" />}
                </div>
                <span className="text-gray-300 text-xs tabular-nums whitespace-nowrap">{cutoutProgress || 'pracuji…'}</span>
              </div>
              <button onClick={() => abortRef.current?.abort()} title="Zrušit stahování" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs">
                <X size={13} /> Zrušit
              </button>
            </>
          ) : (
            <>
              <button onClick={exportParcelCutout} title="Výřez terénu DMR 5G ořezaný na hranici výběru + zapečené ortofoto → zip (OBJ + MTL + JPEG + V-Ray) pro 3ds Max" className="ml-1 flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs">
                <Download size={13} /> Terén + ortofoto (OBJ)
              </button>
              {base === 'google' && (
                <button onClick={exportGoogleMesh} title="Vytáhnout surový mesh z Google 3D dlaždic pro vybranou oblast (reference, jen geometrie) → OBJ" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs">
                  <Download size={13} /> Google mesh (OBJ)
                </button>
              )}
              <button onClick={exportParcelsDxf} disabled={exporting} title="Export hranic parcel jako křivky (DXF pro 3ds Max)" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50">
                {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} hranice (DXF)
              </button>
              <button onClick={captureParcelViews} title="Vyfotit vybranou budovu ze 4 stran (kamera obletí, počká na dokreslení) → zip PNG. Nejlepší v 3D realitě." className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs">
                <Image size={13} /> 4 pohledy (PNG)
              </button>
              <button onClick={() => setParcelClip(m => m === 'hide' ? 'off' : 'hide')} title="Skrýt mapu (ortofoto/topo + terén + Google) uvnitř vybraných parcel" className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${parcelClip === 'hide' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                <EyeOff size={13} /> Skrýt parcelu
              </button>
              <button onClick={() => setParcelClip(m => m === 'only' ? 'off' : 'only')} title="Nechat jen vybrané parcely a ztlumit okolí — nastav okraj a viditelnost okolí" className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${parcelClip === 'only' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                <Hexagon size={13} /> Jen parcelu
              </button>
              {ENABLE_GOOGLE_3D && (
                <button onClick={() => setParcelClip(m => m === 'g3d' ? 'off' : 'g3d')} title="Topografická mapa všude + Google 3D realita JEN uvnitř vybraných parcel (potřebuje ion token)" className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${parcelClip === 'g3d' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                  <Building2 size={13} /> Google jen ve výběru
                </button>
              )}
              {parcelClip !== 'off' && (
                <div className="flex items-center gap-1.5 ml-1" title="Rovnoměrně zvětšit (+) nebo zmenšit (−) hranici">
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">Okraj</span>
                  <input type="range" min={-50} max={50} step={0.5} value={parcelBuffer} onChange={e => setParcelBuffer(parseFloat(e.target.value))} className="w-24 accent-emerald-500" />
                  <span className="text-[11px] text-gray-300 tabular-nums w-12">{parcelBuffer > 0 ? '+' : ''}{parcelBuffer.toFixed(1)} m</span>
                </div>
              )}
              {parcelClip === 'g3d' && (
                <div className="flex items-center gap-1.5" title="Průhlednost 3D reality ve výběru — 100 % = plné 3D (topo pod ním skryté), níž = prosvítá topo mapa">
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">3D</span>
                  <input type="range" min={0.1} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="w-20 accent-emerald-500" />
                  <span className="text-[11px] text-gray-300 tabular-nums w-9">{Math.round(googleAlpha * 100)} %</span>
                </div>
              )}
              {parcelClip === 'only' && (
                <div className="flex items-center gap-1.5" title="Viditelnost okolní ZEMĚ — 0 % = černá/skrytá, 100 % = plně vidět">
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">Okolí</span>
                  <input type="range" min={0} max={1} step={0.05} value={okoliVis} onChange={e => setOkoliVis(parseFloat(e.target.value))} className="w-20 accent-emerald-500" />
                  <span className="text-[11px] text-gray-300 tabular-nums w-9">{Math.round(okoliVis * 100)} %</span>
                </div>
              )}
              {parcelClip === 'only' && (
                <div className="flex items-center gap-1" title="Okolní 3D budovy: skrýt (čistá izolace) nebo nechat vidět (kontext)">
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">Okolní 3D</span>
                  <button onClick={() => setKeep3DAround(false)} className={`px-1.5 py-0.5 rounded text-[11px] ${!keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>skrýt</button>
                  <button onClick={() => setKeep3DAround(true)} className={`px-1.5 py-0.5 rounded text-[11px] ${keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>zobrazit</button>
                </div>
              )}
              <button onClick={toggleParcelHighlight} title="Zap/vyp tyrkysové zvýraznění parcely (výběr i ořez zůstanou) — koukat na parcelu načisto" className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${parcelHl ? 'bg-gray-800 text-gray-200 hover:bg-gray-700' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
                {parcelHl ? <Eye size={13} /> : <EyeOff size={13} />} Zvýraznění
              </button>
              <button onClick={resetClipping} title="Reset ořezu — vypnout masky i parcelový ořez, zobrazit celou mapu" className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-gray-800 text-gray-200 hover:bg-gray-700">
                <RotateCcw size={13} /> Reset ořezu
              </button>
              <button onClick={clearAllParcels} title="Zrušit výběr všech parcel" className="p-0.5 rounded text-gray-400 hover:text-red-300 hover:bg-gray-800">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      )}

      {/* panel Scéna — seznam objektů */}
      {objects.length > 0 && (
        <div className="absolute top-3 right-3 z-10 w-64 flex flex-col gap-1 p-2 rounded-xl bg-gray-900/85 border border-gray-700 backdrop-blur max-h-[40vh] overflow-auto">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1 mb-0.5">Scéna</div>
          {objects.map(o => {
            const draw = o.kind === 'drawing' ? drawingsRef.current.get(o.id.replace('drawing-', '')) : null
            const hasLayers = !!draw && draw.layers.length > 0
            const isExpanded = hasLayers && expandedDrawings.has(o.id)
            return (
            <div key={o.id} className="flex flex-col">
            <div
              onClick={() => o.kind === 'model' ? selectObject(o.id) : o.kind === 'drawing' ? locateObject(o) : selectObject(null)}
              className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm cursor-pointer ${
                selectedId === o.id ? 'bg-emerald-600/25 text-emerald-100' : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              {hasLayers ? (
                <button onClick={e => { e.stopPropagation(); toggleExpand(o.id) }} title={`Hladiny (${draw!.layers.length})`} className="shrink-0 -ml-1 p-0.5 rounded text-gray-400 hover:text-gray-100">
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : null}
              <span className="text-[10px] text-gray-500 w-9 shrink-0">{o.kind === 'model' ? 'model' : o.kind === 'parcel' ? 'parc' : o.kind === 'drawing' ? 'výkr' : 'ploch'}</span>
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
              <button onClick={e => { e.stopPropagation(); locateObject(o) }} title="Zaměřit na mapě (odletět na místo)" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-cyan-300">
                <Crosshair size={13} />
              </button>
              <button onClick={e => { e.stopPropagation(); toggleVisible(o) }} title="Zobrazit/skrýt" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100">
                {o.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button onClick={e => { e.stopPropagation(); deleteObject(o) }} title="Smazat" className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300 opacity-0 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
            {isExpanded && draw && (() => {
              const did = o.id.replace('drawing-', '')
              const q = (layerFilter[o.id] || '').toLowerCase().trim()
              const shown = q ? draw.layers.filter(l => l.name.toLowerCase().includes(q)) : draw.layers
              const shownNames = shown.map(l => l.name)
              const sel = layerSel[o.id] ?? EMPTY_NAMESET
              const selCount = sel.size
              const bulk = selCount > 0 ? [...sel] : shownNames // očka pracují nad výběrem, jinak nad zobrazenými
              return (
              <div className="ml-5 mb-1 mt-0.5 flex flex-col gap-0.5 border-l border-gray-700 pl-2">
                <div className="flex items-center gap-1 px-1 pb-0.5">
                  <Search size={11} className="shrink-0 text-gray-500" />
                  <input
                    value={layerFilter[o.id] || ''}
                    onChange={e => setLayerFilter(f => ({ ...f, [o.id]: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                    placeholder="hledat hladinu…"
                    className="flex-1 min-w-0 bg-gray-800 rounded px-1 py-0.5 text-xs text-gray-100 outline-none placeholder:text-gray-600"
                  />
                  <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, true) }} title={selCount > 0 ? `Zobrazit vybrané (${selCount})` : q ? 'Zobrazit nalezené' : 'Zobrazit vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-emerald-300"><Eye size={12} /></button>
                  <button onClick={e => { e.stopPropagation(); setLayersVisibility(did, bulk, false) }} title={selCount > 0 ? `Skrýt vybrané (${selCount})` : q ? 'Skrýt nalezené' : 'Skrýt vše'} className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-300"><EyeOff size={12} /></button>
                </div>
                <div className="flex items-center gap-2 px-1 pb-0.5 text-[10px] text-gray-500">
                  <span className={selCount > 0 ? 'text-emerald-300' : ''}>{selCount > 0 ? `${selCount} vybráno` : `${shown.length} hladin`}</span>
                  <button onClick={e => { e.stopPropagation(); selectAllLayers(o.id, shownNames) }} className="hover:text-gray-200">vybrat vše</button>
                  {selCount > 0 && <button onClick={e => { e.stopPropagation(); clearLayerSel(o.id) }} className="hover:text-gray-200">zrušit výběr</button>}
                </div>
                {shown.length === 0 ? (
                  <div className="px-1 py-0.5 text-xs text-gray-600">žádná hladina</div>
                ) : shown.map(ly => {
                  const isSel = sel.has(ly.name)
                  return (
                  <div
                    key={ly.name}
                    onMouseDown={e => { e.stopPropagation(); e.preventDefault(); startLayerDrag(o.id, ly.name, shownNames, e.shiftKey) }}
                    onMouseEnter={() => dragOverLayer(o.id, ly.name)}
                    title={`${ly.name} — klik označí, tažením označíš víc, Shift+klik rozsah`}
                    className={`flex items-center gap-1.5 px-1 py-0.5 rounded text-xs cursor-pointer select-none ${isSel ? 'bg-emerald-600/25 text-emerald-100' : `hover:bg-gray-800 ${ly.visible ? 'text-gray-300' : 'text-gray-500'}`}`}
                  >
                    <span className="shrink-0 w-2.5 h-2.5 rounded-sm border border-gray-600" style={{ background: '#' + (ly.color & 0xffffff).toString(16).padStart(6, '0') }} />
                    <span className="flex-1 min-w-0 truncate">{ly.name}</span>
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); if (sel.has(ly.name)) setLayersVisibility(did, [...sel], !ly.visible); else toggleLayer(did, ly.name) }}
                      title={sel.has(ly.name) ? `Zobrazit/skrýt všechny vybrané (${selCount})` : 'Zobrazit/skrýt tuto hladinu'}
                      className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-100"
                    >
                      {ly.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                  </div>
                  )
                })}
              </div>
              )
            })()}
            </div>
            )
          })}
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

          {selectedId && modelsRef.current.get(selectedId)?.footprint && (
            <button
              onClick={() => selectedId && toggleExcavation(selectedId)}
              title="Skrýt mapu (ortofoto/topo + terén + Google 3D) přesně pod/nad modelem podle jeho obrysu"
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                modelsRef.current.get(selectedId)?.excavate ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
            >
              <Mountain size={14} /> {modelsRef.current.get(selectedId)?.excavate ? 'Mapa pod modelem skrytá' : 'Skrýt mapu pod modelem'}
            </button>
          )}

          {selectedId && (
            <button
              onClick={() => selectedId && toggleOutline(selectedId)}
              title="Zapnout/vypnout svítící obrys kolem modelu"
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                modelsRef.current.get(selectedId)?.outline ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
            >
              <Sparkles size={14} /> {modelsRef.current.get(selectedId)?.outline ? 'Obrys zapnutý' : 'Obrys vypnutý'}
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
