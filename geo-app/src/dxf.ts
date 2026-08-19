/**
 * DXF (a přes WASM převodník i DWG) → mezireprezentace kresby: polylinie + body + texty,
 * každý s barvou a hladinou. Oblouky/kružnice/elipsy/spliny i „bulge" oblouky se rozteselují;
 * bloky (INSERT) se rekurzivně rozbalí i s transformací.
 *
 * Vlastní TOLERANTNÍ parser group codů — na nečekané hodnoty (např. flag „12") NEPADÁ, jen je
 * ignoruje. (Hotové knihovny na takových souborech vyhazují výjimku a zabijí celý import.)
 *
 * Souřadnice zůstávají v jednotkách výkresu — georeferenci (S-JTSK vs lokální) řeší až renderer.
 * Modul je bez Cesia/DOMu, aby šel testovat i mimo prohlížeč.
 */

export type DrawPrim =
  | { kind: 'poly'; pts: [number, number][]; layer: string; color: number }
  | { kind: 'point'; pt: [number, number]; layer: string; color: number }
  | { kind: 'text'; pt: [number, number]; text: string; height: number; rot: number; hAlign: HAlign; vAlign: VAlign; layer: string; color: number }

/** ukotvení textu k bodu `pt` — 0 vlevo/1 střed/2 vpravo, 0 účaří/1 střed/2 nahoře */
export type HAlign = 0 | 1 | 2
export type VAlign = 0 | 1 | 2

export type DrawParse = { prims: DrawPrim[]; minX: number; minY: number; maxX: number; maxY: number }

// AutoCAD Color Index (běžné 1–9); vyšší indexy padnou na barvu hladiny nebo bílou.
const ACI: Record<number, number> = { 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080, 9: 0xc0c0c0 }

type Pt = [number, number]
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number }
const ID: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const apply = (t: Affine, x: number, y: number): Pt => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f]
function compose(o: Affine, i: Affine): Affine {
  return {
    a: o.a * i.a + o.c * i.b, b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d, d: o.b * i.c + o.d * i.d,
    e: o.a * i.e + o.c * i.f + o.e, f: o.b * i.e + o.d * i.f + o.f,
  }
}

const ARC_SEG = Math.PI / 24

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0
  while (sweep <= 0) sweep += 2 * Math.PI
  const n = Math.max(2, Math.ceil(sweep / ARC_SEG)), out: Pt[] = []
  for (let i = 0; i <= n; i++) { const t = a0 + sweep * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}
function circlePts(cx: number, cy: number, r: number): Pt[] {
  const n = 64, out: Pt[] = []
  for (let i = 0; i <= n; i++) { const t = 2 * Math.PI * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}
function bulgePts(p0: Pt, p1: Pt, bulge: number): Pt[] {
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  if (chord < 1e-9 || Math.abs(bulge) < 1e-9) return []
  const theta = 4 * Math.atan(bulge)
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2))
  const chordAng = Math.atan2(p1[1] - p0[1], p1[0] - p0[0])
  const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
  const apo = r * Math.cos(Math.abs(theta) / 2)
  const side = bulge > 0 ? -1 : 1
  const cx = mid[0] + Math.cos(chordAng - Math.PI / 2) * apo * side
  const cy = mid[1] + Math.sin(chordAng - Math.PI / 2) * apo * side
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx)
  const n = Math.max(2, Math.ceil(Math.abs(theta) / ARC_SEG)), out: Pt[] = []
  for (let i = 1; i < n; i++) { const t = a0 + theta * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return out
}
function polyWithBulges(verts: { x: number; y: number; bulge?: number }[], closed: boolean): Pt[] {
  const pts: Pt[] = [], n = verts.length
  for (let i = 0; i < n; i++) {
    const v = verts[i]
    pts.push([v.x, v.y])
    const next = i + 1 < n ? verts[i + 1] : (closed ? verts[0] : null)
    if (next && v.bulge) pts.push(...bulgePts([v.x, v.y], [next.x, next.y], v.bulge))
  }
  if (closed && n > 1) pts.push([verts[0].x, verts[0].y])
  return pts
}
function ellipsePts(cx: number, cy: number, mx: number, my: number, ratio: number, a0: number, a1: number): Pt[] {
  const major = Math.hypot(mx, my), minor = major * ratio, rot = Math.atan2(my, mx)
  let sweep = a1 - a0
  if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI
  while (sweep <= 0) sweep += 2 * Math.PI
  const n = Math.max(8, Math.ceil(sweep / ARC_SEG)), out: Pt[] = [], cr = Math.cos(rot), sr = Math.sin(rot)
  for (let i = 0; i <= n; i++) {
    const t = a0 + sweep * (i / n), ex = major * Math.cos(t), ey = minor * Math.sin(t)
    out.push([cx + ex * cr - ey * sr, cy + ex * sr + ey * cr])
  }
  return out
}

