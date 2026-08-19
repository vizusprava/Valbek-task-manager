import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import {
  TILE_SIZES, MESH_STEPS, MESH_STEP_DEFAULT, TEX_SIZES, type TileSize, type MeshStep, type TexSize,
  type Tile, tileKey, tileAt, tileRingLL, wgsOf, sjtskOf, pool, gridSize, estimateObjBytes,
} from './tiles'
import { cacheStats, cacheClear, bakedGet, bakedPut, bakedAllKeys, bakedClear } from './cache'
import { fetchOrthoUrl, orthoExport4326Url } from './orthoTiles'
import { solveSimilarity, type V3 } from './similarity'
import { dxfToPrims, type DrawParse, type DrawPrim } from './dxf'
import { buildTextPrims } from './dxfText'
import { createCircleDofStage, type CircleDofUniforms } from './dofCircle'
import { CalloutLayer, DOT_DEFAULT, FRAME_DEFAULT, SIZE_DEFAULT, type Callout } from './callouts'
import { PulseLayer, PULSE_COLOR_DEFAULT, PULSE_COUNT_DEFAULT, type PulseSet } from './pulse'
import { applyBackground, BG_MODES, type BgMode } from './background'
import proj4 from 'proj4'
import polygonClipping from 'polygon-clipping'
import { toast } from 'sonner'
import { Box, Layers, Map as MapIcon, Image, Search, Loader2, Building2, Upload, Move, Crosshair, Trash2, ArrowDownToLine, RotateCcw, MapPin, Mountain, Download, Eye, EyeOff, Hexagon, Check, Sparkles, Grid3x3, X, ChevronRight, ChevronLeft, ChevronDown, Landmark, Camera, Play, Ruler } from 'lucide-react'
import {
  ION_TOKEN, isAbortError, ENABLE_GOOGLE_3D, ENABLE_OSM_BUILDINGS, ENABLE_LIBEREC_DISTRICTS, NEEDS_ION,
  GOOGLE_3D_ION_ASSET, SPLAT_ASSET_ID, SPLAT_ANCHOR, SPLAT_BASE_ROLL, SPLAT_PLACEMENT_KEY, SPLAT_ON_KEY,
  BG_KEY, BG_CUSTOM_KEY, SHAKE_KEY, SHAKE_MAX_DEG, ZOOM_SENS, ZOOM_TAU, ZOOM_MAX,
  CR_EXTENT, LIBEREC_EXTENT, GEOID_CZ, GOOGLE_LIFT_M, MAX_GLB_YAW_DEG, OSM_LIFT_M, MODEL_GLOW, EMPTY_NAMESET,
} from './config'
import type {
  Base, Placement, CamLook, CamView, Parcel, Anchor, ModelEntry, SceneObj, DrawLayer, DrawingEntry,
} from './types'
import { CachedWmsOrtho, WMS_TILE, LOCAL_TILES, bakedKeys, ortofotoProvider, ZTM_TIERS, ztmProvider, pickZtmTier, katastrProvider } from './imagery'
import { makeDmrTerrain } from './terrain'
import { fetchElevSampler } from './elevation'
import { simplifyRingCapped, pointInRing, ringCentroid } from './rings'
import { MEASURE_MAX_EDGES, MEASURE_MIN_EDGE, measureRing, fmtArea, type ParcelMeasure } from './measure'
import { ruianQuery, fetchAdminUnits, fetchAdminParts, fetchAdminGeom, fetchParcelAt, fetchParcelsInBbox, type AdminUnit } from './katastr'
import { AURORA_HEIGHT_M, AURORA_LABEL_LIFT_M, AURORA_SINK_M, auroraMaterial, smoothClosedRing, fetchLiberecDistricts } from './districts'
import { pickGround, pickTerrain, viewCenterGround, buildMatrix } from './sceneUtils'
import { computeBottomZ, georeferenceSjtskGlb } from './model3d'
import { parseAnchor, download, anchorFilename, buildDxf, buildDxfLayers } from './exportUtils'
import { fetchKatastrPolylines } from './export/katastrDxf'
import { stitchMapsCore } from './export/maps'
import type { ExportCtx } from './export/ctx'
import { exportTilesObj as exportTilesObjCore } from './export/tilesObj'
import { exportCutout as exportCutoutCore } from './export/cutout'
import { exportGoogleMesh as exportGoogleMeshCore, type GoogleTile } from './export/googleMesh'
import { NumRow, Section, ToggleBtn } from './ui'

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
  const parcelsRef = useRef<Map<string, { positions: Cesium.Cartesian3[]; ring: number[][]; holes: number[][][]; knArea: number; ents: Cesium.Entity[]; hidden?: boolean }>>(new Map())
  // popisky měření (kóty stran + výměra) po parcelách — mimo p.ents, ať jdou zhasnout zvlášť od zvýraznění
  const measureRef = useRef<Map<string, Cesium.Entity[]>>(new Map())
  // nahrané výkresy (DXF/DWG): čáry/popisky/body po hladinách + obalové bounds
  const drawingsRef = useRef<Map<string, DrawingEntry>>(new Map())
  const [drawH, setDrawH] = useState<Record<string, number>>({})   // svislý posun výkresu (m)
  const [drawA, setDrawA] = useState<Record<string, number>>({})   // průhlednost výkresu (0..1)
  // kamera: uložené pohledy + DOF/FOV/bloom
  const [camViews, setCamViews] = useState<CamView[]>(() => {
    // Pohledy uložené dřív nemají id — doplň ho při načtení, ať se na ně popisky můžou odkazovat.
    try { const s = localStorage.getItem('geo.camviews'); if (s) return (JSON.parse(s) as CamView[]).map((cv, i) => cv.id ? cv : { ...cv, id: `v${i}_${Date.now()}` }) } catch { /* */ }
    return []
  })
  const [activeViewId, setActiveViewId] = useState<string | null>(null)   // pohled, ve kterém právě jsme
  const [callouts, setCallouts] = useState<Callout[]>(() => { try { const s = localStorage.getItem('geo.callouts'); if (s) return JSON.parse(s) as Callout[] } catch { /* */ } return [] })
  const [calloutMode, setCalloutMode] = useState(false)                   // klik do mapy položí popisek
  const [calloutSel, setCalloutSel] = useState<string | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  // Sbalení sekcí levého panelu. Klíč chybí = použij výchozí hodnotu sekce, takže nové sekce
  // nemusí nic doplňovat a stav přežije i jejich přejmenování.
  // Panel překrývá levých 320 px mapy, takže musí jít odsunout — jinak se pod ním nedá klikat.
  const [panelOpen, setPanelOpen] = useState(true)
  // Hlavní vypínač prezentačních prvků (popisky + pulz). Při běžné práci s mapou překážejí.
  const [presentOn, setPresentOn] = useState(true)
  // Co bylo zapnuté, než se prezentace vypnula — aby zapnutí vrátilo přesně to, ne nějaký default.
  const presentSnapRef = useRef<{ dofOn: boolean; bloom: boolean } | null>(null)
  const [openSec, setOpenSec] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem('geo.opensec'); if (v) return JSON.parse(v) as Record<string, boolean> } catch { /* */ }
    return {}
  })
  const toggleSec = (id: string, next: boolean) => setOpenSec(prev => {
    const v = { ...prev, [id]: next }
    try { localStorage.setItem('geo.opensec', JSON.stringify(v)) } catch { /* */ }
    return v
  })
  // Kontextové sekce (Parcely, Dlaždice, Vybraný model…) existují jen když je co ukazovat.
  // Sedí hned pod tím, co je vyrobilo, ale panel může být odscrollovaný jinde — po objevení
  // je proto rozbalíme a sjedeme k nim, ať se po výběru nemusí nic hledat.
  const panelScrollRef = useRef<HTMLDivElement>(null)
  function revealSection(id: string) {
    setOpenSec(prev => {
      if (prev[id] !== false) return prev            // sbalená jen když ji uživatel sám zavřel
      const v = { ...prev, [id]: true }
      try { localStorage.setItem('geo.opensec', JSON.stringify(v)) } catch { /* */ }
      return v
    })
    requestAnimationFrame(() => {
      panelScrollRef.current?.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
  // vzhled posledně upravovaného popisku → nový ho zdědí, ať se nemusí stylovat pokaždé znovu
  const calloutStyleRef = useRef<Pick<Callout, 'dot' | 'frame' | 'size'>>({})
  const [pulses, setPulses] = useState<PulseSet[]>(() => { try { const s = localStorage.getItem('geo.pulses'); if (s) return JSON.parse(s) as PulseSet[] } catch { /* */ } return [] })
  const [pulseColor, setPulseColor] = useState(PULSE_COLOR_DEFAULT)
  const [pulseCount, setPulseCount] = useState(PULSE_COUNT_DEFAULT)
  const pulseLayerRef = useRef<PulseLayer | null>(null)
  const [camName, setCamName] = useState('')
  const [dofOn, setDofOn] = useState(false)
  // 'dist' = ostré je vše v dané vzdálenosti (vestavěná DOF), 'circle' = ostrý kruh uprostřed obrazovky
  const [dofMode, setDofMode] = useState<'dist' | 'circle'>('circle')
  const [dofFocal, setDofFocal] = useState(300)
  const [dofBlur, setDofBlur] = useState(2)
  const [dofRadius, setDofRadius] = useState(0.84)
  const [dofFeather, setDofFeather] = useState(0.7)
  const [fov, setFov] = useState(60)
  const [bloomOn, setBloomOn] = useState(false)
  const [orbitOn, setOrbitOn] = useState(true)        // přelet obloukem kolem středu pohledu (výchozí)
  // „Kamera z ruky" — jemné chvění pohledu v prezentaci. Je součástí VZHLEDU POHLEDU (CamLook),
  // ne globální volba: každý uložený pohled si nese vlastní zapnutí i intenzitu, takže se chvění
  // dá dát jen na záběry, kterým sluší. Po startu je proto vždy VYPNUTÉ a čeká, až přiletíš na
  // pohled, který ho má. V localStorage zůstává jen naposledy nastavená intenzita jako výchozí
  // hodnota slideru — zapnutí se neukládá, aby se refreshem nikdy nevrátilo samo.
  const [shakeOn, setShakeOn] = useState(false)
  const [shakeAmt, setShakeAmt] = useState(() => {
    try { const a = JSON.parse(localStorage.getItem(SHAKE_KEY) || '{}').amt; return typeof a === 'number' ? a : 0.35 } catch { return 0.35 }
  })
  // čte ho renderovací smyčka každý snímek → ref, ať se listenery nepřepínají při každém tahu slideru
  const shakeRef = useRef({ on: false, amt: 0.35 })
  const dofRef = useRef<Cesium.PostProcessStageComposite | null>(null)
  const dofCircleRef = useRef<Cesium.PostProcessStageComposite | null>(null)
  const orbitAnimRef = useRef(0)                       // token běžící orbit animace (pro zrušení předchozí)
  const lookAnimRef = useRef(0)                        // totéž pro přechod vzhledu (FOV/DOF) při přeletu
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
  const [parcelMeasure, setParcelMeasure] = useState(false) // kóty délek u stran + výměra uprostřed parcely
  // area = součet výměr z KN, mapArea = součet spočítaný z geometrie mapy
  const [measureSum, setMeasureSum] = useState<{ area: number; mapArea: number; note: string }>({ area: 0, mapArea: 0, note: '' })
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

  // pozadí scény (kolem glóbu / pod 3D dlaždicemi) — viz background.ts
  const [bgMode, setBgMode] = useState<BgMode>(() => {
    try { const v = localStorage.getItem(BG_KEY); return (BG_MODES.some(m => m.id === v) ? v : 'vesmir') as BgMode } catch { return 'vesmir' }
  })
  const [bgCustom, setBgCustom] = useState<string>(() => {
    try { return localStorage.getItem(BG_CUSTOM_KEY) || '#121820' } catch { return '#121820' }
  })
  const bgStageRef = useRef<Cesium.PostProcessStage | null>(null)

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
    setViewerReady(true)

    // Kolečko si bere naše plynulé přiblížení (efekt „plynulé přiblížení" níž) — Cesium by na
    // každý zářez skočilo o kus a při rychlém rolování to nadskakuje. Pravé tažení a pinch
    // zůstávají Cesiu, tam je pohyb spojitý sám od sebe.
    viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.RIGHT_DRAG, Cesium.CameraEventType.PINCH]

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
      setViewerReady(false)
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

  // pozadí scény: hvězdy / přechod / plná barva. Řeší i barvu glóbu MIMO dostupná data
  // (ČÚZK končí na hranicích ČR) — jinak by kolem republiky svítil obdélník.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    applyBackground(v, bgMode, bgCustom, bgStageRef)
    try { localStorage.setItem(BG_KEY, bgMode); localStorage.setItem(BG_CUSTOM_KEY, bgCustom) } catch { /* private mode */ }
  }, [viewerReady, bgMode, bgCustom])

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
    // `v.scene` si držíme z registrace — při zániku komponenty je viewer už zničený a getter
    // by spadl (Viewer.isDestroyed() to nezachytí, v Cesiu vrací vždy false).
    const ssc = v.scene.screenSpaceCameraController
    return () => { handler.destroy(); ssc.enableInputs = true }
  }, [moveMode])

  // TEST: tažení splatu po terénu (posun jeho kotvy). Levé táhne splat, pravé posouvá mapu (jako dlaždice).
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !splatMove) return
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes, prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.PINCH] // kolečko obsluhuje naše plynulé přiblížení
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

  // Režim přidání popisku: klik do mapy položí kotvu. Popisek se rovnou přiřadí aktivnímu pohledu,
  // aby po vytvoření hned vyjel — jinak by uživatel udělal popisek a nic by se nestalo.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !calloutMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) { toast.info('Tady se nepodařilo najít povrch'); return }
      const p = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      const last = calloutStyleRef.current
      const c: Callout = { id: `c${Date.now()}`, text: 'Nový popisek', anchor: [p.x, p.y, p.z], off: [110, -80], views: activeViewId ? [activeViewId] : [], ...last }
      setCallouts(prev => { const next = [...prev, c]; saveCallouts(next); return next })  // funkční tvar → efekt nemusí viset na `callouts`
      setCalloutSel(c.id)
      setCalloutMode(false)
      if (!activeViewId) toast.info('Popisek vznikl, ale není vybraný žádný pohled — zůstane zasunutý')
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [calloutMode, activeViewId])

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
        // vybraná parcela → teprve teď reprojektuj celou geometrii (vnější prstenec i díry)
        const toCart = (r: number[][]) => r.map(([x, y]) => {
          const [lo, la] = proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]
          return Cesium.Cartesian3.fromDegrees(lo, la)
        })
        addParcelSel({
          id: parcel.id, label: parcel.label, knArea: parcel.knArea,
          positions: toCart(parcel.ring), holes: parcel.holes.map(toCart),
        })
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
    // v režimu dlaždic nešlo popojet. Posun tedy na pravé, zoom zůstává kolečku (obsluhuje
    // ho naše plynulé přiblížení, Cesiu tu zůstává jen pinch).
    const cam = v.scene.screenSpaceCameraController
    const prevRotate = cam.rotateEventTypes
    const prevZoom = cam.zoomEventTypes
    cam.rotateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG]
    cam.zoomEventTypes = [Cesium.CameraEventType.PINCH]

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
    // událost si držíme z registrace, ať cleanup nesahá na getter zničeného viewru (viz výše)
    const moveEnd = v.camera.moveEnd
    moveEnd.addEventListener(off)
    return () => { moveEnd.removeEventListener(off); clearGrid() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, tileSize])

  // ── dlouhé exporty: jeden ukazatel průběhu, jedno zrušení, jedno místo na chyby ────────────
  // Vlastní práci dělají moduly v `export/` — ty stav komponenty neznají a dostanou jen `ExportCtx`
  // (signál zrušení + hlášení průběhu) a vrátí hlášku pro úspěšný toast. Tady zůstala jen obsluha:
  // zamknout tlačítka, nastavit ukazatel, přeložit chybu na toast a po sobě uklidit. Dřív měl tuhle
  // pětiřádkovou obálku každý export vlastní (a každý o kousek jinak).
  type ExportUi = { busy: boolean; setBusy: (b: boolean) => void; setPct: (p: number) => void; setMsg: (m: string) => void }
  const tileUi: ExportUi = { busy: tileBusy, setBusy: setTileBusy, setPct: setTilePct, setMsg: setTileProgress }
  const cutoutUi: ExportUi = { busy: cutoutBusy, setBusy: setCutoutBusy, setPct: setCutoutPct, setMsg: setCutoutProgress }

  async function runExport(ui: ExportUi, failMsg: string, job: (ctx: ExportCtx) => Promise<string>) {
    if (ui.busy) return
    const ac = new AbortController()
    abortRef.current = ac
    ui.setBusy(true); ui.setPct(-1); ui.setMsg('připravuji…')
    try {
      toast.success(await job({ signal: ac.signal, report: (pct, msg) => { ui.setPct(pct); ui.setMsg(msg) } }))
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error(`${failMsg}:`, e)
      toast.error(e instanceof Error ? e.message : failMsg)
    } finally {
      abortRef.current = null
      ui.setBusy(false); ui.setMsg(''); ui.setPct(-1)
    }
  }

  async function exportTilesObj() {
    const tiles = [...tilesRef.current.values()].map(t => t.tile)
    if (!tiles.length) return
    await runExport(tileUi, 'Export dlaždic selhal', ctx =>
      exportTilesObjCore(tiles, { tileSize, meshStep, texSize, buildings: exportBuildings, katastr: exportKatastr }, ctx))
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
    if (!tiles.length) return
    // S-JTSK obálka výběru (dlaždice jsou souvislé čtverce)
    let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
    for (const t of tiles) { ix0 = Math.min(ix0, t.ix); ix1 = Math.max(ix1, t.ix); iy0 = Math.min(iy0, t.iy); iy1 = Math.max(iy1, t.iy) }
    await runExport(tileUi, 'Export mapy selhal', ctx =>
      stitchMapsCore(ix0 * tileSize, iy0 * tileSize, (ix1 + 1) * tileSize, (iy1 + 1) * tileSize, stitchMax, ctx))
  }

  // spojená 2D mapa (ortofoto + topo) pro vybrané správní území — přes obálku území
  async function exportRegionMaps() {
    const a = regionActiveRef.current
    if (!a) { toast.error('Nejdřív vyber a zobraz území'); return }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const r of a.sjtskRings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    // ořez přesně na tvar území (jako výřez terénu) → PNG s alfou, okolí průhledné
    await runExport(cutoutUi, 'Export mapy selhal', ctx => stitchMapsCore(minX, minY, maxX, maxY, stitchMax, ctx, a.sjtskRings))
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
    const toRing = (cs: Cesium.Cartesian3[]) => cs.map(c => {
      const cc = Cesium.Cartographic.fromCartesian(c)
      return [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)]
    })
    const ring = toRing(parcel.positions)
    const holeCarts = parcel.holes ?? []
    const holes = holeCarts.map(toRing)
    const fill = v.entities.add({
      show: parcelHl,
      // díry v hierarchii → tyrkys nepřekryje vykrojené parcely uvnitř (a lícuje s výměrou)
      polygon: { hierarchy: new Cesium.PolygonHierarchy(parcel.positions, holeCarts.map(h => new Cesium.PolygonHierarchy(h))), material: Cesium.Color.CYAN.withAlpha(0.25), classificationType: Cesium.ClassificationType.BOTH },
    })
    const border = v.entities.add({
      show: parcelHl,
      polyline: { positions: [...parcel.positions, parcel.positions[0]], width: 3, material: Cesium.Color.CYAN, clampToGround: true },
    })
    // obrys i kolem děr, ať je vidět, co je z parcely vykrojené
    const holeBorders = holeCarts.map(h => v.entities.add({
      show: parcelHl,
      polyline: { positions: [...h, h[0]], width: 2, material: Cesium.Color.CYAN.withAlpha(0.7), clampToGround: true },
    }))
    parcelsRef.current.set(pid, { positions: parcel.positions, ring, holes, knArea: parcel.knArea ?? 0, ents: [fill, border, ...holeBorders] })
    upsertObj({ id: `parcel-${pid}`, kind: 'parcel', name: `Parcela ${parcel.label || parcel.id || ''}`.trim(), visible: true })
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
    for (const p of parcelsRef.current.values()) for (const e of p.ents) e.show = nv && !p.hidden
    setParcelHl(nv)
  }

  // ── Měření vybraných parcel ─────────────────────────────────────────────────────
  // Kóta (délka v m) u každé strany + výměra uprostřed parcely. Staví se znovu při každé
  // změně výběru — parcel bývají desítky, takže je levnější přepočítat než udržovat diff.
  function clearMeasure() {
    const v = viewerRef.current
    for (const ents of measureRef.current.values()) if (v && !v.isDestroyed()) for (const e of ents) v.entities.remove(e)
    measureRef.current.clear()
  }

  function redrawMeasure() {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    clearMeasure()
    if (!parcelMeasure) { setMeasureSum({ area: 0, mapArea: 0, note: '' }); return }

    const measured: Array<{ pid: string; show: boolean; kn: number; m: ParcelMeasure }> = []
    let edgeCount = 0, areaSum = 0, knSum = 0
    for (const [pid, p] of parcelsRef.current) {
      const m = measureRing(p.ring, p.holes)
      if (!m) continue
      measured.push({ pid, show: !p.hidden, kn: p.knArea, m })
      edgeCount += m.edges.filter(e => e.len >= MEASURE_MIN_EDGE).length
      areaSum += m.area
      knSum += p.knArea || m.area // parcela bez údaje z KN (starší cache) → aspoň nezkreslí součet
    }
    // u velkých výběrů se kóty stran stejně slijí → vypustíme je, výměry zůstanou
    const withEdges = edgeCount <= MEASURE_MAX_EDGES
    setMeasureSum({ area: knSum, mapArea: areaSum, note: withEdges ? '' : `${edgeCount} stran — kóty skryté, zůstaly jen výměry` })

    const lbl = (extra: Partial<Cesium.LabelGraphics.ConstructorOptions>): Cesium.LabelGraphics.ConstructorOptions => ({
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...extra,
    })

    for (const { pid, show, kn, m } of measured) {
      const ents: Cesium.Entity[] = []
      if (withEdges) {
        for (const e of m.edges) {
          if (e.len < MEASURE_MIN_EDGE) continue
          ents.push(v.entities.add({
            show,
            position: Cesium.Cartesian3.fromDegrees(e.mid[0], e.mid[1]),
            label: lbl({
              text: `${e.len.toFixed(2)} m`,
              font: 'bold 15px monospace',
              outlineWidth: 4,
              // mírné zmenšení s odstupem (dřív 0.55 na 2 km — kóty byly z výšky nečitelné)
              scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 4000, 0.8),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4000), // z dálky by to byla jen kaše
            }),
          }))
        }
      }
      // Hlavní číslo = výměra ZAPSANÁ v KN (sedne na ikatastr a na list vlastnictví).
      // Pod ním malým z mapy — to lícuje s kótami po obvodu a s DXF exportem. V územích
      // s mapou 1:2880 se ta dvě čísla liší o jednotky procent a je fér vidět obojí.
      const areaPos = Cesium.Cartesian3.fromDegrees(m.label[0], m.label[1])
      ents.push(v.entities.add({
        show,
        position: areaPos,
        label: lbl({
          text: fmtArea(kn || m.area),
          font: 'bold 14px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#7dffb2'),
          outlineWidth: 4,
          scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 12000, 0.5),
        }),
      }))
      // druhý řádek jen když se od KN opravdu liší (jinak by tam stálo dvakrát totéž)
      if (kn > 0 && Math.abs(m.area - kn) >= 1) {
        ents.push(v.entities.add({
          show,
          position: areaPos,
          label: lbl({
            text: `z mapy ${fmtArea(m.area)}`,
            font: '11px sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#cfd8dc'),
            pixelOffset: new Cesium.Cartesian2(0, 15),
            scaleByDistance: new Cesium.NearFarScalar(400, 1.0, 12000, 0.5),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000),
          }),
        }))
      }
      measureRef.current.set(pid, ents)
    }
  }

  // měření sleduje přepínač i každou změnu výběru (parcelCount se mění při add/remove)
  useEffect(() => { redrawMeasure() }, [parcelMeasure, parcelCount])

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

  /** obrysy vybraných parcel jako uzavřené lon/lat polygony (vstup pro výřez i Google mesh) */
  function parcelPolys(): [number, number][][][] {
    return [...parcelsRef.current.values()].map(p => {
      const r = p.ring.map(([lo, la]) => [lo, la] as [number, number])
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]])
      return [r] as [number, number][][]
    })
  }

  async function exportParcelCutout() {
    if (parcelsRef.current.size === 0) { toast.error('Nejdřív vyber parcelu'); return }
    await runExport(cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(parcelPolys(), meshStep, ctx))
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
    await runExport(cutoutUi, 'Export výřezu selhal', ctx => exportCutoutCore(polys, meshStep, ctx))
  }

  /**
   * Google mesh vybrané oblasti — geometrie se bere z právě vykreslených dlaždic, takže co není
   * na obrazovce načtené, to v exportu nebude. Odtud ty kontroly před spuštěním.
   */
  async function exportGoogleMesh() {
    const v = viewerRef.current
    const ts = googleRef.current
    if (!v || v.isDestroyed()) return
    if (base !== 'google' || !ts) { toast.error('Nejdřív zapni „3D realita (Google)" a najeď kamerou na oblast'); return }
    if (parcelsRef.current.size === 0) { toast.error('Vyber parcelu/oblast pro ořez'); return }
    const tiles = (ts as unknown as { _selectedTiles: GoogleTile[] })._selectedTiles
    if (!tiles || !tiles.length) { toast.error('Google dlaždice ještě nejsou vykreslené — počkej, až se scéna dokreslí'); return }
    await runExport(cutoutUi, 'Export Google meshe selhal', ctx => exportGoogleMeshCore(tiles, parcelPolys(), ctx))
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
  const setLayerShow = (ly: DrawLayer, show: boolean) => { if (ly.prim) ly.prim.show = show; for (const lp of ly.labels) lp.show = show; if (ly.points) ly.points.show = show }

  function removeDrawing(id: string) {
    const v = viewerRef.current
    const d = drawingsRef.current.get(id)
    if (d && v && !v.isDestroyed()) {
      for (const ly of d.layers) {
        if (ly.prim) v.scene.primitives.remove(ly.prim)
        for (const lp of ly.labels) v.scene.primitives.remove(lp)
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

    // svislý směr ve středu (pro posun výšky) + sběr odkazů na prvky (pro živou průhlednost)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(clon, clat, h0), new Cesium.Cartesian3())
    const textMats: DrawingEntry['textMats'] = []
    const pointRefs: DrawingEntry['pointRefs'] = []
    const polyRefs: DrawingEntry['polyRefs'] = []

    // Báze pro texty: kotva každého textu jde přes toLL (přesně jako čáry), ale rohy písmen se
    // odsazují o metry v této sdílené ENU bázi — na vzdálenost pár km je odchylka směru < 0,05°.
    const enuC = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(clon, clat, h0))
    const east = Cesium.Matrix4.getColumn(enuC, 0, new Cesium.Cartesian4())
    const north = Cesium.Matrix4.getColumn(enuC, 1, new Cesium.Cartesian4())
    const eastC = new Cesium.Cartesian3(east.x, east.y, east.z)
    const northC = new Cesium.Cartesian3(north.x, north.y, north.z)
    const toXYZ = (x: number, y: number) => { const [lo, la] = toLL(x, y); return Cesium.Cartesian3.fromDegrees(lo, la, h0) }
    // Konvergence poledníků: osa +X výkresu v S-JTSK NENÍ východ (Křovák je šikmá kuželová
    // projekce), takže bez téhle korekce by byly všechny texty stočené o několik stupňů.
    const dv = Cesium.Cartesian3.subtract(toXYZ(cx + 1, cy), toXYZ(cx, cy), new Cesium.Cartesian3())
    const conv = Math.atan2(Cesium.Cartesian3.dot(dv, northC), Cesium.Cartesian3.dot(dv, eastC))

    let wlon = Infinity, elon = -Infinity, slat = Infinity, nlat = -Infinity
    const seen = (lon: number, lat: number) => { if (lon < wlon) wlon = lon; if (lon > elon) elon = lon; if (lat < slat) slat = lat; if (lat > nlat) nlat = lat }

    // seskup prvky podle hladiny → každá hladina má vlastní čáry/popisky/body, aby šla samostatně vypínat
    const byLayer = new Map<string, DrawPrim[]>()
    for (const p of parse.prims) { const arr = byLayer.get(p.layer); if (arr) arr.push(p); else byLayer.set(p.layer, [p]) }

    const layers: DrawLayer[] = []
    // Velké výkresy mají desetitisíce textů → strop na počet. Vzdálenostní LOD už není potřeba:
    // texty jsou teď v metrech, takže se při oddálení samy zmenší do neviditelna.
    let labelBudget = 30000
    for (const [lname, lprims] of byLayer) {
      const instances: Cesium.GeometryInstance[] = []
      const polyMeta: { id: string; c: Cesium.Color }[] = []
      for (const p of lprims) {
        if (p.kind !== 'poly') continue
        const deg: number[] = []
        for (const [x, y] of p.pts) { const [lon, lat] = toLL(x, y); deg.push(lon, lat, h0); seen(lon, lat) }
        if (deg.length < 6) continue
        const col = dwgColor(p.color)
        const iid = `${lname}#${polyMeta.length}`
        instances.push(new Cesium.GeometryInstance({
          id: iid,
          geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(deg), width: 2, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col) },
        }))
        polyMeta.push({ id: iid, c: col })
      }
      // depthTest vypnutý → čáry se kreslí přes vše, takže výkres je vidět i pod terénem
      const prim = instances.length
        ? v.scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PolylineColorAppearance({ renderState: { lineWidth: 1, depthTest: { enabled: false }, depthMask: false, blending: Cesium.BlendingState.ALPHA_BLEND } }),
            asynchronous: false,
          }))
        : null
      if (prim) for (const m of polyMeta) polyRefs.push({ prim, id: m.id, c: m.c })

      // Texty jako geometrie v rovině výkresu (ne Labely) → drží rotaci i výšku v metrech z DXF.
      const labels: Cesium.Primitive[] = []
      const texts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'text' }> => p.kind === 'text')
      if (texts.length && labelBudget > 0) {
        const take = texts.slice(0, Math.max(0, labelBudget))
        labelBudget -= take.length
        for (const t of take) { const [lon, lat] = toLL(t.pt[0], t.pt[1]); seen(lon, lat) }
        const built = buildTextPrims({
          texts: take, anchor: toXYZ, east: eastC, north: northC, up, conv,
          colorCss: rgb => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`,
        })
        for (const tp of built.prims) { v.scene.primitives.add(tp); labels.push(tp) }
        textMats.push(...built.mats)
      }

      let points: Cesium.PointPrimitiveCollection | null = null
      const pts = lprims.filter((p): p is Extract<DrawPrim, { kind: 'point' }> => p.kind === 'point')
      if (pts.length) {
        points = new Cesium.PointPrimitiveCollection()
        for (const pt of pts) { const [lon, lat] = toLL(pt.pt[0], pt.pt[1]); seen(lon, lat); const pc = dwgColor(pt.color); const pp = points.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, h0), pixelSize: 5, color: pc, disableDepthTestDistance: Number.POSITIVE_INFINITY }); pointRefs.push({ p: pp, c: pc }) }
        v.scene.primitives.add(points)
      }

      if (prim || labels.length || points) layers.push({ name: lname || '0', color: lprims[0].color, visible: true, prim, labels, points })
    }
    layers.sort((a, b) => a.name.localeCompare(b.name, 'cs'))

    const id = `${Date.now()}`
    const pad = 0.0004
    const bounds = (elon > wlon && nlat > slat) ? Cesium.Rectangle.fromDegrees(wlon - pad, slat - pad, elon + pad, nlat + pad) : null
    drawingsRef.current.set(id, { layers, bounds, up, textMats, pointRefs, polyRefs })
    upsertObj({ id: `drawing-${id}`, kind: 'drawing', name: `Výkres ${name}`, visible: true })
    console.log(`Výkres „${name}": ${parse.prims.length} prvků, umístění ${mode}`)
    if (bounds) v.camera.flyTo({ destination: bounds, duration: 1.2 })
  }

  // ── posun výšky + průhlednost celého výkresu (živě, bez překreslení) ──
  function applyDrawH(e: DrawingEntry, off: number) {
    const m = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(e.up, off, new Cesium.Cartesian3()))
    for (const ly of e.layers) {
      if (ly.prim) ly.prim.modelMatrix = m
      for (const lp of ly.labels) lp.modelMatrix = m
      if (ly.points) ly.points.modelMatrix = m
    }
  }
  function applyDrawAlpha(e: DrawingEntry, a: number) {
    for (const mt of e.textMats) mt.uniforms.opacity = a
    for (const r of e.pointRefs) r.p.color = r.c.withAlpha(a)
    for (const r of e.polyRefs) { const at = r.prim.getGeometryInstanceAttributes(r.id); if (at) at.color = Cesium.ColorGeometryInstanceAttribute.toValue(r.c.withAlpha(a), at.color) }
    viewerRef.current?.scene.requestRender()
  }
  function setDrawingHeight(did: string, off: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawH(e, off); setDrawH(s => ({ ...s, [did]: off })) } }
  function setDrawingAlpha(did: string, a: number) { const e = drawingsRef.current.get(did); if (e) { applyDrawAlpha(e, a); setDrawA(s => ({ ...s, [did]: a })) } }

  // ── kamera: perspektiva ↔ pohled shora (ortho, jako půdorys) ──
  function camPerspective() { const v = viewerRef.current; if (v && !v.isDestroyed()) v.scene.camera.switchToPerspectiveFrustum() }
  function camTopOrtho() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const h = Math.max(150, v.camera.positionCartographic?.height ?? 2000)
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0.5,
      complete: () => { if (!v.isDestroyed()) v.scene.camera.switchToOrthographicFrustum() },
    })
  }

  useEffect(() => {
    shakeRef.current = { on: shakeOn && presentOn, amt: shakeAmt } // mimo prezentaci se nechvěje
    // ukládá se JEN intenzita (výchozí pro slider); zapnutí patří uloženému pohledu, ne prohlížeči
    try { localStorage.setItem(SHAKE_KEY, JSON.stringify({ amt: shakeAmt })) } catch { /* */ }
  }, [shakeOn, shakeAmt, presentOn])

  /**
   * „Kamera z ruky": jemné rozechvění pohledu v prezentaci.
   *
   * Nasazuje se PŘED vykreslením snímku a hned po něm se kamera vrátí přesně tam, kde byla.
   * Skutečný stav kamery tak zůstává čistý — přelety (flyTo i orbit), ovládání myší, ukládání
   * pohledů a `viewCenterGround` pracují s nerozechvěnou kamerou a chvění se nikam nenasčítá.
   * (Kdyby se chvění do kamery zapisovalo natrvalo, po minutě prezentace by ujela jinam.)
   *
   * Otáčí se jen POHLED (yaw/pitch/roll kolem vlastních os kamery), pozicí nehýbeme: je to to,
   * co na „z ruky" čte, kamera se nemůže dostat do terénu a nevzniká gimbal u pohledu shora.
   * Rotace jdou přes `look*`/`twist*`, takže se nepřevádí na heading/pitch/roll a zpět —
   * obnova je pak bitově přesná a nedrift.
   *
   * Šum = součet nesouměřitelných sinusovek (žádná knihovna): pomalé plutí + rychlejší
   * mikrochvění, každá osa s jiným rozfázováním, aby se vzor dlouho neopakoval. Amplituda
   * se škáluje zorným úhlem — u úzkého FOV je stejný úhel na obraze větší, takže by přizoomovaný
   * záběr jinak vibroval mnohem víc.
   *
   * POZOR na okno mezi `onPre` a `onPost`: uvnitř něj je kamera rozechvělá a JEN TAM se smí
   * promítat kotvy do obrazovky. `CalloutLayer` (callouts.tsx) proto počítá pozice popisků
   * v `preRender` — kdyby to dělal v `postRender`, dostal by už narovnanou kameru a popisky by
   * po scéně klouzaly o celou výchylku. Nepřehazovat ani jednu z těch registrací.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    // Scénu i obě události si držíme z doby registrace. V odhlašování se na `v.scene` sahat NESMÍ:
    // cleanup běží při zrušení komponenty, tedy až po zničení viewru (init efekt je deklarovaný
    // dřív, takže jeho cleanup jde první), a getter `Viewer.scene` pak sáhne do už zahozeného
    // widgetu a spadne. `Viewer.isDestroyed()` to nezachytí — v Cesiu vrací vždy false.
    const scene = v.scene
    const cam = scene.camera
    const C3 = Cesium.Cartesian3
    let saved: { pos: Cesium.Cartesian3; dir: Cesium.Cartesian3; up: Cesium.Cartesian3 } | null = null
    const t0 = performance.now()
    const wave = (t: number, parts: [number, number][]) =>
      parts.reduce((s, [hz, amp]) => s + Math.sin(t * hz * Math.PI * 2) * amp, 0)

    const onPre = () => {
      const { on, amt } = shakeRef.current
      if (!on || amt <= 0) return
      // Snímkování 4 pohledů si kameru drží přes camera.lookAt (nenulový transform) a chce čisté
      // záběry — tam do ní nesaháme.
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) return
      const t = (performance.now() - t0) / 1000
      const fov = (cam.frustum as Cesium.PerspectiveFrustum).fov // ortho frustum ho nemá → bez škálování
      const k = Cesium.Math.toRadians(SHAKE_MAX_DEG) * amt * (fov ? fov / Cesium.Math.toRadians(60) : 1)
      saved = {
        pos: C3.clone(cam.positionWC, new C3()),
        dir: C3.clone(cam.directionWC, new C3()),
        up: C3.clone(cam.upWC, new C3()),
      }
      cam.lookRight(wave(t, [[0.077, 0.62], [0.26, 0.26], [0.77, 0.12]]) * k)
      cam.lookUp(wave(t + 3.7, [[0.063, 0.58], [0.29, 0.28], [0.91, 0.14]]) * k)
      cam.twistRight(wave(t + 11.3, [[0.049, 0.50], [0.203, 0.22]]) * k * 0.5) // klopení jen poloviční
    }
    const onPost = () => {
      if (!saved) return
      cam.setView({ destination: saved.pos, orientation: { direction: saved.dir, up: saved.up } })
      saved = null
    }
    scene.preRender.addEventListener(onPre)
    scene.postRender.addEventListener(onPost)
    // Odhlášení stačí odebrat posluchače (jen splice v poli, bezpečné i po zničení scény).
    // Kameru tu nesrovnáváme zpátky — cleanup přichází jen se zánikem komponenty, kdy už
    // viewer stejně mizí, a `cam.setView` na zničené scéně by spadl.
    return () => {
      scene.preRender.removeEventListener(onPre)
      scene.postRender.removeEventListener(onPost)
    }
  }, [])

  /**
   * Plynulé přiblížení kolečkem.
   *
   * Cesium na každý zářez kolečka kameru posune skokem — při rychlejším rolování to nadskakuje.
   * Kolečko si proto bereme sami (WHEEL jsme mu odebrali při inicializaci): každý zářez se
   * přičte do „nedojetého“ zoomu a ten k nule dotáhne kriticky tlumená pružina, takže se pohyb
   * plynule rozjede i doklouže — bez kopnutí na začátku a bez přestřelení na konci.
   *
   * Krok je NÁSOBNÝ vůči výšce nad terénem — u země jemný, z výšky velký. Výška nad elipsoidem
   * by u kopců lhala (terén v Liberci je ~400 m), proto se výška terénu odečítá.
   *
   * Běží v `preUpdate`, tedy mimo okno mezi pre/postRender, kde sedí chvění kamery — jinak by
   * si obojí přepisovalo pozici. Sražení s terénem řeší ovladač až v dalším cyklu, takže si krok
   * omezujeme sami; bez toho kamera na jeden snímek propadne pod zem, než ji vytlačí zpátky.
   */
  const zoomRef = useRef(0) // nedojetý zoom v log jednotkách (+ = přiblížit)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene, cam = scene.camera, canvas = scene.canvas
    const ssc = scene.screenSpaceCameraController

    const onWheel = (e: WheelEvent) => {
      if (!ssc.enableInputs) return // režimy, které si vstupy berou (posun modelu, malování dlaždic)
      e.preventDefault()
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) // řádky/stránky → pixely
      zoomRef.current = Cesium.Math.clamp(zoomRef.current - px * ZOOM_SENS, -ZOOM_MAX, ZOOM_MAX)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let last = performance.now()
    let zoomVel = 0 // rychlost pružiny (log jednotek/s) — musí přežít mezi snímky, jinak nemá setrvačnost
    const onPreUpdate = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000) // po přepnutí tabu ať to neskočí naráz
      last = now
      const rest = zoomRef.current
      if (Math.abs(rest) < 1e-4 && Math.abs(zoomVel) < 1e-4) { zoomRef.current = 0; zoomVel = 0; return }
      // Kriticky tlumená pružina táhne zbytek k nule. Prostý exponenciální doběh by na každý
      // zářez skočil z nuly rovnou na plnou rychlost — a právě to kopnutí je zbytkové cukání.
      // Pružina má rychlost spojitou, takže se pohyb rozjede i doklouže. Kriticky tlumená =
      // nejrychlejší možný náběh BEZ přestřelení, jinak by zoom na konci gumoval.
      // Tvar je semi-implicitní (jmenovatel), aby to bylo stabilní i při vynechaném snímku.
      const w = 2 / ZOOM_TAU
      zoomVel = (zoomVel - dt * w * w * rest) / (1 + 2 * w * dt + w * w * dt * dt)
      let step = -zoomVel * dt
      const cc = cam.positionCartographic
      const h = Math.max(3, cc.height - (scene.globe.getHeight(cc) ?? 0))
      zoomRef.current = rest - step
      if (step > 0) { // přibližování zastav nad zemí, oddalování omezovat netřeba
        const maxStep = Math.log(h / Math.max(1.5, ssc.minimumZoomDistance))
        if (step > maxStep) { step = Math.max(0, maxStep); zoomRef.current = 0; zoomVel = 0 } // u země zastav i pružinu
      }
      if (step !== 0) cam.zoomIn(h * (1 - Math.exp(-step))) // step < 0 → negativní posun = oddálení
    }
    scene.preUpdate.addEventListener(onPreUpdate)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      scene.preUpdate.removeEventListener(onPreUpdate)
    }
  }, [])

  // ── uložené pohledy kamery (přežijí refresh) ──
  function persistCamViews(vs: CamView[]) { setCamViews(vs); try { localStorage.setItem('geo.camviews', JSON.stringify(vs)) } catch { /* */ } }
  const currentLook = (): CamLook => ({ fov, bloom: bloomOn, dofOn, dofMode, dofFocal, dofBlur, dofRadius, dofFeather, shakeOn, shakeAmt })
  /**
   * Přejede vzhled na cílový během přeletu — stejně dlouho a stejnou easeInOut jako pohyb kamery,
   * takže obojí dosedne naráz.
   *
   * Nespojité věci se interpolovat nedají, každá se řeší jinak:
   *  - `dofMode` (kruh × vzdálenost) se rozhodne hned na začátku — mezi poloměrem kruhu a ohniskovou
   *    vzdáleností není co prolínat. Animují se pak už jen parametry cílového režimu.
   *  - `dofOn` se nepřepíná skokem: rozostření zůstane celou dobu zapnuté a přejíždí se jeho SÍLA
   *    z/na nulu, takže zapnutí i vypnutí vyblednou místo cvaknutí (stepSize 0 = žádné rozmazání).
   *  - `bloom` je jen přepínač, sepne se na konci.
   *  - `shakeOn`/`shakeAmt` jedou přes intenzitu jako rozostření (viz níž) — chvění patří k pohledu,
   *    takže se mezi záběry musí umět jak nasadit, tak utichnout.
   *
   * Stav Reactu se přepisuje AŽ na konci — nastavovat ho každý snímek by 3 s překreslovalo celou
   * komponentu. Slidery se proto rozhýbou až po doletu.
   */
  function animateCamLook(target: CamLook, dur = 3000) {
    // Při vypnuté prezentaci se efekty nezapínají — přílet na pohled by je jinak vrátil zpátky
    // a vypínač by nic neznamenal. Cílové hodnoty se ale schovají, takže zapnutí prezentace
    // navazuje na pohled, na kterém zrovna stojíš.
    let to = target
    if (!presentOn) {
      presentSnapRef.current = { dofOn: target.dofOn, bloom: target.bloom }
      to = { ...target, dofOn: false, bloom: false }
    }
    const from = currentLook()
    const token = ++lookAnimRef.current
    const mode = to.dofMode
    const anyDof = from.dofOn || to.dofOn
    const blurFrom = from.dofOn ? from.dofBlur : 0
    const blurTo = to.dofOn ? to.dofBlur : 0
    // Chvění se taky nepřepíná skokem: jede se přes jeho INTENZITU z/na nulu (stejný trik jako
    // u rozostření), takže se kamera rozechvěje i uklidní plynule místo cvaknutí. Chybějící
    // hodnoty (starší pohledy) znamenají vypnuto → přílet na takový pohled chvění zase utiší.
    const shakeFrom = from.shakeOn ? (from.shakeAmt ?? 0) : 0
    const shakeTo = to.shakeOn ? (to.shakeAmt ?? 0) : 0
    const anyShake = shakeFrom > 0 || shakeTo > 0
    const t0 = performance.now()
    const step = () => {
      const v = viewerRef.current
      if (!v || v.isDestroyed() || lookAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // stejná easeInOut jako orbit
      const mix = (a: number, b: number) => a + (b - a) * e
      applyFovRaw(mix(from.fov, to.fov))
      applyDofRaw({
        on: anyDof, mode,
        focal: mix(from.dofFocal, to.dofFocal), blur: mix(blurFrom, blurTo),
        radius: mix(from.dofRadius, to.dofRadius), feather: mix(from.dofFeather, to.dofFeather),
      })
      if (anyShake) shakeRef.current = { on: presentOn, amt: mix(shakeFrom, shakeTo) }
      if (t < 1) { requestAnimationFrame(step); return }
      // dosedni přesně na cíl a srovnej s ním stav ovládání
      setFov(to.fov); setBloomOn(to.bloom); applyBloom(to.bloom)
      setDofOn(to.dofOn); setDofMode(to.dofMode); setDofFocal(to.dofFocal); setDofBlur(to.dofBlur)
      setDofRadius(to.dofRadius); setDofFeather(to.dofFeather)
      applyDofRaw({ on: to.dofOn, mode: to.dofMode, focal: to.dofFocal, blur: to.dofBlur, radius: to.dofRadius, feather: to.dofFeather })
      // amt si při vypnutém chvění nechá poslední hodnotu, ať slider nespadne na nulu
      setShakeOn(to.shakeOn ?? false); setShakeAmt(to.shakeAmt ?? shakeAmt)
    }
    requestAnimationFrame(step)
  }
  function saveCamView() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const c = v.camera, pos = c.positionWC
    persistCamViews([...camViews, { id: `v${Date.now()}`, name: camName.trim() || `Pohled ${camViews.length + 1}`, dest: [pos.x, pos.y, pos.z], h: c.heading, p: c.pitch, r: c.roll, look: currentLook() }])
    setCamName('')
  }
  /** přepíše kameru i vzhled uloženého pohledu aktuálním stavem (pohled zůstane na svém místě v seznamu) */
  function updateCamView(i: number) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const c = v.camera, pos = c.positionWC
    persistCamViews(camViews.map((cv, j) => j === i ? { ...cv, dest: [pos.x, pos.y, pos.z], h: c.heading, p: c.pitch, r: c.roll, look: currentLook() } : cv))
  }
  function gotoCamView(cv: CamView) {
    setActiveViewId(cv.id)               // řídí, které popisky jsou vysunuté
    pulseLayerRef.current?.trigger(new Set(presentOn ? pulses.filter(p => p.views.includes(cv.id)).map(p => p.id) : []))
    if (cv.look) animateCamLook(cv.look) // starší pohledy `look` nemají → nastavení se nechá být
    if (orbitOn) orbitToCamView(cv); else gotoCamViewDirect(cv)
  }
  function gotoCamViewDirect(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    orbitAnimRef.current++ // zruš případný běžící orbit
    v.camera.flyTo({ destination: new Cesium.Cartesian3(cv.dest[0], cv.dest[1], cv.dest[2]), orientation: { heading: cv.h, pitch: cv.p, roll: cv.r }, duration: 3 })
  }
  // Přelet OBLOUKEM: kamera obíhá po nejkratším oblouku kolem STŘEDU aktuálního pohledu a přitom se
  // pořád dívá na ten střed → objekt uprostřed zůstane uprostřed. Konec = pozice uloženého pohledu.
  function orbitToCamView(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const C3 = Cesium.Cartesian3, M3 = Cesium.Matrix3
    const g = viewCenterGround(v)
    const P = C3.fromDegrees(g.lon, g.lat, g.height)               // pivot = na co koukám
    const startPos = C3.clone(v.camera.positionWC, new C3())
    const endPos = new C3(cv.dest[0], cv.dest[1], cv.dest[2])
    const oS = C3.subtract(startPos, P, new C3()), oE = C3.subtract(endPos, P, new C3())
    const magS = C3.magnitude(oS), magE = C3.magnitude(oE)
    if (magS < 1 || magE < 1) { gotoCamViewDirect(cv); return }     // degenerace → přímý let

    // Kam se ULOŽENÝ pohled dívá (v ECEF). Počítá se stejně, jako to dělá Cesium v Camera.setView3D:
    // heading posunutý o -90°, ze vzniklé rotační matice je směr sloupec 0 — a to celé v ENU rámci
    // cílové pozice. (Přes pickPosition to nešlo: čte depth buffer minulého snímku, tedy staré kamery.)
    const hpr = new Cesium.HeadingPitchRoll(cv.h - Cesium.Math.PI_OVER_TWO, cv.p, cv.r)
    const rotM = M3.fromQuaternion(Cesium.Quaternion.fromHeadingPitchRoll(hpr, new Cesium.Quaternion()), new M3())
    const enuEnd = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(endPos), new M3())
    const endDir = C3.normalize(M3.multiplyByVector(enuEnd, M3.getColumn(rotM, 0, new C3()), new C3()), new C3())

    // Oblouk dává smysl JEN když se oba pohledy dívají zhruba na totéž — obíhá se přece kolem
    // společného předmětu. Když jsem si mezitím odletěl jinam po mapě, pivot s uloženým pohledem
    // nesouvisí a orbit kolem něj by skončil úplně jinde. Změř, jak daleko paprsek uloženého
    // pohledu míjí pivot; když moc, leť napřímo.
    const toP = C3.subtract(P, endPos, new C3())
    const along = C3.dot(toP, endDir)
    const miss = C3.magnitude(C3.subtract(toP, C3.multiplyByScalar(endDir, along, new C3()), new C3()))
    if (along <= 0 || miss > 0.35 * magE) { gotoCamViewDirect(cv); return }

    // orbit ve sférických souřadnicích ENU rámce pivotu: zvlášť AZIMUT (otáčení do strany) a NÁKLON
    // (elevace) + vzdálenost → kamera obíhá kolem BOKU, ne přes vršek (zenit).
    const enuR = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(P), new M3())
    const enuRT = M3.transpose(enuR, new M3())
    const toLocal = (o: Cesium.Cartesian3) => M3.multiplyByVector(enuRT, C3.normalize(o, new C3()), new C3()) // ECEF→ENU
    const lS = toLocal(oS), lE = toLocal(oE)
    const azS = Math.atan2(lS.x, lS.y), azE = Math.atan2(lE.x, lE.y)                 // heading od severu
    const elS = Math.asin(Cesium.Math.clamp(lS.z, -1, 1)), elE = Math.asin(Cesium.Math.clamp(lE.z, -1, 1))
    let dAz = azE - azS; while (dAz > Math.PI) dAz -= 2 * Math.PI; while (dAz < -Math.PI) dAz += 2 * Math.PI // nejkratší

    // Orientace se interpoluje v heading/pitch/roll od SOUČASNÉ k uložené, a to stejnou easeInOut
    // jako pozice — tím jde otáčení i posun jedním gestem.
    //
    // Dřív se orientace držela „koukej na pivot" a na uloženou sjížděla až v posledních 45 %. To
    // dělalo trhnutí: pozice se kvůli easeInOut na konci téměř zastaví, takže se kamera dotáčela
    // (klidně o 19°) prakticky na místě. Interpolace headingu navíc změnu azimutu oblouku sama
    // kopíruje, takže když oba pohledy míří na týž předmět, zůstane uprostřed i bez dohánění.
    const hS = v.camera.heading, pS = v.camera.pitch, rS = v.camera.roll
    const shortest = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
    // Heading musí točit na TUTÉŽ stranu, kam obíhá pozice. Dřív se obojí rozhodovalo zvlášť
    // („nejkratší cesta“ pro azimut oblouku a nezávisle na tom pro heading) a u protilehlých
    // pohledů, kde je rozdíl kolem 180°, si to sem tam zvolilo opačná znaménka — kamera pak
    // obíhala doleva a otáčela se doprava, tedy se cestou přestala dívat na předmět a dotočila
    // se až na konci. Základ je proto swing oblouku a k němu jen nejkratší ZBYTEK, aby se
    // pořád dosedlo přesně na uložený heading.
    const dH = dAz + shortest(cv.h - hS - dAz), dP = cv.p - pS, dR = shortest(cv.r - rS)

    const token = ++orbitAnimRef.current
    const dur = 3000, t0 = performance.now(), tmp = new C3()
    const step = () => {
      if (v.isDestroyed() || orbitAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      if (t >= 1) {
        // Dosedni PŘESNĚ na uložený pohled, ne na dopočítanou orientaci — jinak kamera skončí na
        // správné pozici, ale natočená na starý pivot, což vypadá, jako by doletěla někam jinam.
        v.camera.setView({ destination: endPos, orientation: { heading: cv.h, pitch: cv.p, roll: cv.r } })
        return
      }
      const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // easeInOut
      const az = azS + dAz * te, el = elS + (elE - elS) * te, rng = magS + (magE - magS) * te
      const ch = Math.cos(el)
      const arc = M3.multiplyByVector(enuR, new C3(Math.sin(az) * ch, Math.cos(az) * ch, Math.sin(el)), new C3()) // ENU→ECEF
      const pos = C3.add(P, C3.multiplyByScalar(arc, rng, tmp), new C3())
      v.camera.setView({ destination: pos, orientation: { heading: hS + dH * te, pitch: pS + dP * te, roll: rS + dR * te } })
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  function delCamView(i: number) {
    const gone = camViews[i]?.id
    persistCamViews(camViews.filter((_, j) => j !== i))
    if (gone) {
      persistCallouts(callouts.map(c => c.views.includes(gone) ? { ...c, views: c.views.filter(x => x !== gone) } : c))
      persistPulses(pulses.map(p => p.views.includes(gone) ? { ...p, views: p.views.filter(x => x !== gone) } : p))
      if (activeViewId === gone) setActiveViewId(null)
    }
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!viewerReady || !v || v.isDestroyed()) return
    const layer = new PulseLayer(v)
    pulseLayerRef.current = layer
    layer.sync(pulses)
    return () => { layer.destroy(); pulseLayerRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady])
  useEffect(() => { pulseLayerRef.current?.sync(pulses) }, [pulses])

  // ── pulzující zvýraznění parcel ──
  function persistPulses(ps: PulseSet[]) { setPulses(ps); try { localStorage.setItem('geo.pulses', JSON.stringify(ps)) } catch { /* */ } }
  /** Okopíruje prstence PRÁVĚ vybraných parcel do nové sady — od té chvíle je na výběru nezávislá. */
  function addPulseFromSelection() {
    const rings = [...parcelsRef.current.values()]
      .map(p => p.ring.map(([lo, la]) => [lo, la] as [number, number]))
      .filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Nejdřív vyber parcely'); return }
    const set: PulseSet = { id: `pl${Date.now()}`, name: `${rings.length}× parcela`, rings, color: pulseColor, count: pulseCount, views: activeViewId ? [activeViewId] : [] }
    persistPulses([...pulses, set])
    if (!activeViewId) toast.info('Sada vznikla, ale není vybraný pohled — nemá se kde spustit')
  }
  function delPulse(id: string) { persistPulses(pulses.filter(p => p.id !== id)) }
  /** úprava už vytvořené sady — barva se přebarví za běhu, geometrie se nepřestavuje */
  function updatePulse(id: string, patch: Partial<PulseSet>) { persistPulses(pulses.map(p => p.id === id ? { ...p, ...patch } : p)) }
  function togglePulseHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistPulses(pulses.map(p => p.id !== id ? p
      : { ...p, views: on ? [...new Set([...p.views, activeViewId])] : p.views.filter(x => x !== activeViewId) }))
  }
  function playPulse(id: string) { pulseLayerRef.current?.trigger(new Set([id])) }
  /**
   * Hlavní vypínač prezentace: popisky, pulz a obrazové efekty (rozostření, bloom) naráz.
   * Vypnutí si pamatuje, co bylo zapnuté, takže zapnutí nevrací výchozí hodnoty, ale ty tvoje.
   */
  function togglePresent() {
    const nv = !presentOn
    setPresentOn(nv)
    if (!nv) {
      presentSnapRef.current = { dofOn, bloom: bloomOn }
      setDofOn(false); applyDof({ on: false })
      setBloomOn(false); applyBloom(false)
    } else {
      const snap = presentSnapRef.current
      if (snap) {
        setDofOn(snap.dofOn); applyDof({ on: snap.dofOn })
        setBloomOn(snap.bloom); applyBloom(snap.bloom)
      }
    }
    // Popisky si zajedou samy (řídí je visibleCallouts), pulz je ale primitiv — musí se říct hned.
    pulseLayerRef.current?.trigger(new Set(nv && activeViewId ? pulses.filter(p => p.views.includes(activeViewId)).map(p => p.id) : []))
  }

  // ── prezentační popisky (tečka + čára + bublina), vázané na uložené pohledy ──
  function saveCallouts(cs: Callout[]) { try { localStorage.setItem('geo.callouts', JSON.stringify(cs)) } catch { /* */ } }
  function persistCallouts(cs: Callout[]) { setCallouts(cs); saveCallouts(cs) }
  function updateCallout(id: string, patch: Partial<Callout>) {
    if (patch.dot || patch.frame || patch.size) {
      const { dot, frame, size } = { ...calloutStyleRef.current, ...patch }
      calloutStyleRef.current = { dot, frame, size }
    }
    persistCallouts(callouts.map(c => c.id === id ? { ...c, ...patch } : c))
  }
  function delCallout(id: string) { persistCallouts(callouts.filter(c => c.id !== id)); if (calloutSel === id) setCalloutSel(null) }
  /** zapne/vypne popisek v PRÁVĚ aktivním pohledu */
  function toggleCalloutHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistCallouts(callouts.map(c => c.id !== id ? c
      : { ...c, views: on ? [...new Set([...c.views, activeViewId])] : c.views.filter(x => x !== activeViewId) }))
  }

  // ── DOF / FOV / bloom ──
  type DofCfg = { on: boolean; mode: 'dist' | 'circle'; focal: number; blur: number; radius: number; feather: number }
  /**
   * Přepošle nastavení do post-process stages. Bere jen změněné hodnoty (`applyDof({ radius })`),
   * zbytek se dočte ze současného stavu — setState je asynchronní, takže spoléhat na něj by
   * znamenalo použít o krok starou hodnotu.
   *
   * Stage se zakládají líně a jen ta, která se opravdu používá: každá si drží vlastní framebuffery,
   * takže vyrobit obě dopředu by stálo paměť i výkon zbytečně.
   */
  function applyDofRaw(c: DofCfg) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const wantDist = c.on && c.mode === 'dist'
    const wantCircle = c.on && c.mode === 'circle'

    if (wantDist && !dofRef.current) dofRef.current = v.scene.postProcessStages.add(Cesium.PostProcessStageLibrary.createDepthOfFieldStage()) as Cesium.PostProcessStageComposite
    if (dofRef.current) {
      dofRef.current.enabled = wantDist
      if (wantDist) {
        const u = dofRef.current.uniforms as { focalDistance: number; stepSize: number; sigma: number }
        u.focalDistance = c.focal; u.stepSize = c.blur; u.sigma = Math.max(1, c.blur)
      }
    }

    if (wantCircle && !dofCircleRef.current) dofCircleRef.current = v.scene.postProcessStages.add(createCircleDofStage()) as Cesium.PostProcessStageComposite
    if (dofCircleRef.current) {
      dofCircleRef.current.enabled = wantCircle
      if (wantCircle) {
        const u = dofCircleRef.current.uniforms as CircleDofUniforms
        u.radius = c.radius; u.feather = c.feather; u.stepSize = c.blur; u.sigma = Math.max(1, c.blur)
      }
    }
    v.scene.requestRender()
  }
  function applyFovRaw(deg: number) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const f = v.scene.camera.frustum
    if (f instanceof Cesium.PerspectiveFrustum) f.fov = Cesium.Math.toRadians(deg)
  }

  // Veřejné obálky pro ovládání: ruční sáhnutí na slider ZRUŠÍ běžící přechod vzhledu, jinak by
  // ho příští snímek animace hned přepsal. Animace proto sahá na *Raw, ovládání na tyhle.
  function applyDof(o: Partial<DofCfg>) {
    lookAnimRef.current++
    applyDofRaw({ on: dofOn, mode: dofMode, focal: dofFocal, blur: dofBlur, radius: dofRadius, feather: dofFeather, ...o })
  }
  function applyFov(deg: number) { lookAnimRef.current++; applyFovRaw(deg) }
  function dofFocusCenter() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const dist = Math.round(Cesium.Cartesian3.distance(v.camera.positionWC, Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)))
    setDofFocal(dist); setDofOn(true); applyDof({ on: true, focal: dist })
  }
  function applyBloom(on: boolean) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    v.scene.postProcessStages.bloom.enabled = on
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
    else if (o.kind === 'parcel') {
      const pid = o.id.replace('parcel-', '')
      const p = parcelsRef.current.get(pid)
      if (p) { p.hidden = !vis; p.ents.forEach(en => { en.show = vis && parcelHl }) }
      measureRef.current.get(pid)?.forEach(en => { en.show = vis })
    }
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

  const activeView = camViews.find(cv => cv.id === activeViewId) ?? null
  // vysunuté jsou jen popisky patřící aktivnímu pohledu; bez pohledu nesvítí nic
  const visibleCallouts = new Set(presentOn && activeViewId ? callouts.filter(c => c.views.includes(activeViewId)).map(c => c.id) : [])

  // Sjetí k sekci, která právě vznikla. Sleduje se jen „je / není", ne obsah — jinak by panel
  // poskakoval při každé přidané parcele.
  const hasParcels = parcelCount > 0
  const hasTiles = tileCount > 0
  const hasRegion = regionChoices.length > 0 || regionParts.length > 0 || !!regionName
  const hasModelSel = !!placement
  const hasDistrict = districtsOn && !!selectedDistrict
  useEffect(() => { if (hasParcels) revealSection('parcely') }, [hasParcels])
  useEffect(() => { if (hasTiles) revealSection('dlazdice') }, [hasTiles])
  useEffect(() => { if (hasRegion) revealSection('uzemi') }, [hasRegion])
  useEffect(() => { if (hasModelSel) revealSection('model') }, [hasModelSel])
  useEffect(() => { if (hasDistrict) revealSection('mestcast') }, [hasDistrict])
  useEffect(() => { if (splatOn) revealSection('splat') }, [splatOn])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <CalloutLayer
        viewer={viewerReady ? viewerRef.current : null}
        callouts={callouts}
        visibleIds={visibleCallouts}
        selectedId={calloutSel}
        onPick={setCalloutSel}
        onMove={(id, off) => updateCallout(id, { off })}
      />

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

      {/* Levý panel — jediné místo pro ovládání. Dřív se panely otevíraly jeden přes druhý,
          takže se překrývaly; teď je vše v jednom sloupci ve sbalitelných sekcích. */}
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          title="Zobrazit panel"
          className="absolute left-3 top-3 z-20 rounded-lg border border-gray-700 bg-gray-900/85 p-1.5 text-gray-300 backdrop-blur hover:text-gray-100"
        ><ChevronRight size={16} /></button>
      )}
      <div className={`absolute inset-y-0 left-0 z-20 flex w-80 flex-col border-r border-gray-700 bg-gray-900/90 backdrop-blur transition-transform ${panelOpen ? '' : '-translate-x-full'}`}>
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-gray-700 p-2">
          {/* Navigace a hlavní vypínač prezentace na jednom řádku — dřív zabíraly dva. */}
          <div className="flex items-center gap-1">
            <button onClick={onBackToEditor} title="Zpět do editoru modelu" className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-gray-700">
              <Box size={14} /> Editor
            </button>
            <button
              onClick={togglePresent}
              title={presentOn ? 'Skrýt popisky a pulz' : 'Zobrazit popisky a pulz'}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${presentOn ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {presentOn ? <Eye size={14} /> : <EyeOff size={14} />} Prezentace
            </button>
            <div className="flex-1" />
            <button onClick={() => setPanelOpen(false)} title="Skrýt panel" className="rounded p-0.5 text-gray-500 hover:text-gray-200"><ChevronLeft size={16} /></button>
          </div>
          <form onSubmit={runSearch} className="flex items-center gap-1.5 rounded-lg bg-gray-800/70 p-1">
            <Search size={15} className="ml-1.5 shrink-0 text-gray-500" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Najít místo (např. Liberec)…"
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none"
            />
            {searchErr && <span className="shrink-0 text-xs text-amber-400">{searchErr}</span>}
            <button type="submit" disabled={searching} className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
              {searching ? <Loader2 size={14} className="animate-spin" /> : 'Jdi'}
            </button>
          </form>
        </div>

        {/* Jediná scrollovaná oblast. Pořadí sekcí kopíruje postup práce: podklad → výběr →
            co z výběru vzniklo → scéna → kamera → prezentace. Kontextové sekce (Parcely,
            Dlaždice, …) stojí hned pod tím, co je vyrobilo, a revealSection k nim odscrolluje. */}
        <div ref={panelScrollRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          <Section id="podklad" title="Podklad a překryvy" dflt={true} open={openSec} onToggle={toggleSec}>
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
            <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">Pozadí</div>
            <div className="flex flex-wrap items-center gap-1 px-1 max-w-[190px]">
              {BG_MODES.map(m => (
                <button key={m.id} onClick={() => setBgMode(m.id)} title={m.title}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${bgMode === m.id ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{m.label}</button>
              ))}
              {bgMode === 'vlastni' && (
                <input type="color" value={bgCustom} onChange={e => setBgCustom(e.target.value)} title="Barva pozadí"
                  className="h-5 w-7 shrink-0 cursor-pointer rounded border border-gray-700 bg-transparent p-0" />
              )}
            </div>
          </Section>
          {districtsOn && selectedDistrict && (
          <Section id="mestcast" title="Městská část" dflt={true} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <Sparkles size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{districtsRef.current.get(selectedDistrict)?.name}</span>
              <button onClick={() => selectDistrict('')} title="Zrušit zvýraznění" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
          </Section>
          )}
          <Section id="vyber" title="Výběr v mapě" dflt={true} open={openSec} onToggle={toggleSec}>
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
                {tileCount > 0 && (
                  <div className="max-w-[190px] text-[10px] leading-snug text-gray-500">
                    Kvalitu a export najdeš níž v sekci <span className="text-gray-300">Dlaždice</span>.
                  </div>
                )}
              </div>
            )}
          </Section>
          {parcelCount > 0 && (
          <Section id="parcely" title="Parcely" dflt={true} badge={parcelCount} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <MapPin size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{parcelCount}</span></span>
              <button onClick={clearAllParcels} title="Zrušit výběr všech parcel" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
            {cutoutBusy ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
                  {cutoutPct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(cutoutPct * 100))}%` }} />
                    : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{cutoutProgress || 'pracuji…'}</span>
                <button onClick={() => abortRef.current?.abort()} title="Zrušit stahování" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
              </div>
            ) : (
              <>
                {/* Dřív to byla jedna dlouhá řada tlačítek — teď zvlášť „jak to vypadá" a „co z toho vyleze". */}
                <div className="px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Zobrazení v mapě</div>
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={() => setParcelClip(m => m === 'hide' ? 'off' : 'hide')} title="Skrýt mapu (ortofoto/topo + terén + Google) uvnitř vybraných parcel" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'hide' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <EyeOff size={13} /> Skrýt parcelu
                  </button>
                  <button onClick={() => setParcelClip(m => m === 'only' ? 'off' : 'only')} title="Nechat jen vybrané parcely a ztlumit okolí — nastav okraj a viditelnost okolí" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'only' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Hexagon size={13} /> Jen parcelu
                  </button>
                </div>
                {ENABLE_GOOGLE_3D && (
                  <button onClick={() => setParcelClip(m => m === 'g3d' ? 'off' : 'g3d')} title="Topografická mapa všude + Google 3D realita JEN uvnitř vybraných parcel (potřebuje ion token)" className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelClip === 'g3d' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Building2 size={13} /> Google jen ve výběru
                  </button>
                )}
                {parcelClip !== 'off' && (
                  <label className="flex items-center gap-1.5" title="Rovnoměrně zvětšit (+) nebo zmenšit (−) hranici">
                    <span className="w-14 shrink-0 text-[11px] text-gray-400">Okraj</span>
                    <input type="range" min={-50} max={50} step={0.5} value={parcelBuffer} onChange={e => setParcelBuffer(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{parcelBuffer > 0 ? '+' : ''}{parcelBuffer.toFixed(1)} m</span>
                  </label>
                )}
                {parcelClip === 'g3d' && (
                  <label className="flex items-center gap-1.5" title="Průhlednost 3D reality ve výběru — 100 % = plné 3D (topo pod ním skryté), níž = prosvítá topo mapa">
                    <span className="w-14 shrink-0 text-[11px] text-gray-400">3D realita</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={googleAlpha} onChange={e => setGoogleAlpha(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(googleAlpha * 100)} %</span>
                  </label>
                )}
                {parcelClip === 'only' && (
                  <>
                    <label className="flex items-center gap-1.5" title="Viditelnost okolní ZEMĚ — 0 % = černá/skrytá, 100 % = plně vidět">
                      <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
                      <input type="range" min={0} max={1} step={0.05} value={okoliVis} onChange={e => setOkoliVis(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(okoliVis * 100)} %</span>
                    </label>
                    <div className="flex items-center gap-1" title="Okolní 3D budovy: skrýt (čistá izolace) nebo nechat vidět (kontext)">
                      <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolní 3D</span>
                      <button onClick={() => setKeep3DAround(false)} className={`rounded px-1.5 py-0.5 text-[11px] ${!keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>skrýt</button>
                      <button onClick={() => setKeep3DAround(true)} className={`rounded px-1.5 py-0.5 text-[11px] ${keep3DAround ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>zobrazit</button>
                    </div>
                  </>
                )}
                <div className="flex gap-1">
                  <button onClick={toggleParcelHighlight} title="Zap/vyp tyrkysové zvýraznění parcely (výběr i ořez zůstanou) — koukat na parcelu načisto" className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelHl ? 'bg-gray-800 text-gray-200 hover:bg-gray-700' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
                    {parcelHl ? <Eye size={13} /> : <EyeOff size={13} />} Zvýraznění
                  </button>
                  <button onClick={() => setParcelMeasure(m => !m)} title="Kóty délek u každé strany + výměra uprostřed parcely. Počítá se v S-JTSK jako v katastru, takže čísla lícují s výměrou z KN." className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ${parcelMeasure ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                    <Ruler size={13} /> Měření
                  </button>
                </div>
                {parcelMeasure && (
                  <div className="rounded-lg bg-gray-800/60 px-2 py-1 text-[11px] text-gray-300">
                    Výměra výběru: <span className="font-medium tabular-nums text-emerald-300">{fmtArea(measureSum.area)}</span>
                    <span className="text-[10px] text-gray-500"> z KN</span>
                    {Math.abs(measureSum.mapArea - measureSum.area) >= 1 && (
                      <div className="mt-0.5 text-[10px] text-gray-400" title="Spočítáno z geometrie mapy — lícuje s kótami po obvodu a s DXF exportem. Výměra v KN není z mapy přepočítaná, je zapsaná.">
                        z mapy <span className="tabular-nums">{fmtArea(measureSum.mapArea)}</span>
                      </div>
                    )}
                    {measureSum.note && <div className="mt-0.5 text-[10px] text-amber-400/90">{measureSum.note}</div>}
                  </div>
                )}
                <button onClick={resetClipping} title="Reset ořezu — vypnout masky i parcelový ořez, zobrazit celou mapu" className="flex items-center justify-center gap-1 rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700">
                  <RotateCcw size={13} /> Reset ořezu
                </button>
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export výběru</div>
                <button onClick={exportParcelCutout} title="Výřez terénu DMR 5G ořezaný na hranici výběru + zapečené ortofoto → zip (OBJ + MTL + JPEG + V-Ray) pro 3ds Max" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
                  <Download size={13} /> Terén + ortofoto (OBJ)
                </button>
                {base === 'google' && (
                  <button onClick={exportGoogleMesh} title="Vytáhnout mesh z Google 3D dlaždic pro vybranou oblast včetně fototextur (reference) → zip (OBJ + MTL + JPEG)" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                    <Download size={13} /> Google mesh + textury (OBJ)
                  </button>
                )}
                <button onClick={exportParcelsDxf} disabled={exporting} title="Export hranic parcel jako křivky (DXF pro 3ds Max)" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">
                  {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Hranice parcel (DXF)
                </button>
                <button onClick={captureParcelViews} title="Vyfotit vybranou budovu ze 4 stran (kamera obletí, počká na dokreslení) → zip PNG. Nejlepší v 3D realitě." className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-2 py-1.5 text-xs text-white hover:bg-violet-500">
                  <Image size={13} /> 4 pohledy (PNG)
                </button>
              </>
            )}
          </Section>
          )}
          {tileCount > 0 && (
          <Section id="dlazdice" title="Dlaždice" dflt={true} badge={tileCount} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5">
              <Grid3x3 size={14} className="shrink-0 text-cyan-400" />
              <span className="min-w-0 flex-1 text-sm text-gray-200">Vybráno: <span className="font-medium">{tileCount}</span> × {tileSize} m</span>
              <button onClick={clearTiles} title="Zrušit výběr dlaždic" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300">
                <Trash2 size={14} />
              </button>
            </div>
            {tileBusy ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-700">
                  {tilePct >= 0
                    ? <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.max(3, Math.round(tilePct * 100))}%` }} />
                    : <div className="h-full w-1/3 animate-pulse bg-emerald-500/70" />}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-300">{tileProgress || 'pracuji…'}</span>
                <button onClick={() => abortRef.current?.abort()} title="Zrušit stahování" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={14} /></button>
              </div>
            ) : (
              <>
                {/* Nastavení exportu bývalo nahoře ve „Výběru" — nastavovalo se jinde, než se exportovalo. */}
                <div className="px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Co přibalit</div>
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
                <div className="mt-0.5 px-0.5 text-[10px] uppercase tracking-wide text-gray-500">Kvalita</div>
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
                <div className="text-[10px] text-gray-500 leading-snug max-w-[190px]">
                  Vyveze se v reálných S-JTSK souřadnicích, bez posunu.
                </div>
                {(() => {
                  const n = gridSize({ ix: 0, iy: 0, size: tileSize }, meshStep)
                  const tris = tileCount * 2 * (n - 1) ** 2
                  const mb = estimateObjBytes(tileCount, tileSize, meshStep) / 1e6
                  const heavy = mb > 150
                  return (
                    <span className={`max-w-[190px] text-[10px] leading-snug ${heavy ? 'text-amber-400' : 'text-gray-500'}`} title={heavy ? 'Velký OBJ — zvaž řidší mřížku terénu nebo míň dlaždic' : undefined}>
                      {tris >= 1e6 ? `~${(tris / 1e6).toFixed(1)} M trojúh.` : `~${Math.round(tris / 1e3)} k trojúh.`}
                      {' · OBJ ~'}{mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`}
                    </span>
                  )
                })()}
                <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export výběru</div>
                <button onClick={exportTilesObj} title="Čistý terén DMR 5G s ortofoto texturou → zip s OBJ + MTL + JPEG pro 3ds Max" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500">
                  <Download size={13} /> Terén + ortofoto (OBJ)
                </button>
                <button onClick={exportStitchedMaps} title="Spojená 2D mapa přes výběr — ortofoto i topografická mapa jako jeden georeferencovaný obrázek (world file)" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500">
                  <Image size={13} /> Spojená mapa (2D)
                </button>
                {!LOCAL_TILES && (
                  <button onClick={loadLocal2DMap} title="Napéct ortofoto vybrané oblasti do localu jako dlaždicovou pyramidu (nativní rozlišení, kvalita se nezhoršuje s velikostí, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u větší oblasti to chvíli trvá), pak lokální/offline a uložené natrvalo. Nenapečené oblasti jedou dál z ČÚZK." className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500">
                    <ArrowDownToLine size={13} /> Načíst 2D lokálně
                  </button>
                )}
              </>
            )}
          </Section>
          )}
          {(regionChoices.length > 0 || regionParts.length > 0 || regionName) && (
          <Section id="uzemi" title="Správní území" dflt={true} open={openSec} onToggle={toggleSec}>
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
              <>
                <div className="flex items-center gap-1.5">
                  <Landmark size={14} className="shrink-0 text-cyan-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-200">Zvýrazněno: <span className="font-medium">{regionName}</span></span>
                  <button onClick={clearRegion} title="Zrušit zvýraznění území" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-red-300"><RotateCcw size={14} /></button>
                </div>
                <label className="flex items-center gap-1.5" title="Viditelnost okolí — 0 % = tmavé, 100 % = plně vidět">
                  <span className="w-14 shrink-0 text-[11px] text-gray-400">Okolí</span>
                  <input type="range" min={0} max={1} step={0.05} value={regionDim} onChange={e => setRegionDim(parseFloat(e.target.value))} className="min-w-0 flex-1 accent-emerald-500" />
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{Math.round(regionDim * 100)} %</span>
                </label>
                {cutoutBusy ? (
                  <div className="flex items-center gap-2">
                    <Loader2 size={13} className="shrink-0 animate-spin text-gray-300" />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{cutoutProgress || 'exportuji…'}</span>
                    <button onClick={() => abortRef.current?.abort()} title="Zrušit export" className="shrink-0 rounded p-0.5 text-gray-400 hover:text-red-300"><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <div className="mt-0.5 border-t border-gray-700 px-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gray-500">Export území</div>
                    <button onClick={exportRegionCutout} title="Výřez terénu DMR 5G + zapečené ortofoto ořezaný na hranici území → OBJ (velké území = hrubší mřížka / velký soubor)" className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2 py-1.5 text-xs text-white hover:bg-sky-500"><Download size={13} /> Terén + ortofoto (OBJ)</button>
                    <button onClick={exportRegionMaps} title="Spojená 2D mapa ořezaná na tvar území (jako výřez terénu) — ortofoto (PNG s alfou) + topo jako georeferencovaný obrázek (world file), okolí průhledné" className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-2 py-1.5 text-xs text-white hover:bg-teal-500"><Image size={13} /> Spojená mapa (2D)</button>
                    <button onClick={exportRegionKatastrDxf} disabled={exporting} title="Katastr území do DXF: hranice jednotlivých parcel (hladina PARCELY) + obrys území (HRANICE_UZEMI), reálné S-JTSK + výšky DMR → lícuje s Terén (OBJ) i dlaždicemi" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Katastr (DXF)</button>
                    <button onClick={exportRegionDxf} disabled={exporting} title="Jen obrys území jako uzavřená 3D křivka (DXF R12) drapovaná na DMR — lokální ENU rámec" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Obrys území (DXF)</button>
                    {!LOCAL_TILES && (
                      <button onClick={loadRegionLocal2D} title="Napéct ortofoto území do localu jako dlaždicovou pyramidu (nativní rozlišení, jde zoomovat hloub). Jednorázové stahování z ČÚZK (u velkého území to chvíli trvá), pak lokální/offline a uložené natrvalo." className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs text-white hover:bg-indigo-500"><ArrowDownToLine size={13} /> Načíst 2D lokálně</button>
                    )}
                  </>
                )}
              </>
            )}
          </Section>
          )}
          <Section id="import" title="Import" dflt={false} open={openSec} onToggle={toggleSec}>
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">
              <Upload size={15} /> Import modelu
            </button>
            <button onClick={() => dwgRef.current?.click()} disabled={drawingLoading} title="Nahrát výkres DXF/DWG a zobrazit ho na mapě (v S-JTSK se umístí na správné místo; DWG se převede přes WASM)" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
              {drawingLoading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Nahrát výkres (DXF/DWG)
            </button>
            <button onClick={() => loadSplat()} disabled={splatLoading || splatOn} title="TEST: načíst Gaussian splat (Schillerova rozhledna, Kryry) z Cesium ion a posadit na mapu" className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-fuchsia-600 hover:bg-fuchsia-500 text-white transition-colors disabled:opacity-50">
              {splatLoading ? <Loader2 size={15} className="animate-spin" /> : <Box size={15} />} Splat (Kryry)
            </button>
          </Section>
          {objects.length > 0 && (
          <Section id="scena" title="Scéna" dflt={true} badge={objects.length} open={openSec} onToggle={toggleSec}>
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
                  <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
                    <span className="w-10 shrink-0">Výška</span>
                    <input type="range" min={-100} max={100} step={0.5} value={drawH[did] ?? 0} onChange={e => setDrawingHeight(did, Number(e.target.value))} className="flex-1 min-w-0" />
                    <span className="w-10 text-right tabular-nums shrink-0">{(drawH[did] ?? 0).toFixed(1)} m</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] text-gray-400" onClick={e => e.stopPropagation()}>
                    <span className="w-10 shrink-0">Průhled.</span>
                    <input type="range" min={0.05} max={1} step={0.05} value={drawA[did] ?? 1} onChange={e => setDrawingAlpha(did, Number(e.target.value))} className="flex-1 min-w-0" />
                    <span className="w-10 text-right tabular-nums shrink-0">{Math.round((drawA[did] ?? 1) * 100)} %</span>
                  </div>
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
          </Section>
          )}
          {placement && (
          <Section id="model" title="Vybraný model" dflt={true} open={openSec} onToggle={toggleSec}>
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
          </Section>
          )}
          {splatOn && (
          <Section id="splat" title="Gaussian splat (test)" dflt={true} open={openSec} onToggle={toggleSec}>
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
          </Section>
          )}
          <Section id="kamera" title="Kamera a pohledy" dflt={false} badge={camViews.length} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1">
              <button onClick={camPerspective} title="Perspektivní pohled (běžná 3D kamera)" className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"><Mountain size={15} /> Persp.</button>
              <button onClick={camTopOrtho} title="Pohled shora (ortho — jako půdorys/plán)" className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"><MapIcon size={15} /> Shora</button>
            </div>
            {/* FOV */}
            <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2">
              <span className="text-gray-400 w-16 shrink-0">Zorný úhel</span>
              <input type="range" min={20} max={100} step={1} value={fov} onChange={e => { const d = Number(e.target.value); setFov(d); applyFov(d) }} className="flex-1 min-w-0" />
              <span className="w-8 text-right text-gray-300 tabular-nums">{fov}°</span>
            </label>
            {/* DOF */}
            <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={dofOn} onChange={e => { setDofOn(e.target.checked); applyDof({ on: e.target.checked }) }} className="accent-sky-500" />
                <span className="text-gray-200">Rozostření okrajů</span>
              </label>
              {dofOn && <>
                <div className="flex gap-1">
                  {([['circle', 'Kruh uprostřed'], ['dist', 'Podle vzdálenosti']] as const).map(([m, lbl]) => (
                    <button
                      key={m}
                      onClick={() => { setDofMode(m); applyDof({ mode: m }) }}
                      className={`flex-1 px-2 py-1 rounded-lg text-xs ${dofMode === m ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
                    >{lbl}</button>
                  ))}
                </div>
                {dofMode === 'circle' ? <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Velikost</span>
                    <input type="range" min={0.05} max={1.2} step={0.01} value={dofRadius} onChange={e => { const r = Number(e.target.value); setDofRadius(r); applyDof({ radius: r }) }} className="flex-1 min-w-0" title="Poloměr ostrého kruhu — 1,0 sahá k bližšímu okraji obrazovky" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(dofRadius * 100)} %</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Přechod</span>
                    <input type="range" min={0.01} max={0.8} step={0.01} value={dofFeather} onChange={e => { const f = Number(e.target.value); setDofFeather(f); applyDof({ feather: f }) }} className="flex-1 min-w-0" title="Šířka přechodu z ostrého do rozmazaného — nízká hodnota dá ostrou hranu kruhu" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(dofFeather * 100)} %</span>
                  </label>
                </> : <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-16 shrink-0">Ostří v</span>
                    <input type="range" min={10} max={3000} step={10} value={dofFocal} onChange={e => { const f = Number(e.target.value); setDofFocal(f); applyDof({ focal: f }) }} className="flex-1 min-w-0" />
                    <span className="w-12 text-right text-gray-300 tabular-nums">{dofFocal} m</span>
                  </label>
                  <button onClick={dofFocusCenter} className="px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-200">Zaostřit na střed pohledu</button>
                </>}
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Rozmazání</span>
                  <input type="range" min={1} max={7} step={0.5} value={dofBlur} onChange={e => { const b = Number(e.target.value); setDofBlur(b); applyDof({ blur: b }) }} className="flex-1 min-w-0" />
                  <span className="w-12 text-right text-gray-300 tabular-nums">{dofBlur}</span>
                </label>
              </>}
            </div>
            {/* Bloom */}
            <label className="flex items-center gap-1.5 text-xs border-t border-gray-700 pt-2 cursor-pointer">
              <input type="checkbox" checked={bloomOn} onChange={e => { setBloomOn(e.target.checked); applyBloom(e.target.checked) }} className="accent-sky-500" />
              <span className="text-gray-200">Bloom (jemná záře)</span>
            </label>
            {/* Handheld — jemné chvění pohledu; ukládá se s pohledem, běží jen v prezentaci */}
            <div className="flex flex-col gap-1.5 border-t border-gray-700 pt-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Jemné rozechvění pohledu jako z ruky. Ukládá se s pohledem (tlačítko Uložit / ikona fotoaparátu), takže si ho dáš jen na záběry, kterým sluší. Pracuje jen opticky — kamera, přelety ani ovládání myší se tím nemění.">
                <input type="checkbox" checked={shakeOn} onChange={e => setShakeOn(e.target.checked)} className="accent-sky-500" />
                <span className="text-gray-200">Kamera z ruky (jemné chvění)</span>
                {shakeOn && !presentOn && <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">jen v prezentaci</span>}
              </label>
              {shakeOn && (
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-16 shrink-0">Intenzita</span>
                  <input type="range" min={0.05} max={1} step={0.05} value={shakeAmt} onChange={e => setShakeAmt(Number(e.target.value))} className="flex-1 min-w-0" title="Délka tahu — i na 100 % je to asi stupeň, tedy pomalé plutí, ne třas" />
                  <span className="w-12 text-right text-gray-300 tabular-nums">{Math.round(shakeAmt * 100)} %</span>
                </label>
              )}
            </div>
            {/* uložené pohledy */}
            <div className="flex flex-col gap-1">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Uložené pohledy</div>
              <div className="flex gap-1">
                <input value={camName} onChange={e => setCamName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveCamView() }} placeholder="název pohledu…" className="flex-1 min-w-0 bg-gray-800 rounded px-1.5 py-1 text-xs text-gray-100 outline-none placeholder:text-gray-600" />
                <button onClick={saveCamView} title="Uložit aktuální pohled kamery" className="px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white">Uložit</button>
              </div>
              {camViews.map((cv, i) => (
                <div key={i} className="flex items-center gap-1">
                  <button
                    onClick={() => gotoCamView(cv)}
                    title={cv.look ? 'Přeletět a nastavit uložený zorný úhel a rozostření' : 'Přeletět. Tenhle pohled je z dřívějška a vzhled uložený nemá — přepiš ho ikonou fotoaparátu.'}
                    className="flex-1 min-w-0 text-left truncate px-1.5 py-0.5 rounded text-xs bg-gray-800 hover:bg-sky-600 hover:text-white text-gray-200"
                  >
                    {cv.name}{!cv.look && <span className="ml-1 text-[9px] text-gray-500">bez vzhledu</span>}
                  </button>
                  <button onClick={() => updateCamView(i)} title="Přepsat tento pohled aktuální kamerou i nastavením" className="p-0.5 rounded text-gray-500 hover:text-emerald-300"><Camera size={13} /></button>
                  <button onClick={() => delCamView(i)} title="Smazat" className="p-0.5 rounded text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                </div>
              ))}
              {!camViews.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — natoč si kameru, napiš název a dej „Uložit". Uloží se i zorný úhel, rozostření a chvění kamery. Přežijí refresh.</div>}
              <label className="flex items-center gap-1.5 text-xs cursor-pointer mt-0.5" title="Kamera nepoletí napřímo, ale obloukem kolem toho, na co zrovna koukáš — objekt uprostřed zůstane uprostřed.">
                <input type="checkbox" checked={orbitOn} onChange={e => setOrbitOn(e.target.checked)} className="accent-sky-500" />
                <span className="text-gray-200">Přelet obloukem (orbit kolem středu)</span>
              </label>
            </div>
          </Section>
          {/* Popisky i pulz visí na uloženém pohledu a řídí je vypínač „Prezentace" nahoře —
              patří k sobě, tak jsou v jedné sekci a ne rozstrkané pod kamerou. */}
          <Section id="prezentace" title="Prezentace" dflt={false} badge={callouts.length + pulses.length} open={openSec} onToggle={toggleSec}>
            <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="shrink-0">Pohled:</span>
              <span className="min-w-0 flex-1 truncate text-gray-300">{activeView ? activeView.name : 'žádný'}</span>
              {!presentOn && <span className="shrink-0 text-amber-500/80">vypnutá</span>}
            </div>
            {!activeViewId && !!(callouts.length || pulses.length) && (
              <div className="text-[10px] leading-snug text-amber-500/80">Není vybraný pohled, takže je vše zasunuté. Klikni na některý uložený pohled v sekci „Kamera a pohledy".</div>
            )}
            <Section id="popisky" title="Popisky" dflt={false} badge={callouts.length} open={openSec} onToggle={toggleSec}>
              <button
                onClick={() => setCalloutMode(m => !m)}
                className={`px-2 py-1 rounded-lg text-xs ${calloutMode ? 'bg-sky-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
              >{calloutMode ? 'Klikni do mapy…' : 'Přidat popisek'}</button>
              {callouts.map(c => (
                <div key={c.id} className={`flex flex-col gap-1 rounded p-1.5 ${calloutSel === c.id ? 'bg-sky-900/40 ring-1 ring-sky-700' : 'bg-gray-800/50'}`}>
                  <div className="flex items-center gap-1">
                    <input
                      value={c.text}
                      onChange={e => updateCallout(c.id, { text: e.target.value })}
                      onFocus={() => setCalloutSel(c.id)}
                      className="flex-1 min-w-0 bg-gray-900 rounded px-1.5 py-0.5 text-xs text-gray-100 outline-none"
                    />
                    <button onClick={() => delCallout(c.id)} title="Smazat popisek" className="p-0.5 rounded text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                    <input type="color" value={c.dot ?? DOT_DEFAULT} onChange={e => updateCallout(c.id, { dot: e.target.value })} title="Barva tečky" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <input type="color" value={c.frame ?? FRAME_DEFAULT} onChange={e => updateCallout(c.id, { frame: e.target.value })} title="Barva rámečku a odpichové čáry" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <input type="range" min={9} max={26} step={1} value={c.size ?? SIZE_DEFAULT} onChange={e => updateCallout(c.id, { size: Number(e.target.value) })} title="Velikost textu" className="min-w-0 flex-1 accent-sky-500" />
                    <span className="w-9 shrink-0 text-right tabular-nums text-gray-500">{c.size ?? SIZE_DEFAULT} px</span>
                  </div>
                  <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se popisek ukáže' : 'Nejdřív vyber uložený pohled'}>
                    <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && c.views.includes(activeViewId)} onChange={e => toggleCalloutHere(c.id, e.target.checked)} className="accent-sky-500" />
                    <span>Ukázat v tomto pohledu</span>
                    <span className="ml-auto tabular-nums text-gray-500">{c.views.length}×</span>
                  </label>
                </div>
              ))}
              {!callouts.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber pohled, dej „Přidat popisek" a klikni do mapy. Bublinu pak přetáhneš myší.</div>}
            </Section>
            <Section id="pulz" title="Pulz parcel" dflt={false} badge={pulses.length} open={openSec} onToggle={toggleSec}>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <input type="color" value={pulseColor} onChange={e => setPulseColor(e.target.value)} title="Barva pulzu" className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                <span className="shrink-0">pulzů</span>
                <input type="range" min={1} max={12} step={1} value={pulseCount} onChange={e => setPulseCount(Number(e.target.value))} title="Kolikrát to blikne, pak přestane" className="min-w-0 flex-1 accent-sky-500" />
                <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{pulseCount}</span>
              </div>
              <button
                onClick={addPulseFromSelection}
                disabled={!parcelCount}
                title="Zapamatuje si tvar právě vybraných parcel jako novou sadu"
                className="rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-gray-800"
              >Přidat z vybraných parcel ({parcelCount})</button>
              {pulses.map(p => (
                <div key={p.id} className="flex flex-col gap-1 rounded bg-gray-800/50 p-1.5">
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={p.color} onChange={e => updatePulse(p.id, { color: e.target.value })} title="Barva této sady" className="h-4 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-200">{p.name}</span>
                    <button onClick={() => playPulse(p.id)} title="Přehrát teď" className="rounded p-0.5 text-gray-400 hover:text-sky-300"><Play size={13} /></button>
                    <button onClick={() => delPulse(p.id)} title="Smazat sadu" className="rounded p-0.5 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                    <span className="shrink-0">pulzů</span>
                    <input type="range" min={1} max={12} step={1} value={p.count} onChange={e => updatePulse(p.id, { count: Number(e.target.value) })} className="min-w-0 flex-1 accent-sky-500" />
                    <span className="w-4 shrink-0 text-right tabular-nums text-gray-500">{p.count}</span>
                  </div>
                  <label className={`flex items-center gap-1.5 text-[11px] ${activeViewId ? 'cursor-pointer text-gray-300' : 'text-gray-600'}`} title={activeViewId ? 'Ve kterých pohledech se pulz spustí' : 'Nejdřív vyber uložený pohled'}>
                    <input type="checkbox" disabled={!activeViewId} checked={!!activeViewId && p.views.includes(activeViewId)} onChange={e => togglePulseHere(p.id, e.target.checked)} className="accent-sky-500" />
                    <span>Spustit v tomto pohledu</span>
                    <span className="ml-auto tabular-nums text-gray-500">{p.views.length}×</span>
                  </label>
                </div>
              ))}
              {!pulses.length && <div className="text-[10px] text-gray-600 leading-snug">Zatím žádné — vyber parcely v mapě, nastav barvu a počet a dej „Přidat". Tvar se uloží, takže přežije refresh i zrušení výběru.</div>}
            </Section>
          </Section>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-gray-700 px-2 py-1.5">
          {/* Obojí je „co leží na disku prohlížeče" — dřív byly napečené dlaždice sekcí nahoře
              a cache dole, takže spolu zdánlivě nesouvisely. */}
          {bakedInfo > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
              <span title="Ortofoto napečené do localu — mapa jede offline a jde zoomovat hloub.">
                Lokální mapa: <span className="text-gray-300">{bakedInfo}</span> dl. · ~{Math.round(bakedInfo * 0.06)} MB
              </span>
              <button
                onClick={clearBaked}
                title="Smazat celou lokální mapu (napečené dlaždice) — zpět na živé ČÚZK"
                className="shrink-0 text-gray-500 hover:text-red-300"
              >smazat</button>
            </div>
          )}
          {cacheInfo.count > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-gray-500">
              <span title="Data terénu a mapy uložená na disku prohlížeče (přežijí refresh, zrychlují návraty). LRU maže nejstarší přes strop.">
                Cache: {(cacheInfo.bytes / 1e6).toFixed(0)} MB · {cacheInfo.count} pol.
              </span>
              <button
                onClick={() => cacheClear().then(refreshCache)}
                title="Smazat data z disku prohlížeče (cache terénu a mapy)"
                className="shrink-0 text-gray-500 hover:text-red-300"
              >vymazat</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
