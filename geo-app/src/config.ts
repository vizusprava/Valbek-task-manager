/**
 * Přepínače funkcí, ion assety, klíče do localStorage a číselné konstanty scény.
 *
 * Všechno, co se ladí „jednou a pak už jen sem tam", je schválně na jednom místě — jinak se
 * magická čísla rozlezou po komponentě a při hledání „kde se to nastavuje" se prochází 5 tisíc
 * řádků. Nic tady nesmí importovat MapView ani jiný modul appky (kromě Cesia), aby to šlo
 * natáhnout odkudkoliv bez cyklu.
 */
import * as Cesium from 'cesium'

export const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined

// Zrušený export: fetch(...,{signal}) i naše ruční `throw` házejí DOMException s name 'AbortError'.
export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

// ── Přepínače funkcí (skrýt, ne mazat) ─────────────────────────────────────────────
// Pro nasazení v task-manageru nepotřebujeme Google 3D, OSM budovy ani městské části Liberce.
// Vypnutím zmizí jen tlačítka; funkce (ensureGoogle/ensureOsm/toggleDistricts) v kódu zůstávají,
// takže se to kdykoliv vrátí přepnutím na true. Vše je líné → skryté tlačítko = nula výkonu.
// POZOR: ion token používá JEN Google 3D a OSM budovy. Když jsou oba false, token není potřeba
// (terén DMR i ortofoto jedou přímo z ČÚZK) → odpadá i celý problém s 401 na ion.
export const ENABLE_GOOGLE_3D = true
export const ENABLE_OSM_BUILDINGS = false
export const ENABLE_LIBEREC_DISTRICTS = false
export const NEEDS_ION = ENABLE_GOOGLE_3D || ENABLE_OSM_BUILDINGS

// Google Photorealistic 3D Tiles streamované přes Cesium ion (stačí ion token, žádný Google klíč).
// Asset je nutné jednorázově přidat ve svém ion účtu (Asset Depot → Google Photorealistic 3D Tiles).
export const GOOGLE_3D_ION_ASSET = 2275207

// TEST: Gaussian splat (Schillerova rozhledna nad Kryry) nahraný do Cesium ion → 3D Tiles.
export const SPLAT_ASSET_ID = 5137495
export const SPLAT_ANCHOR = { lon: 13.42995, lat: 50.17221, h: 383 } // věž ~383 m n.m. (Bpv)
// Splat z COLMAPu chodí otočený o 90° (Y-up vs Cesium Z-up) → výchozí roll narovná nastojato.
export const SPLAT_BASE_ROLL = -90
export const SPLAT_PLACEMENT_KEY = `geo.splat.placement.${SPLAT_ASSET_ID}` // uložené ruční usazení (localStorage)
export const BG_KEY = 'geo.pozadi'           // režim pozadí scény (přežije reload)
export const SHARP_KEY = 'geo.ostrost'      // supersampling nad rámec fyzických pixelů displeje
export const SHAKE_KEY = 'geo.kamera.handheld' // { amt } — jen výchozí intenzita slideru;
                                              // zapnutí chvění patří uloženému pohledu (CamLook)
export const SHAKE_MAX_DEG = 1.1             // výchylka pohledu při intenzitě 100 % (pořád jen plutí, ne třas)
// Plynulé přiblížení kolečkem
export const ZOOM_SENS = 0.0013              // log jednotek na pixel kolečka (~12 % na jeden zářez)
export const ZOOM_TAU = 0.22                 // měkkost pružiny v s — vyšší = delší, měkčí doklouznutí
export const ZOOM_MAX = 1.5                  // strop nedojetého zoomu (~4,5×), ať rychlé rolování neodletí
export const BG_CUSTOM_KEY = 'geo.pozadi.barva' // vlastní barva pozadí
export const SPLAT_ON_KEY = `geo.splat.on.${SPLAT_ASSET_ID}` // „splat byl zapnutý" → po startu se sám načte

export const CR_EXTENT = Cesium.Rectangle.fromDegrees(12.0, 48.5, 18.9, 51.1)
// úvodní pohled: přiblížení na Liberec
export const LIBEREC_EXTENT = Cesium.Rectangle.fromDegrees(14.98, 50.72, 15.13, 50.81)
// geoidová odchylka Bpv→WGS84 elipsoid v ČR (~+44 m); konstanta lokálně stačí
export const GEOID_CZ = 44
// Google Photorealistic dlaždice sedí ~0,5 m níž než DMR — zvedneme je, ať to lícuje
export const GOOGLE_LIFT_M = 0.5
// 3ds Max při exportu glb otočí model o 90° kolem svislé osy — při kotveném importu kompenzujeme
export const MAX_GLB_YAW_DEG = 90
// OSM budovy posunout o 1 m dolů, ať lépe sedí na terén
export const OSM_LIFT_M = -1.5
// svítící obrys kolem importovaného modelu (glow) + barva hrany řezu terénem
export const MODEL_GLOW = Cesium.Color.fromCssColorString('#38f8ff')

export const EMPTY_NAMESET: ReadonlySet<string> = new Set()
