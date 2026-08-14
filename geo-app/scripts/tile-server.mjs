#!/usr/bin/env node
/**
 * Lokální dlaždicový server nad staženými ortofoto dlaždicemi (local-tiles/).
 * CORS je zapnutý, protože Cesium v appce fetchuje dlaždice cross-origin (jiný port).
 *
 * Spuštění (z geo-app):  node scripts/tile-server.mjs
 * Pak v appce nastav (geo-app/.env.local):  VITE_LOCAL_TILES=http://localhost:8788
 * Dlaždice pak jedou z  http://localhost:8788/orto/{z}/{x}/{y}.jpg
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..', 'local-tiles')
const PORT = +(process.env.PORT ?? 8788)

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const p = path.join(ROOT, rel)
    if (!p.startsWith(ROOT)) { res.statusCode = 403; return res.end() } // žádné ../ ven
    const buf = await readFile(p)
    res.setHeader('Content-Type', p.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.end(buf)
  } catch { res.statusCode = 404; res.end() }
}).listen(PORT, () => {
  console.log(`Lokální dlaždice: http://localhost:${PORT}/   (kořen: ${ROOT})`)
  console.log(`V appce nastav:   VITE_LOCAL_TILES=http://localhost:${PORT}   (do geo-app/.env.local)`)
})
