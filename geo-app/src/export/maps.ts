/**
 * Rastrové podklady pro export: spojená 2D mapa (ortofoto + topografie) a ortofoto textura.
 *
 * Všechno bere obálku v S-JTSK a průběh hlásí callbackem — žádný stav komponenty, takže
 * volající si sám rozhodne, kam průběh zobrazí a jak se export zruší.
 */
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { toast } from 'sonner'
import { mapBboxUrl, pickTopoTier, fetchJpegRetry, pool, type MapLayer } from '../tiles'
import { isAbortError } from '../config'
import { download } from '../exportUtils'

// Stahuje se po velkých blocích (ne po dlaždicích) → stylovaná topo mapa nemá ořezané popisky
// na švech. Výsledek je zastropovaný (paměť canvasu); u velké oblasti klesne rozlišení.
const TOPO_MAX_PX = 4096      // topo mapa je jen orientační podklad → vždy menší (a ZTM míň zlobí)
const STITCH_CHUNK_PX = 4096  // strop ČÚZK REST na jeden požadavek
const STITCH_RES_M = 0.2      // cílové rozlišení (ortofoto má nativně 20 cm/px)
const STITCH_MAX_AREA = 16384 * 16384 // pojistka na paměť canvasu (~1 GB), ať to nespadne

/**
 * Stáhne jeden blok mapy jako ImageBitmap — s ověřením a opakováním. ČÚZK ArcGIS (hlavně ZTM)
 * u větších/paralelních požadavků občas vrátí 200 s prázdným (bílým) obrázkem. Velikost je na
 * detekci nepoužitelná (chyba mívá i 3 MB, reálný list i 10 kB), spolehlivé je jen to, že prázdná
 * mapa je JEDNOLITÁ plocha → zmenšíme na 16×16 a změříme rozptyl. Reálná mapa má obrovský.
 */
