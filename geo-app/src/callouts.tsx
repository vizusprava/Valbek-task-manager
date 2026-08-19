/**
 * Prezentační popisky: tečka v místě zájmu, odpichová čára a bublina s textem.
 *
 * Kotva žije ve SVĚTĚ (ECEF), ale čára i bublina se kreslí v HTML/SVG nad canvasem. Důvody:
 *  - „vyjede/zajede" je animace — v CSS/JS triviální, přes Cesium.Label prakticky nemožná
 *    (Label je viewport-aligned bitmapa bez rotace a bez rozumného stylování, viz dxfText.ts),
 *  - text je pak skutečné HTML: zalamuje se, dá se stylovat, zůstane ostrý,
 *  - overlay je NAD canvasem, takže ho kruhové rozostření scény nerozmaže.
 *
 * Pozice se přepočítává každý snímek v `scene.preRender` a zapisuje se PŘÍMO do stylů elementů,
 * ne přes React state — stav by při 60 fps překresloval celý strom.
 *
 * PROČ `preRender` a ne `postRender`: „kamera z ruky" (MapView) naklání kameru v `preRender` a hned
 * po snímku ji v `postRender` vrací přesně zpátky. V `postRender` je tedy kamera už NAROVNANÁ,
 * zatímco snímek se vykreslil tou rozechvělou — popisky by se promítaly do jiného pohledu, než je
 * vidět, a klouzaly by po scéně o celou výchylku chvění (~1° × intenzita, a pomalu: nejnižší
 * sinusovka má 0,049 Hz). V `preRender` běžíme až ZA nasazením chvění, protože MapView si svůj
 * posluchač registruje dřív (jeho efekt jede při prvním průchodu, náš až po `viewerReady`), takže
 * promítáme přesně tou kamerou, kterou se snímek kreslí, a kotva zůstane přilepená na svém místě.
 *
 * POZOR na volbu projekce: `worldToWindowCoordinates` vrací CSS pixely, což je to, co potřebuje
 * HTML overlay. `worldToDrawingBufferCoordinates` vrací pixely bufferu a na HiDPI displejích nebo
 * při zoomu prohlížeče ≠ 100 % se od CSS pixelů liší — bublina by ujížděla od čáry přesně tam,
 * kde si toho člověk nevšimne.
 */
import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'

export type Callout = {
  id: string
  text: string
  anchor: [number, number, number]   // ECEF
  off: [number, number]              // posun bubliny od kotvy v CSS pixelech
  views: string[]                    // id pohledů, ve kterých je vidět
  // Vzhled je NEPOVINNÝ schválně: popisky uložené dřív ho v localStorage nemají a musí se dál
  // načíst — když chybí, použijí se výchozí hodnoty níž.
  dot?: string                       // barva tečky (#rrggbb)
  frame?: string                     // barva rámečku bubliny i odpichové čáry
  size?: number                      // velikost textu v px
}

export const DOT_DEFAULT = '#38bdf8'
export const FRAME_DEFAULT = '#e5e7eb'
export const SIZE_DEFAULT = 12

/** jak dlouho popisek vyjíždí a zase zajíždí (sekundy) — tady se ladí rychlost animace */
const REVEAL_S = 1.1

/** #rgb i #rrggbb → rgba(), aby šel z jedné barvy udělat i průsvitný obrys a záře */
function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(full, 16)
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

type Nodes = { root: HTMLDivElement; dot: HTMLDivElement; bubble: HTMLDivElement; line: SVGLineElement }

type Props = {
  viewer: Cesium.Viewer | null
  callouts: Callout[]
  /** id popisků, které mají být právě vysunuté */
  visibleIds: ReadonlySet<string>
  /** hotový posun bubliny po dotažení myší */
  onMove?: (id: string, off: [number, number]) => void
  onPick?: (id: string) => void
  selectedId?: string | null
}

const scratchPos = new Cesium.Cartesian3()
const scratchWin = new Cesium.Cartesian2()

