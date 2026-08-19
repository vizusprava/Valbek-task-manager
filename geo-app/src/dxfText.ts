/**
 * Texty z DXF jako GEOMETRIE ležící v rovině výkresu — ne jako Cesium.Label.
 *
 * Proč: `Cesium.Label` je podle dokumentace „viewport-aligned text", tedy billboard, který se vždy
 * natočí čelem ke kameře. Z toho plynou dvě věci, které se nedají nastavením obejít:
 *   1) nemá `rotation` (na rozdíl od `Billboard`), takže sklon textu z DXF se zahodí;
 *   2) velikost je v PIXELECH, ne v metrech — popisek zůstane stejně velký při každém zoomu,
 *      zatímco kresba se zvětšuje („autoscale").
 *
 * Tady se místo toho staví texturované čtyřúhelníky v rovině výkresu: výška je v metrech (group
 * code 40) a natočení v radiánech, takže výsledek odpovídá půdorysu v AutoCADu.
 *
 * Výkon: glyfy jdou do jednoho atlasu na barvu a celá barevná skupina je JEDEN Primitive, takže
 * desítky tisíc popisků neznamenají desítky tisíc draw callů.
 */
import * as Cesium from 'cesium'
import type { DrawPrim } from './dxf'

export type TextPrim = Extract<DrawPrim, { kind: 'text' }>

const EM = 64                                     // velikost glyfu v atlasu (px)
const PAD = 5                                     // rezerva, aby se do buňky vešel černý obrys
const CELL_W = Math.round(EM * 1.25) + PAD * 2
const CELL_H = Math.round(EM * 1.35) + PAD * 2
const BASE_Y = PAD + EM                           // účaří v buňce, měřeno od horní hrany
const MAX_ATLAS_W = 4096
const FONT = `${EM}px Arial, "Helvetica Neue", Helvetica, sans-serif`

// Rohy buňky v „em" jednotkách vůči peru na účaří (stejné pro všechny glyfy — buňky jsou shodné).
const QX0 = -PAD / EM, QX1 = (CELL_W - PAD) / EM
const QY0 = -(CELL_H - BASE_Y) / EM, QY1 = BASE_Y / EM

const MAT_TYPE = 'DxfGlyphAtlas'

/**
 * Vyhodí náš materiál z globální cache Cesia.
 *
 * Cesium si materiál POJMENOVANÉHO typu uloží do `Material._materialCache` (Material.js:736) a
 * každý DALŠÍ materiál téhož typu si její fabric HLUBOCE naklonuje (Material.js:722). Deep clone
 * dělá `new object.constructor()` — na canvasu to shodí celý import hláškou
 * „Failed to construct 'HTMLCanvasElement': Illegal constructor".
 *
 * Fabric proto canvas neobsahuje. To ale nestačí: `_materialCache._materials` je prostý modulový
 * objekt, který se nikdy nečistí a PŘEŽIJE i HMR — jeden otrávený záznam tak rozbíjí celou relaci
 * až do tvrdého reloadu. Úklid před každou konstrukcí to řeší natrvalo a zároveň brání tomu, aby
 * si cache po zbytek relace držela náš canvas i s texturou.
 */
function dropMaterialCache() {
  try {
    const cache = (Cesium.Material as unknown as { _materialCache?: { _materials?: Record<string, unknown> } })._materialCache
    if (cache?._materials) delete cache._materials[MAT_TYPE]
  } catch { /* privátní API — když ho Cesium přejmenuje, jen se neuklidí */ }
}

type GlyphBox = { u0: number; v0: number; u1: number; v1: number; adv: number }
type Atlas = { canvas: HTMLCanvasElement; glyphs: Map<string, GlyphBox>; capEm: number }

