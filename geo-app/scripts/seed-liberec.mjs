#!/usr/bin/env node
/**
 * Seeder ortofota ČÚZK pro Liberec → lokální WebMercator XYZ pyramida (local-tiles/orto/{z}/{x}/{y}.jpg).
 * Slouží jako lokální náhrada živého WMS podkladu (viz VITE_LOCAL_TILES v appce).
 *
 * ZDVOŘILÝ: nízký souběh + prodleva + retry na blank/error (ČÚZK při zátěži vrací PRÁZDNÉ dlaždice).
 * RESUMABLE: hotové dlaždice přeskočí → jde pustit na víckrát / po výpadku znovu.
 *
 * Spuštění (z adresáře geo-app):
 *   node scripts/seed-liberec.mjs
 * Ladění přes proměnné prostředí (když ČÚZK moc blankuje, zpomal):
 *   CONC=1 DELAY=400 node scripts/seed-liberec.mjs
 *   ZMIN=10 ZMAX=19  node scripts/seed-liberec.mjs   (rozsah zoomů; 19 ≈ nativních 20 cm/px)
 *
 * Pozn.: ČÚZK ortofoto je otevřená data, ale stahuj slušně (nízký souběh) a s uvedením zdroje.
 */
import { mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

// Liberec (stejný extent jako LIBEREC_EXTENT v appce)
const LON0 = 14.98, LAT0 = 50.72, LON1 = 15.13, LAT1 = 50.81
const ZMIN = +(process.env.ZMIN ?? 10)
const ZMAX = +(process.env.ZMAX ?? 19)          // 19 ≈ nativní ortofoto 20 cm/px na šířce ČR
const CONC = +(process.env.CONC ?? 2)           // souběh — víc = riziko blank dlaždic z ČÚZK
const DELAY = +(process.env.DELAY ?? 150)        // ms prodleva na workera (zdvořilost)
const RETRIES = 6
const MIN_BYTES = 1500                           // menší odpověď = skoro jistě chyba/blank → retry
const OUT = path.join(import.meta.dirname, '..', 'local-tiles', 'orto')

// ── WebMercator XYZ dlaždicová matematika (256 px, standardní slippy schéma) ──
const R = 20037508.342789244
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z)
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z) }
const x2m = (x, z) => x / 2 ** z * 2 * R - R
const y2m = (y, z) => R - y / 2 ** z * 2 * R

function tilesForZ(z) {
  const x0 = lon2x(LON0, z), x1 = lon2x(LON1, z)
  const y0 = lat2y(LAT1, z), y1 = lat2y(LAT0, z) // sever = menší y
  const out = []
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push({ z, x, y })
  return out
}
function url(z, x, y) {
  const minX = x2m(x, z), maxX = x2m(x + 1, z), maxY = y2m(y, z), minY = y2m(y + 1, z)
  return `https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer/export?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image`
}
const dest = (z, x, y) => path.join(OUT, String(z), String(x), `${y}.jpg`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchTile(z, x, y) {
  for (let a = 1; a <= RETRIES; a++) {
    try {
      const r = await fetch(url(z, x, y))
      const ct = r.headers.get('content-type') || ''
      const buf = Buffer.from(await r.arrayBuffer())
      if (r.ok && ct.includes('image/jpeg') && buf.length >= MIN_BYTES) return buf
    } catch { /* síť → retry */ }
    await sleep(300 * a) // narůstající pauza (throttle ČÚZK)
  }
  return null
}

// pracovní seznam + resume (přeskoč už stažené)
const all = []
for (let z = ZMIN; z <= ZMAX; z++) all.push(...tilesForZ(z))
const todo = all.filter(t => { try { return statSync(dest(t.z, t.x, t.y)).size < MIN_BYTES } catch { return true } })
const perZ = {}
for (let z = ZMIN; z <= ZMAX; z++) perZ[z] = tilesForZ(z).length
console.log(`Liberec ortofoto  z${ZMIN}–${ZMAX}`)
console.log('dlaždic na úroveň:', Object.entries(perZ).map(([z, n]) => `z${z}:${n}`).join('  '))
console.log(`celkem ${all.length}, k stažení ${todo.length} (${all.length - todo.length} hotových), souběh ${CONC}, prodleva ${DELAY} ms`)
console.log(`výstup: ${OUT}\n`)

let done = 0, fail = 0, bytes = 0
const t0 = performance.now()
function report() {
  const el = (performance.now() - t0) / 1000, rate = done / el || 0, eta = (todo.length - done) / (rate || 1)
  const et = eta < 90 ? `${eta.toFixed(0)} s` : eta < 5400 ? `${(eta / 60).toFixed(0)} min` : `${(eta / 3600).toFixed(1)} h`
  process.stdout.write(`\r${done}/${todo.length}  ${rate.toFixed(1)} dl/s  ${(bytes / 1048576).toFixed(0)} MB  chyby ${fail}  ETA ${et}      `)
}
async function worker(iter) {
  for (const t of iter) {
    const buf = await fetchTile(t.z, t.x, t.y)
    if (buf) { const d = dest(t.z, t.x, t.y); mkdirSync(path.dirname(d), { recursive: true }); const tmp = `${d}.tmp`; writeFileSync(tmp, buf); renameSync(tmp, d); bytes += buf.length }
    else fail++
    done++
    if (done % 10 === 0 || done === todo.length) report()
    if (DELAY) await sleep(DELAY)
  }
}
const it = todo[Symbol.iterator]()
await Promise.all(Array.from({ length: CONC }, () => worker(it)))
report()
console.log(`\n\nHotovo: ${done - fail} uloženo · ${fail} selhalo · ${(bytes / 1048576).toFixed(1)} MB v ${OUT}`)
if (fail) console.log(`${fail} dlaždic selhalo (nejspíš throttle ČÚZK = blank). Pusť skript ZNOVU (resumable), ideálně: CONC=1 DELAY=400 node scripts/seed-liberec.mjs`)