export function CalloutLayer({ viewer, callouts, visibleIds, onMove, onPick, selectedId }: Props) {
  const nodes = useRef(new Map<string, Partial<Nodes>>())
  const anim = useRef(new Map<string, number>())
  const dragTmp = useRef(new Map<string, [number, number]>())
  // Čtení uvnitř smyčky jde přes refy: efekt se navěsí jednou na viewer a nesmí se přepínat
  // s každou změnou seznamu, jinak by se listener odpojoval a připojoval při každém překreslení.
  const listRef = useRef(callouts); listRef.current = callouts
  const visRef = useRef(visibleIds); visRef.current = visibleIds

  useEffect(() => {
    if (!viewer) return
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      for (const c of listRef.current) {
        const n = nodes.current.get(c.id)
        if (!n?.root || !n.dot || !n.bubble || !n.line) continue
        const target = visRef.current.has(c.id) ? 1 : 0
        // Postup jde lineárně a na vzhled se pak pouští smoothstep. Doba náběhu je díky tomu
        // PŘESNĚ REVEAL_S a náběh i doběh mají měkké konce. (Dřív to byl exponenciální dojezd:
        // startoval prudce a délka se dala řídit jen nepřímo přes konstantu útlumu.)
        let p = anim.current.get(c.id) ?? 0
        if (p !== target) {
          p = Cesium.Math.clamp(p + (target > p ? 1 : -1) * (dt / REVEAL_S), 0, 1)
          anim.current.set(c.id, p)
        }
        const a = p * p * (3 - 2 * p)

        const hide = () => { n.root!.style.display = 'none'; n.line!.style.display = 'none' }
        if (p <= 0) { hide(); continue }
        Cesium.Cartesian3.unpack(c.anchor, 0, scratchPos)
        const win = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, scratchPos, scratchWin)
        if (!win) { hide(); continue }   // kotva je za kamerou

        n.root.style.display = ''
        n.line.style.display = ''
        const off = dragTmp.current.get(c.id) ?? c.off
        const bx = win.x + off[0] * a, by = win.y + off[1] * a
        n.dot.style.transform = `translate(${win.x}px,${win.y}px) translate(-50%,-50%) scale(${a})`
        n.bubble.style.transform = `translate(${bx}px,${by}px) translate(-50%,-50%) scale(${0.85 + 0.15 * a})`
        n.bubble.style.opacity = String(a)
        n.line.setAttribute('x1', String(win.x)); n.line.setAttribute('y1', String(win.y))
        n.line.setAttribute('x2', String(bx)); n.line.setAttribute('y2', String(by))
        n.line.style.opacity = String(a * 0.9)
      }
    }
    // Registrace MUSÍ zůstat na `preRender` (a MapView si chvění kamery věší dřív) — viz hlavička.
    viewer.scene.preRender.addEventListener(tick)
    return () => { if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(tick) }
  }, [viewer])

  // POZOR: ref callback se při každém překreslení volá nejdřív s null (identita funkce se mění).
  // Mazat na null celý záznam by proto při běžném re-renderu zahodilo i sourozenecké reference
  // a popisek by přestal být poziciovaný. Na null se tedy nesahá; úklid řeší efekt níž.
  const put = (id: string, k: keyof Nodes) => (el: HTMLDivElement | SVGLineElement | null) => {
    if (!el) return
    const cur = nodes.current.get(id) ?? {}
    ;(cur as Record<string, unknown>)[k] = el
    nodes.current.set(id, cur)
  }

  // zahoď reference a stav animace smazaných popisků
  useEffect(() => {
    const live = new Set(callouts.map(c => c.id))
    for (const k of [...nodes.current.keys()]) if (!live.has(k)) { nodes.current.delete(k); anim.current.delete(k) }
  }, [callouts])

  // tažení bubliny: posun se drží v refu a do stavu se propíše až po puštění, ať se netočí re-render
  const startDrag = (c: Callout) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    onPick?.(c.id)
    const base = dragTmp.current.get(c.id) ?? c.off
    const x0 = e.clientX, y0 = e.clientY
    const move = (ev: MouseEvent) => dragTmp.current.set(c.id, [base[0] + ev.clientX - x0, base[1] + ev.clientY - y0])
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      const fin = dragTmp.current.get(c.id)
      dragTmp.current.delete(c.id)
      if (fin) onMove?.(c.id, fin)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <svg className="absolute inset-0 h-full w-full pointer-events-none">
        {callouts.map(c => (
          <line key={c.id} ref={put(c.id, 'line')} stroke={c.frame ?? FRAME_DEFAULT} strokeWidth={1.5} style={{ display: 'none' }} />
        ))}
      </svg>
      {callouts.map(c => (
        <div key={c.id} ref={put(c.id, 'root')} className="absolute inset-0 pointer-events-none" style={{ display: 'none' }}>
          <div
            ref={put(c.id, 'dot')}
            className="absolute left-0 top-0 h-2.5 w-2.5 rounded-full"
            style={{
              background: c.dot ?? DOT_DEFAULT,
              boxShadow: `0 0 0 2px ${rgba(c.dot ?? DOT_DEFAULT, 0.45)}, 0 0 10px 2px ${rgba(c.dot ?? DOT_DEFAULT, 0.7)}`,
            }}
          />
          <div
            ref={put(c.id, 'bubble')}
            onMouseDown={startDrag(c)}
            title="Táhnutím posuneš bublinu"
            className="absolute left-0 top-0 max-w-[15rem] cursor-move whitespace-pre-wrap rounded-lg px-2.5 py-1.5 leading-snug text-gray-100 backdrop-blur-sm pointer-events-auto"
            style={{
              fontSize: `${c.size ?? SIZE_DEFAULT}px`,
              background: 'rgba(17,24,39,0.82)',
              boxShadow: `0 0 0 ${selectedId === c.id ? 2 : 1}px ${rgba(c.frame ?? FRAME_DEFAULT, selectedId === c.id ? 1 : 0.55)}, 0 4px 14px rgba(0,0,0,0.45)`,
            }}
          >{c.text}</div>
        </div>
      ))}
    </div>
  )
}