// ── tolerantní čtení group codů ──────────────────────────────────────────────────────
type Prop = { code: number; value: string }
type RawEnt = { type: string; props: Prop[]; vertices: RawEnt[] } // vertices = VERTEX u starého POLYLINE

function tokenize(text: string): Prop[] {
  const lines = text.split(/\r\n|\r|\n/)
  const out: Prop[] = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const codeStr = lines[i].trim()
    // Platný group code je celé číslo. Když řádek ve slotu pro kód celé číslo NENÍ, jde o
    // pokračování předchozí hodnoty: některé řetězce (MTEXT/TEXT/XDATA) obsahují vložený znak
    // nového řádku, který split rozseká na víc řádků a rozhodí párování kód/hodnota. Slepíme zpět.
    if (!/^-?\d+$/.test(codeStr)) {
      if (out.length) out[out.length - 1].value += '\n' + lines[i]
      i++
      continue
    }
    if (i + 1 >= n) break
    out.push({ code: parseInt(codeStr, 10), value: lines[i + 1] })
    i += 2
  }
  return out
}
const num = (props: Prop[], code: number, dflt = 0): number => {
  for (const p of props) if (p.code === code) { const n = parseFloat(p.value); return Number.isFinite(n) ? n : dflt }
  return dflt
}
const str = (props: Prop[], code: number): string | undefined => { for (const p of props) if (p.code === code) return p.value.trim(); return undefined }
const flag = (props: Prop[], code: number): number => { const v = num(props, code, 0); return Number.isFinite(v) ? v : 0 }

type Anchor = { x: number; y: number; hAlign: HAlign; vAlign: VAlign; rot: number }

/**
 * TEXT/ATTRIB: kotva a zarovnání.
 *
 * PAST: bod 10/20 je „první bod zarovnání" a je použitelný JEN u textu zarovnaného vlevo na účaří.
 * Jakmile je 72 (vodorovně: 1 střed, 2 vpravo, 4 middle) nebo 73 (svisle) nenulové, skutečná
 * pozice je v 11/21 a v 10/20 bývá nesmysl (často 0,0) — proto texty létaly mimo výkres a rozbíjely
 * i bounding box celé kresby. U 72=3 (aligned) a 72=5 (fit) je text roztažený MEZI 10/20 a 11/21,
 * takže kotvou zůstává 10/20.
 */
function textAnchor(props: Prop[]): Anchor {
  const h = flag(props, 72), v = flag(props, 73)
  const stretched = h === 3 || h === 5
  const useSecond = !stretched && (h !== 0 || v !== 0)
  return {
    x: useSecond ? num(props, 11) : num(props, 10),
    y: useSecond ? num(props, 21) : num(props, 20),
    hAlign: stretched ? 0 : h === 1 || h === 4 ? 1 : h === 2 ? 2 : 0,
    vAlign: stretched ? 0 : h === 4 || v === 2 ? 1 : v === 3 ? 2 : 0, // 72=4 (middle) = svisle na střed
    rot: num(props, 50) * Math.PI / 180,
  }
}

/**
 * MTEXT: kotva je vždy 10/20, zarovnání dává 71 (1=vlevo nahoře … 9=vpravo dole).
 *
 * PAST: 11/21/31 u MTEXTu NENÍ druhý bod zarovnání jako u TEXTu, ale směrový vektor osy X — a má
 * PŘEDNOST před úhlem v 50. Kreslení podle 50 proto u otočených MTEXTů dávalo špatný sklon.
 * (Specifikace DXF navíc u MTEXT/50 chybně uvádí radiány; AutoCAD píše stupně.)
 */
