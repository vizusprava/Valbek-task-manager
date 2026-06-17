import type { ViewerAdapter, ViewerAnnotation, ObjectColorRecord, VegGroup, SceneOrg, SavedView, MaterialDef } from '@core'

// ── IndexedDB pro bloby textur (localStorage je na binárky malý) ──
let dbPromise: Promise<IDBDatabase> | null = null

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('lab-textures', 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('tex') }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tex', 'readwrite')
    tx.objectStore('tex').put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet(key: string): Promise<Blob | undefined> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction('tex', 'readonly').objectStore('tex').get(key)
    req.onsuccess = () => resolve(req.result as Blob | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbKeys(): Promise<string[]> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction('tex', 'readonly').objectStore('tex').getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(key: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tex', 'readwrite')
    tx.objectStore('tex').delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const texUrlCache = new Map<string, string>()

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

const colorsKey = (id: string) => `lab_colors_${id}`
const vegKey    = (id: string) => `lab_veg_${id}`
const annKey    = (id: string) => `lab_annotations_${id}`
const orgKey    = (id: string) => `lab_org_${id}`
const viewsKey  = (id: string) => `lab_views_${id}`

/**
 * Persistence do localStorage — anotace, vegetace i barvy přežijí reload,
 * pokud znovu otevřeš stejný soubor (klíčem je název + velikost souboru).
 * Pozici kamery si ukládá CameraPersist v jádru sám.
 */
export const localViewerAdapter: ViewerAdapter = {
  async fetchObjectColors(modelId) {
    return read<ObjectColorRecord[]>(colorsKey(modelId), [])
  },

  async saveObjectColor(modelId, objectName, color) {
    const rest = read<ObjectColorRecord[]>(colorsKey(modelId), []).filter(c => c.object_name !== objectName)
    write(colorsKey(modelId), [...rest, { object_name: objectName, color }])
  },

  async fetchVegetation(modelId) {
    return read<VegGroup[] | null>(vegKey(modelId), null)
  },

  async saveVegetation(modelId, groups) {
    write(vegKey(modelId), groups)
  },

  async fetchAnnotations(modelId) {
    return read<ViewerAnnotation[]>(annKey(modelId), [])
  },

  async createAnnotation(modelId, annotation) {
    const list = read<ViewerAnnotation[]>(annKey(modelId), [])
    write(annKey(modelId), [...list, { id: crypto.randomUUID(), offsetX: 0, offsetY: 0, extraPoints: [], ...annotation }])
  },

  async deleteAnnotation(modelId, id) {
    write(annKey(modelId), read<ViewerAnnotation[]>(annKey(modelId), []).filter(a => a.id !== id))
  },

  async updateAnnotationOffset(modelId, id, offsetX, offsetY) {
    write(annKey(modelId), read<ViewerAnnotation[]>(annKey(modelId), []).map(a => a.id === id ? { ...a, offsetX, offsetY } : a))
  },

  async updateAnnotationPoints(modelId, id, points) {
    write(annKey(modelId), read<ViewerAnnotation[]>(annKey(modelId), []).map(a => a.id === id ? { ...a, extraPoints: points } : a))
  },

  async updateAnnotationColor(modelId, id, color) {
    write(annKey(modelId), read<ViewerAnnotation[]>(annKey(modelId), []).map(a => a.id === id ? { ...a, color } : a))
  },

  async fetchSceneOrg(modelId) {
    return read<SceneOrg | null>(orgKey(modelId), null)
  },

  async saveSceneOrg(modelId, org) {
    write(orgKey(modelId), org)
  },

  async fetchViews(modelId) {
    return read<SavedView[]>(viewsKey(modelId), [])
  },

  async createView(modelId, view) {
    write(viewsKey(modelId), [...read<SavedView[]>(viewsKey(modelId), []), view])
  },

  async deleteView(modelId, viewId) {
    write(viewsKey(modelId), read<SavedView[]>(viewsKey(modelId), []).filter(v => v.id !== viewId))
  },

  async renameView(modelId, viewId, name) {
    write(viewsKey(modelId), read<SavedView[]>(viewsKey(modelId), []).map(v => v.id === viewId ? { ...v, name } : v))
  },

  async updateViewCamera(modelId, viewId, camera) {
    write(viewsKey(modelId), read<SavedView[]>(viewsKey(modelId), []).map(v => v.id === viewId ? { ...v, camera } : v))
  },

  async reorderViews(modelId, orderedIds) {
    const views = read<SavedView[]>(viewsKey(modelId), [])
    const byId = new Map(views.map(v => [v.id, v]))
    write(viewsKey(modelId), orderedIds.map(id => byId.get(id)).filter((v): v is SavedView => !!v))
  },

  async updateViewAnnotations(modelId, viewId, annotationIds) {
    write(viewsKey(modelId), read<SavedView[]>(viewsKey(modelId), []).map(v => v.id === viewId ? { ...v, annotationIds } : v))
  },

  async fetchMaterials() {
    return read<MaterialDef[]>('lab_materials', [])
  },

  async saveMaterial(material) {
    const rest = read<MaterialDef[]>('lab_materials', []).filter(m => m.id !== material.id)
    write('lab_materials', [...rest, material])
  },

  async deleteMaterial(materialId) {
    write('lab_materials', read<MaterialDef[]>('lab_materials', []).filter(m => m.id !== materialId))
    const keys = await idbKeys()
    await Promise.all(keys.filter(k => k.startsWith(`tex_${materialId}_`)).map(k => idbDelete(k)))
  },

  async uploadTexture(materialId, mapType, data, ext) {
    const key = `tex_${materialId}_${mapType}_${Date.now()}.${ext}`
    await idbPut(key, data)
    return key
  },

  async getTextureUrl(path) {
    const cached = texUrlCache.get(path)
    if (cached) return cached
    const blob = await idbGet(path)
    if (!blob) throw new Error('Textura nenalezena v lokálním úložišti')
    const url = URL.createObjectURL(blob)
    texUrlCache.set(path, url)
    return url
  },
}
