import * as THREE from 'three'
import type { MaterialDef, MaterialAssignment, TextureMapType, ViewerAdapter } from './adapter'

export const MAP_LABELS: Record<TextureMapType, string> = {
  albedo: 'Albedo',
  normal: 'Normal',
  roughness: 'Roughness',
  metalness: 'Metallic',
  ao: 'AO',
  emissive: 'Emissive',
  opacity: 'Opacity',
  height: 'Height',
}

const MAP_TOKENS: Record<TextureMapType, string[]> = {
  albedo:    ['albedo', 'basecolor', 'diffuse', 'diff', 'color', 'col', 'alb'],
  normal:    ['normal', 'normalgl', 'normaldx', 'nrm', 'norm', 'nor'],
  roughness: ['roughness', 'rough', 'rgh'],
  metalness: ['metallic', 'metalness', 'metal', 'mtl', 'met'],
  ao:        ['ao', 'ambientocclusion', 'occlusion', 'occ'],
  emissive:  ['emissive', 'emission', 'emit', 'emis'],
  opacity:   ['opacity', 'alpha', 'mask', 'transparency'],
  height:    ['height', 'displacement', 'disp', 'bump'],
}

/** Rozpozná typ mapy z názvu souboru (tokeny oddělené _-. mezerou, hledá se od konce). */
export function detectMapType(fileName: string): TextureMapType | null {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase()
  const tokens = base.split(/[_\-. ]+/).filter(Boolean)
  for (let i = tokens.length - 1; i >= 0; i--) {
    // "basecolor2k" apod. — odřízni koncové číslice/k
    const token = tokens[i].replace(/\d+k?$/, '')
    for (const [type, keys] of Object.entries(MAP_TOKENS) as [TextureMapType, string[]][]) {
      if (keys.includes(token) || keys.includes(tokens[i])) return type
    }
  }
  return null
}

export const TEXTURE_MAX_DIM = 2048

/**
 * Rozparsuje název souloru textury na materiál + typ mapy.
 * Konvence: <prefix>_<jméno>_<rozlišení>_<mapa>.ext, mapa je poslední token.
 * Příklad: `TCom_Brick_Modern_2K_albedo.tif` → { name: "Brick Modern", mapType: "albedo" }
 */
export function parseMaterialFile(fileName: string): { name: string; groupKey: string; mapType: TextureMapType } | null {
  const base = fileName.replace(/\.[^.]+$/, '')
  const tokens = base.split('_').filter(Boolean)
  if (tokens.length < 2) return null
  const mapType = detectMapType(tokens[tokens.length - 1])
  if (!mapType) return null
  const keyTokens = tokens.slice(0, -1)
  // jméno: zahoď prefix "TCom", token rozlišení (1K/2K) a rozměr dlaždice (1.5x1.5)
  const nameTokens = keyTokens.filter((t, i) =>
    !(i === 0 && /^tcom$/i.test(t)) &&
    !/^\d+k$/i.test(t) &&
    !/^\d+(\.\d+)?x\d+(\.\d+)?$/i.test(t))
  const name = (nameTokens.join(' ') || keyTokens.join(' ')).trim()
  return { name, groupKey: keyTokens.join('_').toLowerCase(), mapType }
}

/** Seskupí ploché soubory textur do materiálů podle názvu. Vrátí i nerozpoznané. */
export function groupMaterialFiles(files: File[]): {
  groups: { name: string; maps: { mapType: TextureMapType; file: File }[] }[]
  skipped: string[]
} {
  const map = new Map<string, { name: string; maps: { mapType: TextureMapType; file: File }[] }>()
  const skipped: string[] = []
  for (const file of files) {
    const p = parseMaterialFile(file.name)
    if (!p) { skipped.push(file.name); continue }
    let g = map.get(p.groupKey)
    if (!g) { g = { name: p.name, maps: [] }; map.set(p.groupKey, g) }
    if (!g.maps.some(m => m.mapType === p.mapType)) g.maps.push({ mapType: p.mapType, file })
  }
  return { groups: [...map.values()], skipped }
}

const TIFF_RE = /\.tiff?$/i

/** Prohlížeč TIFF nedekóduje — UTIF.js ho rozbalí do canvasu. */
async function tiffToCanvas(file: File): Promise<HTMLCanvasElement> {
  const { default: UTIF } = await import('utif')
  const buf = await file.arrayBuffer()
  const ifds = UTIF.decode(buf)
  if (!ifds.length) throw new Error('TIFF se nepodařilo dekódovat')
  UTIF.decodeImage(buf, ifds[0])
  const rgba = UTIF.toRGBA8(ifds[0])
  const canvas = document.createElement('canvas')
  canvas.width = ifds[0].width
  canvas.height = ifds[0].height
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(canvas.width, canvas.height)
  img.data.set(rgba)
  ctx.putImageData(img, 0, 0)
  return canvas
}

