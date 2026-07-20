/**
 * Dlaždice terénu: čistý DMR 5G blok + ortofoto zapečené jako textura, pro 3ds Max.
 *
 * Celý řetězec běží v S-JTSK (EPSG:5514) — DMR i ortofoto to ČÚZK umí vydat nativně
 * (`bboxSR=5514&imageSR=5514`), takže dlaždice je skutečný čtverec, textura na ni sedí 1:1
 * a UV je jen poloha ve čtverci. Nic se po cestě nepřevzorkovává.
 *
 * Ruční workflow (stáhnout celé mapové listy DMR + ortofota a pospojovat je) je artefakt
 * stahovacího portálu ČÚZK; ImageServer i MapServer berou libovolný bbox, takže skládání odpadá.
 *
 * Modul je záměrně bez Cesia i Reactu (jen proj4 + geotiff), aby šel testovat i mimo prohlížeč.
 */
import proj4 from 'proj4'
import { fromArrayBuffer } from 'geotiff'

// S-JTSK / Křovák — 7-parametrový Helmert (posun se srovná na ~decimetry).
// Definuje se tady, protože tenhle modul se načítá jako první; MapView spoléhá na tenhle def.
proj4.defs('EPSG:5514', '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=572.213,85.334,461.94,4.9732,1.529,5.2484,3.5378 +units=m +no_defs')

export const TILE_SIZES = [250, 500, 1000] as const
export type TileSize = (typeof TILE_SIZES)[number]

// Krok mřížky terénu. ImageServer má nativní pixel 2 m (jeho ?f=json), ALE to je rasterizace,
// kterou ČÚZK udělal z původního bodového mračna DMR 5G — a to má reálně jen 0,13 bodu/m²,
// tedy průměrnou rozteč ~2,78 m (ověřeno na hlavičce listu LIBE23.laz: 648 917 bodů na 5 km²).
// Krok 2 m proto vzorkuje HUSTĚJI než zdroj a jen interpoluje mezi body, které tam nejsou.
// Výchozí 3 m = zhruba zdrojová rozteč: polovina trojúhelníků, prakticky bez ztráty informace.
export const MESH_STEPS = [2, 3, 5, 10] as const
export type MeshStep = (typeof MESH_STEPS)[number]
export const MESH_STEP_DEFAULT: MeshStep = 3

// Ortofoto ČÚZK má 20 cm/px → na 500m dlaždici je 2048 zhruba nativní, 4096 už jen převzorkovává.
export const TEX_SIZES = [1024, 2048, 4096] as const
export type TexSize = (typeof TEX_SIZES)[number]

const ORTO_EXPORT = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer/export'
const DMR_EXPORT = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage'

export type Tile = { ix: number; iy: number; size: number }
export type Offset = { x: number; y: number; z: number }
export type TileGrid = { n: number; h: Float32Array }

export const tileKey = (t: Tile) => `${t.size}/${t.ix}/${t.iy}`
export const tileName = (t: Tile) => `dlazdice_${t.ix}_${t.iy}`

export const sjtskOf = (lon: number, lat: number) => proj4('EPSG:4326', 'EPSG:5514', [lon, lat]) as [number, number]
export const wgsOf = (x: number, y: number) => proj4('EPSG:5514', 'EPSG:4326', [x, y]) as [number, number]

/** Mřížka je zarovnaná na S-JTSK → dlaždice jsou skutečné čtverce a vždy na sebe navazují. */
export function tileAt(lon: number, lat: number, size: number): Tile {
  const [x, y] = sjtskOf(lon, lat)
  return { ix: Math.floor(x / size), iy: Math.floor(y / size), size }
}

export function tileBounds(t: Tile) {
  return { x0: t.ix * t.size, y0: t.iy * t.size, x1: (t.ix + 1) * t.size, y1: (t.iy + 1) * t.size }
}

/** bbox celého výběru v S-JTSK */
export function tilesBounds(tiles: Tile[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const t of tiles) {
    const b = tileBounds(t)
    minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1)
    minY = Math.min(minY, b.y0); maxY = Math.max(maxY, b.y1)
  }
  return { minX, minY, maxX, maxY }
}

