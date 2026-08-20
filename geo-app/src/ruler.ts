/**
 * Ruční měření vzdáleností: klikáním se sype lomená čára, u každého úseku svítí jeho délka.
 *
 * Měření je 3D, ne půdorysné — body se berou z povrchu (terén, model i Google dlaždice) i s výškou
 * a úsek se počítá jako přímá spojnice v prostoru. Proto se čáry kreslí s `ArcType.NONE`: Cesium
 * by jinak vedlo polyline po geodetice a na svahu by čára viditelně nesouhlasila s číslem.
 *
 * Body, čáry i kóty jsou vidět i skrz terén (`disableDepthTestDistance` a `depthFailMaterial`) —
 * měřítko přes kopec je pořád měření, ne kresba, a schovaná půlka by z něj udělala hádanku.
 *
 * Pozice i texty visí na `CallbackProperty`, takže tažení bodu se překreslí samo bez přestavby
 * entit. Entity se skládají znovu jen když se změní STRUKTURA (přibyl bod, přibylo měření) —
 * při desítkách kót za sekundu by rebuild na každý pohyb myši trhal.
 */
import * as Cesium from 'cesium'

/** bod měření: zeměpisná poloha + výška povrchu v místě kliknutí (m n.m.) */
export type RulerPoint = [number, number, number]
export type Ruler = { id: string; name: string; pts: RulerPoint[] }

export const RULER_COLOR = '#fbbf24'

/** „12,34 m" pod kilometr, jinak „1,234 km" — pod metrem má smysl i centimetr */
export function fmtLen(m: number): string {
  if (m >= 1000) return `${(m / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 3 })} km`
  return `${m.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`
}

const cart = (p: RulerPoint) => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2])

/** délka lomené čáry a její převýšení (rozdíl výšek prvního a posledního bodu) */
export function rulerTotals(pts: RulerPoint[]): { len: number; rise: number } {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Cesium.Cartesian3.distance(cart(pts[i - 1]), cart(pts[i]))
  return { len, rise: pts.length > 1 ? pts[pts.length - 1][2] - pts[0][2] : 0 }
}

type Hit = { id: string; idx: number }

export class RulerLayer {
  private viewer: Cesium.Viewer
  private data = new Map<string, Ruler>()
  private ents = new Map<string, Cesium.Entity[]>()
  private hits = new Map<Cesium.Entity, Hit>()
  private sig = new Map<string, number>()   // rulerId → počet bodů, podle kterého se pozná rebuild

  constructor(viewer: Cesium.Viewer) { this.viewer = viewer }

  /** Body daného měření — vždy živé, tažení je mutuje rovnou tady. */
  private pts(id: string): RulerPoint[] { return this.data.get(id)?.pts ?? [] }

  sync(rulers: Ruler[], selectedId: string | null) {
    const live = new Set(rulers.map(r => r.id))
    for (const id of [...this.ents.keys()]) if (!live.has(id)) this.drop(id)
    for (const r of rulers) {
      const prev = this.sig.get(r.id)
      this.data.set(r.id, r)
      if (prev !== r.pts.length) { this.drop(r.id, true); this.build(r) }
    }
    // zvýraznění vybraného měření řeší šířka čáry — přestavovat kvůli tomu entity by bylo zbytečné
    for (const [id, list] of this.ents) {
      const w = id === selectedId ? 4 : 2
      for (const e of list) if (e.polyline) e.polyline.width = new Cesium.ConstantProperty(w)
    }
  }

  /** posun bodu při tažení — zapisuje do živých dat, překreslení obstarají CallbackProperty */
  liveMove(id: string, idx: number, p: RulerPoint) {
    const pts = this.pts(id)
    if (idx >= 0 && idx < pts.length) pts[idx] = p
  }

  /** výsledek `scene.pick` → které měření a který bod, nebo null */
  hit(picked: unknown): Hit | null {
    const ent = (picked as { id?: unknown } | undefined)?.id
    return ent instanceof Cesium.Entity ? this.hits.get(ent) ?? null : null
  }

  private drop(id: string, keepData = false) {
    const v = this.viewer
    for (const e of this.ents.get(id) ?? []) { this.hits.delete(e); if (!v.isDestroyed()) v.entities.remove(e) }
    this.ents.delete(id)
    this.sig.delete(id)
    if (!keepData) this.data.delete(id)
  }

  private build(r: Ruler) {
    const v = this.viewer
    if (v.isDestroyed()) return
    const color = Cesium.Color.fromCssColorString(RULER_COLOR)
    const list: Cesium.Entity[] = []
    const at = (i: number): Cesium.Cartesian3 => cart(this.pts(r.id)[i] ?? [0, 0, 0])

    // lomená čára — jeden entity přes všechny body; ArcType.NONE = rovná spojnice v prostoru
    if (r.pts.length > 1) {
      list.push(v.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => this.pts(r.id).map(cart), false),
          width: 2,
          material: color,
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.75) }),
          arcType: Cesium.ArcType.NONE,
        },
      }))
    }

    // kóta na každém úseku
    for (let i = 1; i < r.pts.length; i++) {
      const a = i - 1, b = i
      list.push(v.entities.add({
        position: new Cesium.CallbackProperty(() =>
          Cesium.Cartesian3.midpoint(at(a), at(b), new Cesium.Cartesian3()), false) as unknown as Cesium.PositionProperty,
        label: {
          text: new Cesium.CallbackProperty(() => fmtLen(Cesium.Cartesian3.distance(at(a), at(b))), false) as unknown as Cesium.Property,
          font: 'bold 14px monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.75),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
    }

    // body — poslední dostane součet, ať je celková délka u konce čáry a ne někde v prostoru
    for (let i = 0; i < r.pts.length; i++) {
      const idx = i
      const isLast = i === r.pts.length - 1
      const ent = v.entities.add({
        position: new Cesium.CallbackProperty(() => at(idx), false) as unknown as Cesium.PositionProperty,
        point: {
          pixelSize: 10,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: isLast && r.pts.length > 1 ? {
          text: new Cesium.CallbackProperty(() => {
            const t = rulerTotals(this.pts(r.id))
            const rise = Math.abs(t.rise) >= 0.5 ? ` (${t.rise > 0 ? '+' : '−'}${Math.abs(t.rise).toFixed(1)} m)` : ''
            return `Σ ${fmtLen(t.len)}${rise}`
          }, false) as unknown as Cesium.Property,
          font: 'bold 15px monospace',
          fillColor: Cesium.Color.fromCssColorString(RULER_COLOR),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(7, 5),
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } : undefined,
      })
      this.hits.set(ent, { id: r.id, idx })
      list.push(ent)
    }

    this.ents.set(r.id, list)
    this.sig.set(r.id, r.pts.length)
  }

  destroy() {
    for (const id of [...this.ents.keys()]) this.drop(id)
    this.data.clear()
  }
}