function mtextAnchor(props: Prop[]): Anchor {
  const ap = flag(props, 71) || 1
  const dx = num(props, 11), dy = num(props, 21)
  return {
    x: num(props, 10),
    y: num(props, 20),
    hAlign: ((ap - 1) % 3) as HAlign,
    vAlign: ap <= 3 ? 2 : ap <= 6 ? 1 : 0,
    rot: dx || dy ? Math.atan2(dy, dx) : num(props, 50) * Math.PI / 180,
  }
}

/** rozparsuje DXF na hladiny + bloky + entity model space; nikdy nevyhazuje na nečekané hodnoty */
function parseStructure(toks: Prop[]) {
  const layers: Record<string, number> = {}
  const blocks: Record<string, { entities: RawEnt[] }> = {}
  const entities: RawEnt[] = []

  const readEnt = (i: number): { ent: RawEnt; next: number } => {
    const type = toks[i].value.trim()
    const props: Prop[] = []
    let j = i + 1
    for (; j < toks.length && toks[j].code !== 0; j++) props.push(toks[j])
    return { ent: { type, props, vertices: [] }, next: j }
  }

  let section = ''
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t.code !== 0) { i++; continue }
    const marker = t.value.trim()
    if (marker === 'SECTION') { section = i + 1 < toks.length && toks[i + 1].code === 2 ? toks[i + 1].value.trim() : ''; i += 2; continue }
    if (marker === 'ENDSEC') { section = ''; i++; continue }
    if (marker === 'EOF') break

    if (section === 'TABLES') {
      const { ent, next } = readEnt(i)
      if (ent.type === 'LAYER') { const nm = str(ent.props, 2); if (nm) layers[nm] = layerColor(ent.props) }
      i = next; continue
    }
    if (section === 'BLOCKS') {
      if (marker === 'BLOCK') {
        const { ent, next } = readEnt(i)
        const name = str(ent.props, 2) ?? ''
        const blk = { entities: [] as RawEnt[] }
        let k = next
        while (k < toks.length && !(toks[k].code === 0 && toks[k].value.trim() === 'ENDBLK')) {
          if (toks[k].code === 0) { k = readEntityInto(toks, k, blk.entities, readEnt); continue }
          k++
        }
        if (name) blocks[name] = blk
        // přeskoč ENDBLK
        i = k < toks.length ? k + 1 : k
        continue
      }
      const { next } = readEnt(i); i = next; continue
    }
    if (section === 'ENTITIES') { i = readEntityInto(toks, i, entities, readEnt); continue }

    const { next } = readEnt(i); i = next // jiná sekce → přeskoč
  }
  return { layers, blocks, entities }
}

// přečte entitu do pole; starý POLYLINE spolkne následující VERTEX až po SEQEND
function readEntityInto(toks: Prop[], i: number, into: RawEnt[], readEnt: (i: number) => { ent: RawEnt; next: number }): number {
  const { ent, next } = readEnt(i)
  if (ent.type === 'POLYLINE') {
    let k = next
    while (k < toks.length && toks[k].code === 0) {
      const m = toks[k].value.trim()
      if (m === 'VERTEX') { const r = readEnt(k); ent.vertices.push(r.ent); k = r.next; continue }
      if (m === 'SEQEND') { const r = readEnt(k); k = r.next; break }
      break
    }
    into.push(ent)
    return k
  }
  if (ent.type === 'INSERT') {
    // atributy bloku (ATTRIB) mohou následovat za INSERT až po SEQEND (jako VERTEX u POLYLINE)
    let k = next
    while (k < toks.length && toks[k].code === 0) {
      const m = toks[k].value.trim()
      if (m === 'ATTRIB') { const r = readEnt(k); ent.vertices.push(r.ent); k = r.next; continue }
      if (m === 'SEQEND') { const r = readEnt(k); k = r.next; break }
      break
    }
    into.push(ent)
    return k
  }
  into.push(ent)
  return next
}

function layerColor(props: Prop[]): number {
  const tc = str(props, 420)
  if (tc !== undefined) { const n = parseInt(tc, 10); if (Number.isFinite(n)) return n & 0xffffff }
  const ci = Math.abs(flag(props, 62))
  return ACI[ci] ?? 0xffffff
}