/** Obrys dlaždice ve WGS84 — hrany zhuštěné, protože přímka v Křováku je ve WGS84 mírně zakřivená. */
export function tileRingLL(t: Tile, per = 8): number[] {
  const { x0, y0, x1, y1 } = tileBounds(t)
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const out: number[] = []
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % 4]
    for (let k = 0; k < per; k++) {
      const s = k / per
      const [lon, lat] = wgsOf(ax + (bx - ax) * s, ay + (by - ay) * s)
      out.push(lon, lat)
    }
  }
  return out
}

/** Souběžné zpracování s omezením (ČÚZK nemá rád desítky requestů naráz). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }))
  return out
}

/** Počet uzlů na stranu pro zadaný krok. */
export const gridSize = (t: Tile, step: number) => Math.max(2, Math.round(t.size / step) + 1)

/**
 * Skutečný krok mřížky. Požadovaný krok nemusí velikost dlaždice dělit beze zbytku (500 / 3 !),
 * takže se dopočítá z počtu uzlů. Díky tomu leží krajní uzly VŽDY přesně na hranách dlaždice
 * (x0 a x1) a sousední dlaždice na sebe navazují, ať je krok jakýkoliv.
 */
export const stepOf = (t: Tile, n: number) => t.size / (n - 1)

/**
 * Výšky DMR 5G pro dlaždici jako pravidelná mřížka n×n uzlů, v S-JTSK.
 * bbox se roztáhne o půl buňky → středy pixelů padnou PŘESNĚ na uzly mřížky, takže sousední
 * dlaždice čtou na společné hraně tytéž hodnoty a v Maxu mezi nimi není šev.
 * (Ověřeno proti živým datům: rozdíl na sdílené hraně je 0.000000 m.)
 */
export async function fetchTileHeights(t: Tile, step: number): Promise<TileGrid> {
  const { x0, y0, x1, y1 } = tileBounds(t)
  const n = gridSize(t, step)
  const half = stepOf(t, n) / 2
  const url = `${DMR_EXPORT}?bbox=${x0 - half},${y0 - half},${x1 + half},${y1 + half}&bboxSR=5514&imageSR=5514&size=${n},${n}&format=tiff&pixelType=F32&f=image`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`DMR 5G: HTTP ${res.status}`)
  const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
  if (img.getWidth() !== n || img.getHeight() !== n) throw new Error(`DMR 5G vrátil ${img.getWidth()}×${img.getHeight()}, čekal ${n}×${n}`)
  const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
  const h = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) {
    const e = r[i] as number
    h[i] = Number.isFinite(e) && e > -500 && e < 3000 ? e : NaN
  }
  return { n, h }
}

/** Ortofoto pro dlaždici — stejný bbox v 5514, takže obrázek kryje čtverec přesně (UV bez zkreslení).
 *  Vrací syrové JPEG bajty ze serveru: do zipu jdou beze změny, tedy bez překódování a ztráty kvality. */
export async function fetchTileOrtho(t: Tile, texSize: number): Promise<Uint8Array> {
  const { x0, y0, x1, y1 } = tileBounds(t)
  const url = `${ORTO_EXPORT}?bbox=${x0},${y0},${x1},${y1}&bboxSR=5514&imageSR=5514&size=${texSize},${texSize}&format=jpg&f=image`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Ortofoto: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Dlaždice → OBJ text v ROVINĚ S-JTSK mínus posun: X/Y = Křovák (EPSG:5514), Z = výška Bpv.
 * Záměrně ne ENU: mřížkový sever Křováku je od pravého severu odkloněný o ~7° (meridiánová
 * konvergence), takže ENU rámec by se s daty, co z Maxu chodí v reálném S-JTSK, neshodoval.
 * Indexy v OBJ jsou globální a 1-based přes celý soubor → proto vBase.
 * Krok se dopočítá z mřížky (stepOf), ať nemůže rozejít s tím, čím se stahovaly výšky.
 */
export function buildTileObj(t: Tile, grid: TileGrid, off: Offset, fallbackH: number, vBase: number): string {
  const { x0, y1 } = tileBounds(t)
  const n = grid.n
  const step = stepOf(t, n)
  // `o` i `g` — různé importéry čtou různé (Max si stejně jména po svém přepisuje,
  // proto vray_material.ms hledá dlaždice podle textury, ne podle jména)
  const L: string[] = [`o ${tileName(t)}`, `g ${tileName(t)}`, `usemtl ${tileName(t)}`]
  // řádek 0 rastru = sever (maxY), sloupec 0 = západ (minX)
  for (let j = 0; j < n; j++) {
    const Y = (y1 - j * step - off.y).toFixed(3)
    for (let i = 0; i < n; i++) {
      const raw = grid.h[j * n + i]
      const z = (Number.isFinite(raw) ? raw : fallbackH) - off.z
      L.push(`v ${(x0 + i * step - off.x).toFixed(3)} ${Y} ${z.toFixed(3)}`)
    }
  }
  // v=1 je horní okraj JPEG = řádek 0 rastru = sever → sever zůstane severem, bez zrcadlení
  for (let j = 0; j < n; j++) {
    const v = (1 - j / (n - 1)).toFixed(6)
    for (let i = 0; i < n; i++) L.push(`vt ${(i / (n - 1)).toFixed(6)} ${v}`)
  }
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = vBase + j * n + i, b = a + 1, c = vBase + (j + 1) * n + i, d = c + 1
      L.push(`f ${a}/${a} ${c}/${c} ${b}/${b}`, `f ${b}/${b} ${c}/${c} ${d}/${d}`) // lícem nahoru (+Z)
    }
  return L.join('\n')
}

