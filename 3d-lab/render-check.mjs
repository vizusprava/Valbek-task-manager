// Headless kontrola renderu: otevře test.html, posbírá konzoli a uloží screenshot.
// Použití: node render-check.mjs "http://localhost:5173/test.html?soft=1" out.png
import puppeteer from 'puppeteer-core'

const [url, out] = process.argv.slice(2)
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const { existsSync } = await import('fs')
const exe = candidates.find(p => existsSync(p))
if (!exe) { console.error('NO_BROWSER'); process.exit(2) }

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
})
const page = await browser.newPage()
await page.setViewport({ width: 640, height: 480 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 500)}`))
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 500)}`))
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
await new Promise(r => setTimeout(r, 3500))

const stats = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return { error: 'no canvas' }
  const t = document.createElement('canvas')
  t.width = 64; t.height = 48
  const ctx = t.getContext('2d')
  ctx.drawImage(c, 0, 0, 64, 48)
  const d = ctx.getImageData(0, 0, 64, 48).data
  let sum = 0, max = 0
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3
    sum += v
    if (v > max) max = v
  }
  return { avg: +(sum / (d.length / 4)).toFixed(1), max }
})
await page.screenshot({ path: out })
console.log(JSON.stringify({ stats, logs: logs.filter(l => l.includes('error') || l.includes('THREE') || l.includes('WebGL')).slice(0, 12) }, null, 1))
await browser.close()
