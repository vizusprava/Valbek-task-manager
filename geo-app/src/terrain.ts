/**
 * Terén celé mapy z ČÚZK DMR 5G jako Cesium terrain provider.
 *
 * Výšky se tahají z ImageServeru po dlaždicích za běhu, takže ortofoto, ZTM i vložené plochy
 * a modely leží na jednom a tomtéž přesném terénu.
 */
import * as Cesium from 'cesium'
import { fromArrayBuffer } from 'geotiff'
import { cacheGet, cachePut } from './cache'
import { GEOID_CZ } from './config'

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
export function makeDmrTerrain(): Cesium.CustomHeightmapTerrainProvider {
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