/**
 * Vyčistí MTEXT/TEXT řetězec z DXF: dekóduje `\U+XXXX` unicode, stacking `\S…^…;`, odstraní
 * formátovací kódy (`\A;`, `\C;`, `\f…;`, `\H;`, `\P`…), TEXT `%%` kódy a řídící `^X` znaky.
 * Bez tohohle vyjdou popisky zprzněné (např. „…U+2030203020…") nebo prázdné.
 */
export function cleanDxfText(raw: string): string {
  let s = raw
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))) // unicode
  s = s.replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, (_m, a: string, b: string) => b.trim() ? `${a.trim()}/${b.trim()}` : a.trim()) // stacking „nad/pod"
  s = s.replace(/\\P/g, ' ').replace(/\\~/g, ' ')                 // odstavec / nezlom. mezera
  s = s.replace(/\\[A-Za-z][^;\\]*;/g, '')                        // formátovací kódy s ; (font/barva/výška…)
  s = s.replace(/\\[LlOoKk]/g, '')                                // pod/nad/přeškrt on/off
  s = s.replace(/[{}]/g, '')                                      // seskupovací závorky
  s = s.replace(/%%[dD]/g, '°').replace(/%%[cC]/g, '⌀').replace(/%%[pP]/g, '±').replace(/%%%/g, '%').replace(/%%[uUoO]/g, '') // TEXT %% kódy
  s = s.replace(/\^[IJM]/g, ' ')                                  // řídící ^I/^J/^M
  return s.replace(/\s+/g, ' ').trim()
}