function buildAtlas(chars: string[], css: string): Atlas {
  const cols = Math.max(1, Math.min(chars.length, Math.floor(MAX_ATLAS_W / CELL_W)))
  const rows = Math.ceil(chars.length / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * CELL_W
  canvas.height = rows * CELL_H

  const ctx = canvas.getContext('2d')!
  ctx.font = FONT
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.strokeStyle = '#000'
  ctx.lineWidth = EM * 0.16
  ctx.fillStyle = css

  // Výška textu v DXF (kód 40) je výška VERZÁLEK, ne velikost em. Bez tohohle přepočtu vyjde
  // text zhruba o třetinu větší než v AutoCADu.
  const capEm = (ctx.measureText('H').actualBoundingBoxAscent || EM * 0.716) / EM

  const glyphs = new Map<string, GlyphBox>()
  chars.forEach((ch, i) => {
    const cx = (i % cols) * CELL_W, cy = Math.floor(i / cols) * CELL_H
    ctx.strokeText(ch, cx + PAD, cy + BASE_Y)
    ctx.fillText(ch, cx + PAD, cy + BASE_Y)
    glyphs.set(ch, {
      u0: cx / canvas.width, u1: (cx + CELL_W) / canvas.width,
      // canvas má osu Y dolů, textura v Cesiu nahoru → V se překlápí
      v0: 1 - (cy + CELL_H) / canvas.height, v1: 1 - cy / canvas.height,
      adv: ctx.measureText(ch).width / EM,
    })
  })
  return { canvas, glyphs, capEm }
}

export type TextBuild = { prims: Cesium.Primitive[]; mats: Cesium.Material[] }

export type TextBuildOpts = {
  texts: TextPrim[]
  /** kotva textu ve světě (přesně, stejnou cestou jako čáry — kvůli zakřivení a Křovákovi) */
  anchor: (x: number, y: number) => Cesium.Cartesian3
  /** sdílená ENU báze ve středu výkresu; pro posuny o metry v okolí kotvy stačí (chyba < 0,05°) */
  east: Cesium.Cartesian3
  north: Cesium.Cartesian3
  up: Cesium.Cartesian3
  /** stočení osy +X výkresu vůči východu — u S-JTSK je to konvergence poledníků, ta není nulová */
  conv: number
  colorCss: (rgb: number) => string
}

export function buildTextPrims(o: TextBuildOpts): TextBuild {
  const out: TextBuild = { prims: [], mats: [] }

  // jedna barva = jeden atlas = jeden Primitive (barva se zapéká do glyfů, aby stačil 1 draw call)
  const byColor = new Map<number, TextPrim[]>()
  for (const t of o.texts) {
    const arr = byColor.get(t.color)
    if (arr) arr.push(t); else byColor.set(t.color, [t])
  }

  for (const [color, texts] of byColor) {
    const chars = new Set<string>()
    for (const t of texts) for (const ch of t.text) chars.add(ch)
    if (!chars.size) continue
    const atlas = buildAtlas([...chars], o.colorCss(color))

    let nQuads = 0
    for (const t of texts) nQuads += [...t.text].length
    if (!nQuads) continue

    const positions = new Float64Array(nQuads * 4 * 3)
    const sts = new Float32Array(nQuads * 4 * 2)
    const normals = new Float32Array(nQuads * 4 * 3)
    const indices = new Uint32Array(nQuads * 6)
    let q = 0

    for (const t of texts) {
      const glyphList = [...t.text]
      let w = 0
      for (const ch of glyphList) w += atlas.glyphs.get(ch)?.adv ?? 0

      const scale = Math.max(t.height, 1e-3) / atlas.capEm  // metrů na 1 em
      const a = t.rot + o.conv
      const ca = Math.cos(a), sa = Math.sin(a)
      // zarovnání z DXF (72/73 u TEXTu, 71 u MTEXTu) posune celý řádek vůči kotvě
      let penX = t.hAlign === 1 ? -w / 2 : t.hAlign === 2 ? -w : 0
      const penY = t.vAlign === 1 ? -atlas.capEm / 2 : t.vAlign === 2 ? -atlas.capEm : 0
      const p0 = o.anchor(t.pt[0], t.pt[1])

      for (const ch of glyphList) {
        const g = atlas.glyphs.get(ch)
        if (!g) continue
        const cx = [QX0, QX1, QX1, QX0], cy = [QY0, QY0, QY1, QY1]
        const cu = [g.u0, g.u1, g.u1, g.u0], cv = [g.v0, g.v0, g.v1, g.v1]
        for (let k = 0; k < 4; k++) {
          const lx = penX + cx[k], ly = penY + cy[k]
          const dE = (lx * ca - ly * sa) * scale
          const dN = (lx * sa + ly * ca) * scale
          const vi = (q * 4 + k) * 3
          positions[vi] = p0.x + o.east.x * dE + o.north.x * dN
          positions[vi + 1] = p0.y + o.east.y * dE + o.north.y * dN
          positions[vi + 2] = p0.z + o.east.z * dE + o.north.z * dN
          normals[vi] = o.up.x; normals[vi + 1] = o.up.y; normals[vi + 2] = o.up.z
          sts[(q * 4 + k) * 2] = cu[k]
          sts[(q * 4 + k) * 2 + 1] = cv[k]
        }
        const b = q * 4, ii = q * 6
        indices[ii] = b; indices[ii + 1] = b + 1; indices[ii + 2] = b + 2
        indices[ii + 3] = b; indices[ii + 4] = b + 2; indices[ii + 5] = b + 3
        q++
        penX += g.adv
      }
    }
    if (!q) continue

    // pole se alokovala na horní odhad; když nějaký glyf vypadl, ořízni na skutečnou délku
    const pos = q === nQuads ? positions : positions.subarray(0, q * 12)
    const nor = q === nQuads ? normals : normals.subarray(0, q * 12)
    const st = q === nQuads ? sts : sts.subarray(0, q * 8)
    const idx = q === nQuads ? indices : indices.subarray(0, q * 6)

    const attributes = new Cesium.GeometryAttributes()
    attributes.position = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos })
    attributes.normal = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nor })
    attributes.st = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st })

    const geometry = new Cesium.Geometry({
      attributes,
      indices: idx,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      // fromVertices jen indexuje a čte .length, takže typované pole stačí — Array.from by u
      // velkého výkresu zbytečně alokovalo mnohamilionové boxované JS pole
      boundingSphere: Cesium.BoundingSphere.fromVertices(pos as unknown as number[]),
    })

    dropMaterialCache()
    const material = new Cesium.Material({
      translucent: true,
      fabric: {
        type: MAT_TYPE,
        // Canvas se sem NESMÍ dostat — viz dropMaterialCache. Fabric drží jen zástupný řetězec
        // a skutečná textura se dosadí až do hotového materiálu (Material.js:991 to podporuje).
        uniforms: { image: Cesium.Material.DefaultImageId, opacity: 1.0 },
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            vec4 c = texture(image, materialInput.st);
            m.diffuse = c.rgb;
            m.alpha = c.a * opacity;
            return m;
          }`,
      },
    })
    material.uniforms.image = atlas.canvas

    const prim = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: new Cesium.MaterialAppearance({
        material,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
        translucent: true,
        flat: true,          // bez osvětlení — text má mít přesně svou barvu
        faceForward: false,
        // stejně jako čáry výkresu: kreslí se přes vše, ať je vidět i pod terénem
        renderState: {
          depthTest: { enabled: false },
          depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND,
          cull: { enabled: false },
        },
      }),
      asynchronous: false,
    })

    out.prims.push(prim)
    out.mats.push(material)
  }
  dropMaterialCache() // ať si cache nedrží poslední atlas i s texturou po zbytek relace
  return out
}
