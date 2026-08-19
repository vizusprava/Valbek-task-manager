/**
 * Rastrové podklady z ČÚZK: ortofoto, základní topografická mapa (ZTM) a katastrální překryv.
 *
 * Zobrazení jede vždycky přes WMS — lokální pyramida („napečené" dlaždice v IndexedDB) se do něj
 * jen vlepuje, aby se mapa nemohla rozbít, když cache chybí nebo je poloprázdná.
 */
import * as Cesium from 'cesium'
import { bakedGet } from './cache'
import { LIBEREC_EXTENT } from './config'

// ── ČÚZK WMS služby (ověřeno přes GetCapabilities — všechny podporují EPSG:3857) ──

// větší dlaždice = méně requestů = méně opakujících se ČÚZK log v mapě
export const WMS_TILE = 512

// Volitelný externí lokální dlaždicový server (viz scripts/tile-server.mjs) — má přednost.
export const LOCAL_TILES = import.meta.env.VITE_LOCAL_TILES as string | undefined

// Index napečených ortofoto dlaždic („lokální mapa") v paměti — synchronní kontrola v requestImage.
// Klíč = 'owms/{level}/{x}/{y}' (GEOGRAPHIC dlaždice WMS). Plní se z IndexedDB (store BAKED) při startu.
export const bakedKeys = new Set<string>()

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
export class CachedWmsOrtho extends Cesium.WebMapServiceImageryProvider {
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

export function ortofotoProvider() {
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
  // transparent=true: ČÚZK vrací mimo hranice ČR PRŮHLEDNÉ pixely místo bílé výplně (ověřeno: PNG32, alfa 0).
  // Bez toho svítí kolem republiky bílý obdélník ve výřezu `cartographicLimitRectangle`.
  return new CachedWmsOrtho({
    url: 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer',
    layers: '0',
    tileWidth: WMS_TILE,
    tileHeight: WMS_TILE,
    parameters: { format: 'image/png', transparent: true },
  })
}

// Základní topografická mapa ČR (ZTM) — stylovaná rastrová kartografie.
// Stylizovaná podle měřítka, takže podle výšky kamery přepínáme tier.
export const ZTM_TIERS = [
  { code: 'ZTM250', minH: 150_000 },
  { code: 'ZTM100', minH: 60_000 },
  { code: 'ZTM50',  minH: 25_000 },
  { code: 'ZTM25',  minH: 8_000 },
  { code: 'ZTM10',  minH: 0 },
] as const

export function ztmProvider(code: string) {
  return new Cesium.WebMapServiceImageryProvider({
    url: `https://ags.cuzk.gov.cz/arcgis1/services/ZTM/${code}/MapServer/WMSServer`,
    layers: '0',
    tileWidth: WMS_TILE,
    tileHeight: WMS_TILE,
    parameters: { format: 'image/png', transparent: true },
  })
}

export function pickZtmTier(height: number): string {
  for (const t of ZTM_TIERS) if (height >= t.minH) return t.code
  return 'ZTM10'
}

export function katastrProvider() {
  return new Cesium.WebMapServiceImageryProvider({
    url: 'https://services.cuzk.cz/wms/wms.asp',
    layers: 'hranice_parcel,parcelni_cisla,obrazy_parcel,DEF_BUDOVY',
    parameters: { format: 'image/png', transparent: true },
  })
}
