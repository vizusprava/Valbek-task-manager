/**
 * Pulzující zvýraznění vybraných parcel, vázané na uložené pohledy.
 *
 * Parcely se SLUČUJÍ unionem (polygon-clipping) do jednoho tvaru, takže sousední splynou a vnitřní
 * hranice zmizí.
 *
 * Vzhled řídí DISTANČNÍ MAPA od hranice, spočítaná na CPU do malé textury. Shader z ní čte, jak
 * daleko (v metrech) je pixel od obrysu — kladně uvnitř, záporně venku — a z toho skládá:
 *   - TĚLO: svítí uvnitř a měkce vyhasíná až FADE_OUT metrů ZA hranicí, takže hrana nikde neřeže.
 *   - RÁZ: gaussovský pruh, jehož vzdálenost putuje zevnitř ven.
 *
 * Proč distanční mapa a ne trojúhelníkový vějíř ze středu (první pokus): u nekonvexního tvaru —
 * a sloučené parcely bývají do L — se vějíř PŘEKRÝVÁ SÁM SE SEBOU a při průhledném míchání se
 * překryté klíny sčítají. Z toho byly vidět „paprsky". Každý trojúhelník měl navíc jiný gradient,
 * takže se pruh na švech lámal. Distanční mapa nic z toho nemá: je to hladké skalární pole, které
 * respektuje skutečný obrys včetně děr a víc oddělených kusů.
 *
 * Ploché a nedrapované schválně — jinak to nejde: `PolygonGeometryUpdater` posílá nekonstantní
 * ne-barevný materiál na terénu do pomalé dynamické větve a `ClassificationPrimitive` umí podle
 * dokumentace jen `PerInstanceColorAppearance`. Na rovině se to nepozná, na prudkém svahu se
 * zvýraznění s terénem rozejde.
 */
import * as Cesium from 'cesium'
import polygonClipping from 'polygon-clipping'

export type PulseSet = {
  id: string
  name: string
  rings: [number, number][][]   // prstence polygonů ve stupních (lon, lat)
  color: string                 // #rrggbb
  count: number                 // kolik pulzů a dost
  views: string[]               // id pohledů, ve kterých se spustí
}

export const PULSE_PERIOD_S = 1.0
export const PULSE_COLOR_DEFAULT = '#f59e0b'
export const PULSE_COUNT_DEFAULT = 5

const SDF_RES = 128       // distanční pole je velmi hladké, víc rozlišení nepřinese nic viditelného
const BODY_CORE = 0.4     // jas hluboko uvnitř vůči okraji; < 1 → nebliká celá plocha stejně

/**
 * Zdroj je schválně ČISTĚ ASCII a bez komentářů: GLSL ES vyžaduje ASCII a některé ovladače
 * non-ASCII odmítnou i uvnitř komentáře.
 *
 * Uniformy mají schválně víc než jedno písmeno. Cesium je v textu shaderu přepisuje regulárem
 * `([\w.])?token([\w])?` — u jednopísmenného názvu (`r`, `w`) rozhoduje jen to, co stojí vedle,
 * takže by ho stačilo omylem odemknout mezerou v komentáři.
 */