/** MTL: každá dlaždice vlastní materiál s vlastní ortofoto texturou vedle v zipu. */
export function buildMtl(tiles: Tile[]): string {
  const L: string[] = []
  for (const t of tiles) {
    const nm = tileName(t)
    L.push(`newmtl ${nm}`, 'Ka 0.000 0.000 0.000', 'Kd 1.000 1.000 1.000', 'Ks 0.000 0.000 0.000', 'd 1.0', 'illum 1', `map_Kd ${nm}.jpg`, '')
  }
  return L.join('\n')
}

/**
 * MAXScript, který po importu OBJ přepne dlaždice na VRayMtl s ortofotem v diffuse.
 *
 * Proč skript a ne materiál v souboru: MTL je Wavefront standard, který zná jen Kd/Ks/map_Kd —
 * o rendererech nemá tušení a VRayMtl v něm zapsat NEJDE. Max si při importu udělá Standard/
 * Physical materiál a tohle ho pak vymění. Bez V-Ray zůstane funkční samotné MTL.
 *
 * Záměrně BEZ diakritiky: starší Max čte .ms v systémové kódové stránce, ne v UTF-8.
 */
export function buildMaxScript(tiles: Tile[]): string {
  const files = tiles.map(t => `"${tileName(t)}.jpg"`).join(', ')
  // ASCII a bez dvojznacnosti — toLocaleString('cs-CZ') dava nezlomitelne mezery (U+00A0)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `/*
  Teren DMR 5G + ortofoto (CUZK) -- prepnuti dlazdic na VRayMtl + VRayBitmap.
  Vygenerovano: ${stamp} UTC

  Postup:
    1. Nastav V-Ray jako aktivni renderer -- F10 > Common > Assign Renderer > Production
       (kdyz rendruje Arnold, hlasi u VRayMtl "not supported, approximation will be used")
    2. Naimportuj teren.obj  -- File > Import; textury natahne teren.mtl
    3. Oznac dlazdice, kterym chces dat VRayMtl
       (kdyz neoznacis nic, skript si najde dlazdice z tohohle exportu sam)
    4. Spust tenhle skript   -- Scripting > Run Script

  Texturu bere z materialu, ktery objekt uz ma -- na jmenech objektu nezalezi,
  Max si je pri importu OBJ stejne prepisuje po svem.

  Pozn: funkce musi byt takhle nahore, ne vnorene. MAXScript nedovoli vnorene
  funkci sahnout na lokalni promenne te vnejsi ("No outer local variable references").
*/

-- textura z diffuse slotu, at uz je material Standard / Physical / VRayMtl
fn geoDiffuseTex m = (
    local t = undefined
    if m != undefined do (
        if t == undefined and (isProperty m #texmap_diffuse) do t = m.texmap_diffuse
        if t == undefined and (isProperty m #diffuseMap) do t = m.diffuseMap
        if t == undefined and (isProperty m #base_color_map) do t = m.base_color_map
    )
    t
)

-- cesta k souboru, at uz je to Bitmaptexture (.filename) nebo VRayBitmap (.HDRIMapName)
fn geoTexFile t = (
    if t == undefined do return undefined
    if (isProperty t #filename) and t.filename != undefined and t.filename != "" do return t.filename
    if (isProperty t #HDRIMapName) and t.HDRIMapName != undefined and t.HDRIMapName != "" do return t.HDRIMapName
    undefined
)

-- soubor textury materialu: nejdriv jak ho ma, pak vedle skriptu (kdyz se cesta rozbila)
fn geoTileFile m dir = (
    local p = geoTexFile (geoDiffuseTex m)
    if p == undefined do return undefined
    if doesFileExist p do return p
    local f = filenameFromPath p
    if dir != "" and (doesFileExist (dir + f)) do return (dir + f)
    undefined
)

-- VRayBitmap. POZOR: v MAXScriptu se trida jmenuje VRayHDRI -- "VRayBitmap" je jen novejsi
-- nazev v UI (docs: "previously known as VRayHDRI"). Zkusime obe jmena.
-- Cesta k souboru je HDRIMapName, ne filename. Bez V-Ray spadneme na Bitmaptexture.
fn geoMakeTex jpg = (
    local t = undefined
    if VRayHDRI != undefined do t = VRayHDRI()
    if t == undefined and VRayBitmap != undefined do t = VRayBitmap()
    if t != undefined then (
        if (isProperty t #HDRIMapName) then t.HDRIMapName = jpg
        else if (isProperty t #filename) do t.filename = jpg
        -- mapType 4 = "3ds Max standard" -> mapuje se podle Coordinates/UV, ne jako HDRI prostredi.
        -- Poradi v docs: 0 Angular, 1 Cubic, 2 Spherical, 3 Mirrored ball, 4 3ds Max standard.
        -- Kdyby ortofoto vyslo jako koule/zrcadlo, je to tahle hodnota.
        try (t.mapType = 4) catch ()
        -- Alfu ani barevny prostor neresime: JPEG alfu nema (docs: "1.0 if the image has no
        -- alpha channel") a Auto color space si u 8bit JPEGu sam urci sRGB.
    ) else (
        t = Bitmaptexture fileName:jpg
        t.alphaSource = 2            -- ortofoto je nepruhledne, zadna alfa
    )
    t.name = getFilenameFile jpg
    t
)

-- VRayMtl s toutez texturou v diffuse
fn geoToVRay m dir = (
    local jpg = geoTileFile m dir
    if jpg == undefined do return undefined
    local t = geoMakeTex jpg
    local v = VRayMtl name:(getFilenameFile jpg)
    v.diffuse = color 255 255 255
    v.texmap_diffuse = t
    v.texmap_diffuse_on = true
    v.reflection = color 0 0 0       -- teren nema byt leskly
    showTextureMap v t true          -- at je textura videt i ve viewportu
    v
)

-- hotovo = VRayMtl, ktery uz ma i VRayBitmap (ne jen klasickou Bitmaptexture).
-- Zamerne se neptame na jmeno tridy (VRayHDRI vs VRayBitmap), jen ze uz to neni Bitmaptexture
-- -> kdo pustil starsi verzi skriptu, muze ho pustit znovu a bitmapy se povysi.
fn geoIsDone m = (
    if (classOf m != VRayMtl) do return false
    local t = geoDiffuseTex m
    if t == undefined do return true
    (classOf t) != Bitmaptexture
)

-- vrati pocet prevedenych materialu na tomhle objektu
fn geoConvertNode obj dir = (
    local m = obj.material
    if m == undefined do return 0
    local n = 0
    if (classOf m == Multimaterial) then (
        -- Max umi dat vsem dlazdicim jeden multimaterial a rozlisovat je matID;
        -- submaterialy menime NA MISTE, aby prirazeni matID na facech zustalo
        for i = 1 to m.numsubs do (
            if not (geoIsDone m[i]) do (
                local v = geoToVRay m[i] dir
                if v != undefined do ( m[i] = v; n += 1 )
            )
        )
    ) else (
        if not (geoIsDone m) do (
            local v = geoToVRay m dir
            if v != undefined do ( obj.material = v; n += 1 )
        )
    )
    n
)

-- je to dlazdice z tohohle exportu? (podle nazvu textury)
fn geoIsTile obj tf = (
    local p = geoTexFile (geoDiffuseTex obj.material)
    if p == undefined do return false
    (findItem tf (toLower (filenameFromPath p))) > 0
)

-- Trida VRayMtl existuje, dokud je V-Ray NAINSTALOVANY -- to ale nestaci. Kdyz je aktivni
-- renderer treba Arnold, Max u kazdeho VRayMtl hlasi "not supported, approximation will be used".
fn geoRendererName = (
    local n = ""
    try (n = (classOf renderers.production) as string) catch ()
    n
)

fn geoRendererIsVRay = (
    matchPattern (geoRendererName()) pattern:"*V_Ray*" ignoreCase:true
)

fn geoApplyVRay tf = (
    if VRayMtl == undefined do (
        messageBox "V-Ray neni nacteny -- trida VRayMtl neexistuje.\\n\\nNastav V-Ray jako aktivni renderer a spust skript znovu." title:"Teren DMR 5G"
        return false
    )

    local dir = ""
    try (dir = getFilenamePath (getSourceFileName())) catch ()
    if dir == undefined do dir = ""

    -- co je oznacene, to se prevede; kdyz nic, najdi dlazdice z tohohle exportu
    local nodes = selection as array
    local usedSel = nodes.count > 0
    if not usedSel do nodes = (for o in geometry where (geoIsTile o tf) collect o)

    if nodes.count == 0 do (
        messageBox "Nenasel jsem zadne dlazdice.\\n\\nNaimportuj teren.obj (vcetne teren.mtl), nebo dlazdice oznac rucne a spust skript znovu." title:"Teren DMR 5G"
        return false
    )

    local done = 0
    local report = #()
    for obj in nodes do (
        local n = geoConvertNode obj dir
        done += n
        if n == 0 and report.count < 8 do (
            local m = obj.material
            local mn = if m == undefined then "(bez materialu)" else (m.name + " [" + (classOf m) as string + "]")
            local bm = geoTileBitmap m
            local bn = if bm == undefined then "(bez textury)" else filenameFromPath bm.filename
            append report ("  " + obj.name + "\\n      mat: " + mn + "\\n      tex: " + bn)
        )
    )

    local msg = if usedSel then ("Oznaceno: " + nodes.count as string + " objektu.\\n")
                else ("Nic nebylo oznaceno -- nasel jsem " + nodes.count as string + " dlazdic tohohle exportu.\\n")
    msg += "Prevedeno na VRayMtl + VRayBitmap: " + done as string
    if report.count > 0 do (
        msg += "\\n\\nBeze zmeny:\\n"
        for r in report do msg += (r + "\\n")
        msg += "\\nDuvod byva: objekt nema material s texturou, nebo uz je hotovy."
    )
    -- az na konec, at to neprehlidne: bez V-Ray jako rendereru se VRayMtl jen aproximuje
    if not (geoRendererIsVRay()) do (
        msg += "\\n\\n--------------------------------------------------\\n"
        msg += "POZOR: aktivni renderer neni V-Ray, ale " + geoRendererName() + ".\\n"
        msg += "Max proto u VRayMtl hlasi \\"not supported, an approximation\\nwill be used\\" a materialy se nezobrazi spravne.\\n\\n"
        msg += "Prepni: F10 > Common > Assign Renderer > Production > V-Ray\\n"
        msg += "(Material Editor si to prevezme, kdyz je zamknuty na produkcni.)"
    )
    messageBox msg title:"Teren DMR 5G"
    done > 0
)

geoApplyVRay #(${files})
`
}

/** Spojí kusy do jednoho pole. (Uint8Array<ArrayBuffer>, ať to Blob bere jako BlobPart.) */
export function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/**
 * Odhad velikosti teren.obj v bajtech. Řádek `v` je ~34 B (reálné S-JTSK jsou dlouhá čísla),
 * `vt` ~21 B, `f` ~50 B (šest indexů, u velkých výběrů sedmimístných).
 * Slouží k varování v UI — 50+ dlaždic při kroku 2 m dělá přes 500 MB textu.
 */
export function estimateObjBytes(tileCount: number, tileSize: number, step: number): number {
  const n = gridSize({ ix: 0, iy: 0, size: tileSize }, step)
  return tileCount * (n * n * 55 + 2 * (n - 1) ** 2 * 50)
}

/** Medián výšek přes všechny dlaždice — náhrada za případné díry v DMR. */
export function medianHeight(grids: TileGrid[]): number {
  const all: number[] = []
  for (const g of grids) for (const v of g.h) if (Number.isFinite(v)) all.push(v)
  if (!all.length) throw new Error('DMR 5G nevrátil pro vybrané dlaždice žádné platné výšky')
  all.sort((a, b) => a - b)
  return all[Math.floor(all.length / 2)]
}