function toBlobAsync(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(res => canvas.toBlob(res, type, quality))
}

/**
 * Příprava textury pro upload: downscale na max 2048 a konverze do WebP.
 * Normal mapy se nechávají v originálu beze změny (žádná rekomprese = žádná ztráta detailů);
 * TIFF normal mapa se převede bezeztrátově do PNG v plném rozlišení.
 */
export async function processTextureFile(file: File, mapType: TextureMapType, maxDim = TEXTURE_MAX_DIM): Promise<{ blob: Blob; ext: string }> {
  const isTiff = TIFF_RE.test(file.name) || file.type === 'image/tiff'
  const isNormal = mapType === 'normal'

  // normal v běžném formátu bez požadavku na downscale → originál (žádná rekomprese)
  if (isNormal && !isTiff && maxDim >= TEXTURE_MAX_DIM) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    return { blob: file, ext }
  }

  const source: HTMLCanvasElement | ImageBitmap = isTiff
    ? await tiffToCanvas(file)
    : await createImageBitmap(file)

  if (isNormal) {
    // normal mapa — bezeztrátové PNG (po případném zmenšení na maxDim)
    const scale = Math.min(1, maxDim / Math.max(source.width, source.height))
    const w = Math.max(1, Math.round(source.width * scale))
    const h = Math.max(1, Math.round(source.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d')!.drawImage(source, 0, 0, w, h)
    if (source instanceof ImageBitmap) source.close()
    const png = await toBlobAsync(canvas, 'image/png')
    if (!png) throw new Error('Konverze textury selhala')
    return { blob: png, ext: 'png' }
  }

  const scale = Math.min(1, maxDim / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(source, 0, 0, w, h)
  if (source instanceof ImageBitmap) source.close()

  const webp = await toBlobAsync(canvas, 'image/webp', 0.85)
  if (webp && webp.type === 'image/webp') return { blob: webp, ext: 'webp' }
  const png = await toBlobAsync(canvas, 'image/png')
  if (!png) throw new Error('Konverze textury selhala')
  return { blob: png, ext: 'png' }
}

/**
 * Výchozí sklo — neprůhledné, reflexní, ale ne zrcadlo: vysoká metalnost
 * s mírnou drsností rozmaže odrazy, modrošedý tint dává architektonický vzhled.
 * Seeduje se jednorázově do knihovny (viz Viewer).
 */
export const DEFAULT_GLASS: MaterialDef = {
  id: 'builtin-glass',
  name: 'Sklo',
  tint: '#88a9bd',
  roughness: 0.12,
  metalness: 0.88,
  maps: {},
}

// ── Načítání textur a stavba materiálů ─────────────────────────

const SRGB_MAPS = new Set<TextureMapType>(['albedo', 'emissive'])
const texCache = new Map<string, Promise<THREE.Texture>>()

function loadTexture(adapter: ViewerAdapter, path: string, srgb: boolean): Promise<THREE.Texture> {
  const key = `${path}|${srgb ? 's' : 'l'}`
  let p = texCache.get(key)
  if (!p) {
    p = (async () => {
      const url = await adapter.getTextureUrl(path)
      const tex = await new THREE.TextureLoader().loadAsync(url)
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.anisotropy = 8
      return tex
    })()
    texCache.set(key, p)
  }
  return p
}

/**
 * Procedurální grunge: fbm šum ve world space vložený do standardního shaderu.
 * Moduluje albedo a roughness — rozbije viditelné opakování dlaždic na velkých
 * plochách (silnice, mostovky). Nezávislý na UV, nikdy se neopakuje.
 */
function applyGrunge(mat: THREE.MeshStandardMaterial, amount: number, scale: number) {
  mat.onBeforeCompile = shader => {
    shader.uniforms.uGrungeAmount = { value: amount }
    shader.uniforms.uGrungeScale = { value: Math.max(scale, 0.01) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrungeWorldPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGrungeWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGrungeWorldPos;
uniform float uGrungeAmount;
uniform float uGrungeScale;
float grungeHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float grungeNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(grungeHash(i), grungeHash(i + vec3(1.0,0.0,0.0)), f.x),
        mix(grungeHash(i + vec3(0.0,1.0,0.0)), grungeHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
    mix(mix(grungeHash(i + vec3(0.0,0.0,1.0)), grungeHash(i + vec3(1.0,0.0,1.0)), f.x),
        mix(grungeHash(i + vec3(0.0,1.0,1.0)), grungeHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float grungeFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * grungeNoise(p);
    p *= 2.13;
    a *= 0.5;
  }
  return v;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float g = grungeFbm(vGrungeWorldPos / uGrungeScale);
  diffuseColor.rgb *= mix(1.0, 0.55 + 0.9 * g, uGrungeAmount);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  float gr = grungeFbm(vGrungeWorldPos / uGrungeScale + vec3(37.7, 17.3, 59.1));
  roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.7 + 0.6 * gr, uGrungeAmount), 0.02, 1.0);
}`)
  }
  mat.customProgramCacheKey = () => 'viewer-grunge'
}

async function buildMaterial(def: MaterialDef, adapter: ViewerAdapter): Promise<THREE.MeshStandardMaterial> {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(def.tint || '#ffffff'),
    roughness: def.maps.roughness ? 1 : (def.roughness ?? 1),
    metalness: def.maps.metalness ? 1 : (def.metalness ?? 0),
    side: THREE.DoubleSide,
  })
  if ((def.grunge ?? 0) > 0) applyGrunge(mat, def.grunge!, def.grungeScale ?? 8)
  const jobs: Promise<void>[] = []
  for (const [type, path] of Object.entries(def.maps ?? {}) as [TextureMapType, string][]) {
    if (!path) continue
    jobs.push(loadTexture(adapter, path, SRGB_MAPS.has(type)).then(tex => {
      switch (type) {
        case 'albedo':    mat.map = tex; break
        case 'normal': {
          mat.normalMap = tex
          const s = def.normalStrength ?? 1
          mat.normalScale.set(s, s)
          break
        }
        case 'roughness': mat.roughnessMap = tex; break
        case 'metalness': mat.metalnessMap = tex; break
        case 'ao':        mat.aoMap = tex; break
        case 'emissive':  mat.emissiveMap = tex; mat.emissive = new THREE.Color('#ffffff'); break
        case 'opacity':   mat.alphaMap = tex; mat.transparent = true; break
        case 'height':    mat.bumpMap = tex; mat.bumpScale = def.heightStrength ?? 1; break
      }
      mat.needsUpdate = true
    }).catch(() => { /* chybějící textura nesmí shodit viewer */ }))
  }
  await Promise.all(jobs)
  return mat
}

const matCache = new Map<string, Promise<THREE.MeshStandardMaterial>>()

/** Instance THREE materiálu pro definici — cache podle obsahu definice (editace = nová instance). */
export function getMaterialInstance(def: MaterialDef, adapter: ViewerAdapter): Promise<THREE.MeshStandardMaterial> {
  const key = JSON.stringify(def)
  let p = matCache.get(key)
  if (!p) {
    p = buildMaterial(def, adapter)
    matCache.set(key, p)
  }
  return p
}

// ── Generování UV: box projekce ve world space ─────────────────

/**
 * Vygeneruje UV box projekcí ve světových souřadnicích — 1 dlaždice = tileSize metrů.
 * Funguje i na geometrii bez UV (typicky CAD/BIM exporty). Indexovaná geometrie se
 * de-indexuje, aby každý trojúhelník dostal projekci podle své dominantní normály.
 */
export function applyBoxUV(mesh: THREE.Mesh, asg: MaterialAssignment) {
  let geo = mesh.geometry as THREE.BufferGeometry
  if (geo.index) {
    geo = geo.toNonIndexed()
    mesh.geometry = geo
  }
  const pos = geo.attributes.position as THREE.BufferAttribute
  mesh.updateWorldMatrix(true, false)
  const m = mesh.matrixWorld
  const count = pos.count
  const uvArr = new Float32Array(count * 2)

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3()
  const invTile = 1 / Math.max(asg.tileSize || 1, 0.001)
  const rot = THREE.MathUtils.degToRad(asg.rotation || 0)
  const cos = Math.cos(rot), sin = Math.sin(rot)

  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, i).applyMatrix4(m)
    b.fromBufferAttribute(pos, i + 1).applyMatrix4(m)
    c.fromBufferAttribute(pos, i + 2).applyMatrix4(m)
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a))
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z)
    for (let j = 0; j < 3; j++) {
      const p = j === 0 ? a : j === 1 ? b : c
      let u: number, v: number
      if (ay >= ax && ay >= az)      { u = p.x; v = p.z } // vodorovné plochy
      else if (ax >= az)             { u = p.z; v = p.y } // plochy kolmé na X
      else                           { u = p.x; v = p.y } // plochy kolmé na Z
      u *= invTile; v *= invTile
      uvArr[(i + j) * 2]     = u * cos - v * sin + (asg.offsetX || 0)
      uvArr[(i + j) * 2 + 1] = u * sin + v * cos + (asg.offsetY || 0)
    }
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2))
  geo.attributes.uv.needsUpdate = true
}