const WAVE_FS = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float raw = texture(sdfMap, materialInput.st).r;
  float dist = (raw - 0.5) * 2.0 * sdfRange;
  float edge = smoothstep(-fadeOut, fadeIn, dist);
  float rim = mix(1.0, ${BODY_CORE.toFixed(3)}, clamp(dist / rimSpan, 0.0, 1.0));
  float t = (dist - waveD) / waveW;
  float wave = exp(-t * t);
  m.diffuse = color.rgb;
  m.alpha = clamp(edge * rim * bodyA + edge * wave * waveA, 0.0, 1.0);
  return m;
}`

type Live = {
  set: PulseSet
  prim: Cesium.Primitive | null
  mat: Cesium.Material | null
  color: Cesium.Color | null   // uniform, za běhu se mutují jen složky rgb
  cLon: number; cLat: number
  up: Cesium.Cartesian3
  maxInside: number            // nejhlubší bod uvnitř (metry) — odtud ráz vyráží
  outEnd: number               // kam ráz doběhne ven (metry, kladné číslo)
  t0: number | null
}

/** sloučí prstence do multipolygonu; při selhání knihovny nechá původní (radši nespojené než nic) */
function mergeRings(rings: [number, number][][]): [number, number][][][] {
  const polys = rings.filter(r => r.length >= 3).map(r => [r] as [number, number][][])
  if (polys.length < 2) return polys
  try { return polygonClipping.union(polys[0], ...polys.slice(1)) as [number, number][][][] }
  catch (e) { console.error('Union parcel selhal, kreslim je zvlast:', e); return polys }
}

type Sdf = {
  canvas: HTMLCanvasElement
  range: number                            // co znamená krajní hodnota textury (metry)
  maxInside: number
  west: number; south: number; east: number; north: number   // pokrytý obdélník ve stupních
}

/**
 * Spočítá znaménkovanou vzdálenost od obrysu do textury. Kladně uvnitř, záporně venku, v METRECH —
 * díky tomu jde šířka záře zadat v metrech a nezávisí na velikosti parcely.
 *
 * Uvnitř/venku se rozhoduje sudo-lichým počtem průsečíků přes VŠECHNY prstence najednou, takže
 * díry i víc oddělených kusů vyjdou samy.
 */
function buildSdf(polys: [number, number][][][], cLon: number, cLat: number, margin: number): Sdf | null {
  // lokální metrická soustava kolem středu; na velikosti parcely je převod konstantní
  const mx = 111320 * Math.cos(Cesium.Math.toRadians(cLat)), my = 110540
  const rings: number[][] = []
  for (const poly of polys) for (const ring of poly) {
    if (ring.length < 3) continue
    const flat: number[] = []
    for (const [lo, la] of ring) { flat.push((lo - cLon) * mx, (la - cLat) * my) }
    rings.push(flat)
  }
  if (!rings.length) return null

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]
    if (r[i] > x1) x1 = r[i]
    if (r[i + 1] < y0) y0 = r[i + 1]
    if (r[i + 1] > y1) y1 = r[i + 1]
  }
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin

  const canvas = document.createElement('canvas')
  canvas.width = SDF_RES; canvas.height = SDF_RES
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(SDF_RES, SDF_RES)
  const range = Math.max(margin, 1)
  let maxInside = 0

  for (let row = 0; row < SDF_RES; row++) {
    // řádek 0 je horní okraj obrázku = SEVER; Cesium textury z canvasu překlápí (flipY),
    // takže se to potká s v = 0 na jihu a vzorkuje se pak přímo přes st
    const py = y1 - (y1 - y0) * ((row + 0.5) / SDF_RES)
    for (let col = 0; col < SDF_RES; col++) {
      const px = x0 + (x1 - x0) * ((col + 0.5) / SDF_RES)
      let best = Infinity, inside = false
      for (const r of rings) {
        const n = r.length / 2
        for (let i = 0; i < n; i++) {
          const ax = r[i * 2], ay = r[i * 2 + 1]
          const j = (i + 1) % n
          const bx = r[j * 2], by = r[j * 2 + 1]
          // vzdálenost bodu od úsečky
          const ex = bx - ax, ey = by - ay
          const len2 = ex * ex + ey * ey
          let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const dx = px - (ax + ex * t), dy = py - (ay + ey * t)
          const d2 = dx * dx + dy * dy
          if (d2 < best) best = d2
          // sudo-liché protínání vodorovným paprskem
          if ((ay > py) !== (by > py) && px < ax + ((py - ay) / (by - ay)) * (bx - ax)) inside = !inside
        }
      }
      const dist = (inside ? 1 : -1) * Math.sqrt(best)
      if (dist > maxInside) maxInside = dist
      const v = Math.round(Cesium.Math.clamp(0.5 + dist / (2 * range), 0, 1) * 255)
      const o = (row * SDF_RES + col) * 4
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return {
    canvas, range, maxInside,
    west: cLon + x0 / mx, east: cLon + x1 / mx,
    south: cLat + y0 / my, north: cLat + y1 / my,
  }
}

/** obdélník pokrytý distanční mapou; st jde 0..1 přes něj, takže se textura vzorkuje přímo */
function quadGeometry(s: Sdf): Cesium.Geometry {
  const corners: [number, number, number, number][] = [
    [s.west, s.south, 0, 0], [s.east, s.south, 1, 0], [s.east, s.north, 1, 1], [s.west, s.north, 0, 1],
  ]
  const positions = new Float64Array(12)
  const normals = new Float32Array(12)
  const st = new Float32Array(8)
  corners.forEach(([lo, la, u, v], i) => {
    const p = Cesium.Cartesian3.fromDegrees(lo, la, 0)
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z
    const nrm = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(p, new Cesium.Cartesian3()) ?? Cesium.Cartesian3.UNIT_Z
    normals[i * 3] = nrm.x; normals[i * 3 + 1] = nrm.y; normals[i * 3 + 2] = nrm.z
    st[i * 2] = u; st[i * 2 + 1] = v
  })
  const attributes = new Cesium.GeometryAttributes()
  attributes.position = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions })
  attributes.normal = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals })
  attributes.st = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st })
  return new Cesium.Geometry({
    attributes,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions as unknown as number[]),
  })
}

export class PulseLayer {
  private viewer: Cesium.Viewer
  private live = new Map<string, Live>()
  private tick = () => this.frame()

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
    viewer.scene.postRender.addEventListener(this.tick)
  }

  sync(sets: PulseSet[]) {
    const seen = new Set<string>()
    for (const s of sets) {
      seen.add(s.id)
      const cur = this.live.get(s.id)
      if (!cur) { this.build(s); continue }
      // Geometrie i distanční mapa se přestavují jen při změně tvaru. Barva se přebarvuje ZA BĚHU —
      // barevný vstup posílá změnu při každém škubnutí myší a počítat u toho znovu SDF by trhalo.
      if (cur.set.rings !== s.rings) { this.drop(s.id); this.build(s); continue }
      if (cur.set.color !== s.color) this.recolor(cur, s.color)
      cur.set = s   // count i views se propíšou rovnou
    }
    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.drop(id)
  }

  trigger(activeIds: ReadonlySet<string>) {
    for (const [id, l] of this.live) {
      if (!activeIds.has(id)) { this.stop(l); continue }
      // Výšku vzorkuj až teď: při vzniku sady nemusel být terén načtený a zvýraznění by se zarylo pod něj.
      const h = this.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(l.cLon, l.cLat)) ?? 0
      if (l.prim) {
        l.prim.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(l.up, h, new Cesium.Cartesian3()))
        l.prim.show = true
      }
      l.t0 = performance.now()
    }
  }

  destroy() {
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.postRender.removeEventListener(this.tick)
      for (const id of [...this.live.keys()]) this.drop(id)
    }
    this.live.clear()
  }

  private recolor(l: Live, hex: string) {
    const c = Cesium.Color.fromCssColorString(hex) ?? Cesium.Color.ORANGE
    if (l.color) { l.color.red = c.red; l.color.green = c.green; l.color.blue = c.blue }
  }

  private build(s: PulseSet) {
    const merged = mergeRings(s.rings)
    const outers = merged.map(p => p[0]).filter(r => r && r.length >= 3)
    if (!outers.length) return

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const r of outers) for (const [lo, la] of r) {
      if (lo < x0) x0 = lo
      if (lo > x1) x1 = lo
      if (la < y0) y0 = la
      if (la > y1) y1 = la
    }
    const cLon = (x0 + x1) / 2, cLat = (y0 + y1) / 2

    // Šířky v metrech, odvozené z velikosti skupiny — u malé parcely by pevných 20 m všechno
    // přesvítilo, u velkého bloku by naopak zmizely.
    const halfDiag = 0.5 * Math.hypot((x1 - x0) * 111320 * Math.cos(Cesium.Math.toRadians(cLat)), (y1 - y0) * 110540)
    const fadeIn = Cesium.Math.clamp(halfDiag * 0.10, 1, 20)
    const fadeOut = Cesium.Math.clamp(halfDiag * 0.14, 2, 30)
    const waveW = Cesium.Math.clamp(halfDiag * 0.10, 1.5, 20)
    const outEnd = fadeOut * 1.4
    const margin = outEnd + waveW * 2.5

    const sdf = buildSdf(merged, cLon, cLat, margin)
    if (!sdf) return

    const base = Cesium.Color.fromCssColorString(s.color) ?? Cesium.Color.ORANGE
    const color = base.withAlpha(1)
    const mat = new Cesium.Material({
      translucent: true,
      fabric: {
        type: 'PulseSdf',
        // POZOR: canvas se do fabricu NESMÍ — Cesium si materiál pojmenovaného typu uloží do
        // globální cache a další materiál téhož typu si její fabric hluboce naklonuje; deep clone
        // volá `new object.constructor()`, což je na canvasu „Illegal constructor".
        uniforms: {
          sdfMap: Cesium.Material.DefaultImageId,
          sdfRange: sdf.range, fadeIn, fadeOut, waveW,
          rimSpan: Math.max(sdf.maxInside, 1),
          waveD: 0, bodyA: 0, waveA: 0,
          color: new Cesium.Color(1, 1, 1, 1),
        },
        source: WAVE_FS,
      },
    })
    mat.uniforms.sdfMap = sdf.canvas
    mat.uniforms.color = color   // stejná instance jako v Live → stačí mutovat složky

    this.live.set(s.id, {
      set: s, mat, color, cLon, cLat, t0: null,
      maxInside: Math.max(sdf.maxInside, 1),
      outEnd,
      up: Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(cLon, cLat), new Cesium.Cartesian3()) ?? Cesium.Cartesian3.UNIT_Z,
      prim: this.viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: quadGeometry(sdf) }),
        appearance: new Cesium.MaterialAppearance({
          material: mat,
          materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
          translucent: true,
          flat: true,           // bez osvětlení — svítí to samo
          faceForward: false,
          renderState: {
            depthTest: { enabled: false },   // vidět i skrz terén, stejně jako kresba výkresu
            depthMask: false,
            blending: Cesium.BlendingState.ALPHA_BLEND,
            cull: { enabled: false },
          },
        }),
        asynchronous: false,
        show: false,
      })) as Cesium.Primitive,
    })
  }

  private drop(id: string) {
    const l = this.live.get(id)
    if (!l) return
    if (!this.viewer.isDestroyed() && l.prim) this.viewer.scene.primitives.remove(l.prim)
    this.live.delete(id)
  }

  private stop(l: Live) {
    l.t0 = null
    if (l.mat) { l.mat.uniforms.bodyA = 0; l.mat.uniforms.waveA = 0 }
    if (l.prim) l.prim.show = false
  }

  private frame() {
    const now = performance.now()
    for (const l of this.live.values()) {
      if (l.t0 == null || !l.mat) continue
      const cycles = (now - l.t0) / 1000 / PULSE_PERIOD_S
      if (cycles >= l.set.count) { this.stop(l); continue }
      // kosinová vlna začíná i končí na nule → každý pulz plynule najede a zhasne, žádné cvaknutí
      l.mat.uniforms.bodyA = 0.6 * ((1 - Math.cos(2 * Math.PI * cycles)) / 2)
      // ráz: každý pulz jeden, z nejhlubšího bodu uvnitř ven za hranici
      const wp = cycles - Math.floor(cycles)
      const p = 1 - (1 - wp) ** 2   // vyrazí rychle, pak zpomaluje
      l.mat.uniforms.waveD = l.maxInside - (l.maxInside + l.outEnd) * p
      l.mat.uniforms.waveA = Math.min(1, wp * 6) * (1 - wp) ** 1.2 * 0.8
    }
  }
}