export async function loadMapChunk(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const probe = document.createElement('canvas'); probe.width = 16; probe.height = 16
  const pctx = probe.getContext('2d', { willReadFrequently: true })
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal?.aborted) throw new DOMException('Zrušeno', 'AbortError')
    try {
      const res = await fetch(url, { signal })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.startsWith('image/')) throw new Error(`HTTP ${res.status} (${ct || 'bez typu'})`)
      const bmp = await createImageBitmap(await res.blob())
      if (pctx) {
        pctx.clearRect(0, 0, 16, 16)
        pctx.drawImage(bmp, 0, 0, 16, 16)
        const d = pctx.getImageData(0, 0, 16, 16).data
        let mn = 255, mx = 0
        for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; if (v < mn) mn = v; if (v > mx) mx = v }
        if (mx - mn < 6) { bmp.close?.(); throw new Error('prázdný/jednolitý obrázek (výpadek ČÚZK)') }
      }
      return bmp
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e // uživatel zrušil → nezkoušet znovu
      lastErr = e
      if (attempt < 4) await new Promise(r => setTimeout(r, 500 * attempt)) // narůstající pauza
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// jádro spojené 2D mapy (ortofoto + topo) přes zadanou S-JTSK obálku → zip s georef. obrázky (world file).
// `clip` (S-JTSK prstence) = ořezat výstup přesně na ten tvar (průhledno kolem) → ortofoto pak jde
// do PNG s alfou (JPEG průhlednost neumí), stejně jako výřez terénu. World file zůstává na obálce.
export async function stitchMapsCore(minX: number, minY: number, maxX: number, maxY: number, signal: AbortSignal, report: (done: number, total: number, msg: string) => void, stitchMax: number, clip?: [number, number][][]) {
  const spanX = maxX - minX, spanY = maxY - minY
  const tier = pickTopoTier(Math.max(spanX, spanY))
  const clipMode = !!(clip && clip.length)

  // Rozměr výstupu na vrstvu: ortofoto je hlavní (plný strop), topo jen orientační podklad
  // (menší strop) → míň/menší ZTM požadavků = rychlejší a spolehlivější (ZTM zlobí nejvíc).
  const dims = (cap: number) => {
    const nW = spanX / STITCH_RES_M, nH = spanY / STITCH_RES_M
    let sc = Math.min(1, cap / Math.max(nW, nH))
    if (nW * sc * nH * sc > STITCH_MAX_AREA) sc = Math.sqrt(STITCH_MAX_AREA / (nW * nH))
    return { W: Math.max(1, Math.round(nW * sc)), H: Math.max(1, Math.round(nH * sc)), sc }
  }
  const bounds = (len: number, n: number) => Array.from({ length: n + 1 }, (_, i) => Math.round(i * len / n))

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D kontext se nepodařilo získat')

  const files: Record<string, Uint8Array | [Uint8Array, { level: number }]> = {}
  const toBytes = async (mime: string, quality?: number): Promise<Uint8Array> => {
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, mime, quality))
    if (!blob) throw new Error('canvas.toBlob selhal')
    return new Uint8Array(await blob.arrayBuffer())
  }

  // ve výřezovém režimu musí i ortofoto nést alfu → PNG (.png/.pgw); jinak zůstává úsporný JPEG
  const layers: { layer: MapLayer; file: string; mime: string; wfile: string; cap: number; q?: number }[] = [
    clipMode
      ? { layer: 'ortofoto', file: 'ortofoto.png', mime: 'image/png', wfile: 'ortofoto.pgw', cap: stitchMax }
      : { layer: 'ortofoto', file: 'ortofoto.jpg', mime: 'image/jpeg', wfile: 'ortofoto.jgw', cap: stitchMax, q: 0.9 },
    { layer: 'topo', file: 'topografie.png', mime: 'image/png', wfile: 'topografie.pgw', cap: TOPO_MAX_PX },
  ]
  // spočítej celkový počet bloků pro průběh
  const layerPlan = layers.map(L => { const d = dims(L.cap); return { L, ...d, nCols: Math.ceil(d.W / STITCH_CHUNK_PX), nRows: Math.ceil(d.H / STITCH_CHUNK_PX) } })
  let done = 0
  const total = layerPlan.reduce((s, p) => s + p.nCols * p.nRows, 0)
  const meta: Record<string, { W: number; H: number; cm: number; native: boolean }> = {}

  for (const { L, W, H, sc, nCols, nRows } of layerPlan) {
    canvas.width = W; canvas.height = H
    ctx.clearRect(0, 0, W, H)
    const cx = bounds(W, nCols), cy = bounds(H, nRows)
    const chunks: { c: number; r: number }[] = []
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) chunks.push({ c, r })
    // souběh jen 2 — ČÚZK ArcGIS je při paralelní zátěži nespolehlivý (proto ty výpadky)
    const imgs = await pool(chunks, 2, async ({ c, r }) => {
      const pxW = cx[c + 1] - cx[c], pxH = cy[r + 1] - cy[r]
      // blok v S-JTSK (pixelové hranice → poměrná část obálky); sever = horní okraj
      const bx0 = minX + spanX * cx[c] / W, bx1 = minX + spanX * cx[c + 1] / W
      const by1 = maxY - spanY * cy[r] / H, by0 = maxY - spanY * cy[r + 1] / H
      const bmp = await loadMapChunk(mapBboxUrl(bx0, by0, bx1, by1, pxW, pxH, L.layer, tier), signal)
      done++
      report(done, total, `mapa ${done}/${total}`)
      return { c, r, bmp, pxW, pxH }
    })
    for (const { c, r, bmp, pxW, pxH } of imgs) { ctx.drawImage(bmp, cx[c], cy[r], pxW, pxH); bmp.close?.() }
    if (clipMode) {
      // ořez na tvar: nakresli polygon(y) území a nech jen to, co je uvnitř (zbytek průhledný)
      ctx.save()
      ctx.globalCompositeOperation = 'destination-in'
      ctx.beginPath()
      for (const ring of clip!) {
        ring.forEach(([x, y], k) => {
          const px = (x - minX) / spanX * W, py = (maxY - y) / spanY * H
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        })
        ctx.closePath()
      }
      ctx.fillStyle = '#000'
      ctx.fill('evenodd') // even-odd zvládne i díry / více oddělených částí území
      ctx.restore()
    }
    files[L.file] = [await toBytes(L.mime, L.q), { level: 0 }] // obrázky už komprimované
    // world file (na vlastní rozměr vrstvy): pixel → S-JTSK, levý-horní pixel = SZ roh
    const psX = spanX / W, psY = spanY / H
    files[L.wfile] = strToU8([psX, 0, 0, -psY, minX + psX / 2, maxY - psY / 2].map(n => n.toFixed(6)).join('\n') + '\n')
    meta[L.layer] = { W, H, cm: spanX / W * 100, native: sc >= 1 }
  }

  const o = meta.ortofoto, tp = meta.topo
  const ortoName = layers[0].file
  files['info.txt'] = strToU8([
    'Spojená mapa (ČÚZK) — ortofoto + topografická mapa',
    ...(clipMode ? ['Ořezáno na tvar území (okolí průhledné) — ortofoto je PNG s alfou.'] : []),
    '',
    `Oblast S-JTSK (EPSG:5514): X ${minX} … ${maxX}, Y ${minY} … ${maxY}`,
    `Rozsah: šířka ${spanX.toFixed(0)} m, výška ${spanY.toFixed(0)} m`,
    '',
    `${ortoName.padEnd(15)}${o.W} × ${o.H} px, ${o.cm.toFixed(1)} cm/px${o.native ? ' (nativní)' : ' (zmenšeno kvůli stropu; menší výběr = ostřejší)'}`,
    `topografie.png: ${tp.W} × ${tp.H} px, ${tp.cm.toFixed(1)} cm/px — jen orientační podklad (${tier})`,
    '',
    'Obě vrstvy kryjí STEJNOU oblast, jen v jiném rozlišení — georeference je ve',
    'world file (.jgw/.pgw) v S-JTSK, takže při stejné velikosti na scéně lícují.',
    clipMode
      ? 'Výřez i world file mají STEJNOU obálku → v AE dej obě na plane přes celou oblast, alfa udělá tvar.'
      : 'GIS/CAD je umístí sám; v AE/Max dej každou na plane přes celou oblast.',
    '',
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
  ].join('\n'))

  const zipped = zipSync(files as Parameters<typeof zipSync>[0], { level: 6 })
  download(zipped, `mapa_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
  toast.success(`Spojená mapa: ortofoto ${o.W}×${o.H} px + topo ${tp.W}×${tp.H} px`)
}


/** Ortofoto pro obálku jako JPEG. Nad 4096 px se skládá po blocích — ČÚZK víc naráz nedá. */
export async function fetchOrthoTexture(minX: number, minY: number, maxX: number, maxY: number, longPx: number, signal: AbortSignal, report: (msg: string) => void): Promise<Uint8Array> {
  const spanX = maxX - minX, spanY = maxY - minY, longSpan = Math.max(spanX, spanY)
  const W = Math.max(1, Math.round(longPx * spanX / longSpan)), H = Math.max(1, Math.round(longPx * spanY / longSpan))
  if (W <= 4096 && H <= 4096) return await fetchJpegRetry(mapBboxUrl(minX, minY, maxX, maxY, W, H, 'ortofoto', 'ZTM250'), signal, 'Ortofoto')
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas 2D nedostupný')
  const nCols = Math.ceil(W / 4096), nRows = Math.ceil(H / 4096)
  const bx = Array.from({ length: nCols + 1 }, (_, i) => Math.round(i * W / nCols))
  const by = Array.from({ length: nRows + 1 }, (_, i) => Math.round(i * H / nRows))
  const total = nCols * nRows; let done = 0
  for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
    if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
    const pxW = bx[c + 1] - bx[c], pxH = by[r + 1] - by[r]
    const x0 = minX + spanX * bx[c] / W, x1 = minX + spanX * bx[c + 1] / W
    const yTop = maxY - spanY * by[r] / H, yBot = maxY - spanY * by[r + 1] / H
    const bmp = await loadMapChunk(mapBboxUrl(x0, yBot, x1, yTop, pxW, pxH, 'ortofoto', 'ZTM250'), signal)
    ctx.drawImage(bmp, bx[c], by[r], pxW, pxH); bmp.close?.()
    report(`stahuji ortofoto ${++done}/${total}…`)
  }
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.92))
  if (!blob) throw new Error('Textura ortofota selhala')
  return new Uint8Array(await blob.arrayBuffer())
}