export function dxfToPrims(text: string): DrawParse {
  const toks = tokenize(text)
  if (!toks.length) throw new Error('DXF je prázdný nebo není textový (binární DXF nepodporujeme)')
  const { layers, blocks, entities } = parseStructure(toks)

  const prims: DrawPrim[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const track = (x: number, y: number) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }

  const colorOf = (e: RawEnt, inherit: number): number => {
    const tc = str(e.props, 420)
    if (tc !== undefined) { const n = parseInt(tc, 10); if (Number.isFinite(n)) return n & 0xffffff }
    const ci = flag(e.props, 62)
    if (ci > 0 && ci !== 256) return ACI[ci] ?? 0xffffff
    const ly = str(e.props, 8)
    if (ly && layers[ly] != null) return layers[ly]
    return inherit
  }
  const pushPoly = (raw: Pt[], tf: Affine, layer: string, color: number) => {
    if (raw.length < 2) return
    const pts = raw.map(([x, y]) => { const p = apply(tf, x, y); track(p[0], p[1]); return p })
    prims.push({ kind: 'poly', pts, layer, color })
  }
  // Text musí sledovat transformaci bloku: INSERT může být otočený i vnořený, takže sklon i výšku
  // bereme z výsledné matice, ne jen z group codů entity.
  const pushText = (props: Prop[], a: Anchor, txt: string, tf: Affine, layer: string, color: number) => {
    const p = apply(tf, a.x, a.y); track(p[0], p[1])
    const scaleY = Math.hypot(tf.c, tf.d) || 1
    prims.push({
      kind: 'text', pt: p, text: txt, layer, color,
      height: num(props, 40, 2) * scaleY,
      rot: a.rot + Math.atan2(tf.b, tf.a),
      hAlign: a.hAlign, vAlign: a.vAlign,
    })
  }

  const emit = (e: RawEnt, tf: Affine, inherit: number, depth: number) => {
    const layer = str(e.props, 8) ?? '0'
    const color = colorOf(e, inherit)
    switch (e.type) {
      case 'LINE':
        pushPoly([[num(e.props, 10), num(e.props, 20)], [num(e.props, 11), num(e.props, 21)]], tf, layer, color)
        break
      case 'LWPOLYLINE': {
        const vs: { x: number; y: number; bulge?: number }[] = []
        for (const p of e.props) {
          if (p.code === 10) vs.push({ x: parseFloat(p.value) || 0, y: 0 })
          else if (p.code === 20 && vs.length) vs[vs.length - 1].y = parseFloat(p.value) || 0
          else if (p.code === 42 && vs.length) vs[vs.length - 1].bulge = parseFloat(p.value) || 0
        }
        if (vs.length) pushPoly(polyWithBulges(vs, (flag(e.props, 70) & 1) === 1), tf, layer, color)
        break
      }
      case 'POLYLINE': {
        const vs = e.vertices.map(vx => ({ x: num(vx.props, 10), y: num(vx.props, 20), bulge: num(vx.props, 42) || undefined }))
        if (vs.length) pushPoly(polyWithBulges(vs, (flag(e.props, 70) & 1) === 1), tf, layer, color)
        break
      }
      case 'CIRCLE':
        pushPoly(circlePts(num(e.props, 10), num(e.props, 20), num(e.props, 40)), tf, layer, color)
        break
      case 'ARC':
        pushPoly(arcPts(num(e.props, 10), num(e.props, 20), num(e.props, 40), num(e.props, 50) * Math.PI / 180, num(e.props, 51) * Math.PI / 180), tf, layer, color)
        break
      case 'ELLIPSE':
        pushPoly(ellipsePts(num(e.props, 10), num(e.props, 20), num(e.props, 11), num(e.props, 21), num(e.props, 40, 1), num(e.props, 41, 0), num(e.props, 42, 2 * Math.PI)), tf, layer, color)
        break
      case 'SPLINE': {
        const fit: Pt[] = [], ctrl: Pt[] = []
        for (let k = 0; k < e.props.length; k++) {
          const p = e.props[k]
          if (p.code === 11) fit.push([parseFloat(p.value) || 0, 0])
          else if (p.code === 21 && fit.length) fit[fit.length - 1][1] = parseFloat(p.value) || 0
          else if (p.code === 10) ctrl.push([parseFloat(p.value) || 0, 0])
          else if (p.code === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = parseFloat(p.value) || 0
        }
        const src = fit.length >= 2 ? fit : ctrl
        if (src.length >= 2) pushPoly(src, tf, layer, color)
        break
      }
      case 'SOLID':
      case '3DFACE': {
        const c: Pt[] = [[num(e.props, 10), num(e.props, 20)], [num(e.props, 11), num(e.props, 21)], [num(e.props, 12), num(e.props, 22)]]
        const has4 = e.props.some(p => p.code === 13)
        if (has4) c.push([num(e.props, 13), num(e.props, 23)])
        c.push(c[0])
        pushPoly(c, tf, layer, color)
        break
      }
      case 'POINT': {
        const p = apply(tf, num(e.props, 10), num(e.props, 20)); track(p[0], p[1])
        prims.push({ kind: 'point', pt: p, layer, color })
        break
      }
      case 'TEXT':
      case 'MTEXT': {
        const raw = e.props.filter(p => p.code === 1 || p.code === 3).map(p => p.value).join('')
        const clean = cleanDxfText(raw)
        // TEXT a MTEXT vypadají podobně, ale kotvu i rotaci kódují jinak — viz textAnchor/mtextAnchor
        if (clean) pushText(e.props, e.type === 'MTEXT' ? mtextAnchor(e.props) : textAnchor(e.props), clean, tf, layer, color)
        break
      }
      case 'INSERT': {
        if (depth > 8) break
        const sx = num(e.props, 41, 1), sy = num(e.props, 42, 1), rot = num(e.props, 50) * Math.PI / 180
        const cr = Math.cos(rot), sr = Math.sin(rot)
        const local: Affine = { a: cr * sx, b: sr * sx, c: -sr * sy, d: cr * sy, e: num(e.props, 10), f: num(e.props, 20) }
        const blk = blocks[str(e.props, 2) ?? '']
        if (blk?.entities.length) { const t2 = compose(tf, local); for (const be of blk.entities) emit(be, t2, color, depth + 1) }
        // ATTRIB (hodnoty atributů) — pozice už je v prostoru INSERTu, kreslíme přes `tf`.
        // Zarovnání se čte stejně jako u TEXTu (ATTRIB má tytéž group cody).
        for (const at of e.vertices) {
          if (at.type !== 'ATTRIB') continue
          const clean = cleanDxfText(at.props.filter(pp => pp.code === 1 || pp.code === 3).map(pp => pp.value).join(''))
          if (!clean) continue
          pushText(at.props, textAnchor(at.props), clean, tf, str(at.props, 8) ?? layer, colorOf(at, color))
        }
        break
      }
    }
  }

  for (const e of entities) emit(e, ID, 0xffffff, 0)
  if (!prims.length) throw new Error('DXF neobsahuje žádnou kresbu (podporované: čáry, polylinie, kružnice, oblouky, texty, bloky)')
  return { prims, minX, minY, maxX, maxY }
}
