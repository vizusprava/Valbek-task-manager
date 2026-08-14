/**
 * Trvalá cache dlaždic ČÚZK (ortofoto/DMR) v IndexedDB — na disku prohlížeče, vázaná na doménu.
 *
 * Smysl: co se jednou stáhne, podruhé se vezme z disku místo ze sítě. Zrychlí opakované exporty
 * i návraty a odlehčí (flaky) ČÚZK. První stažení je pořád ze sítě — cache nepředstahuje.
 *
 * Vše je BEST-EFFORT: jakýkoliv problém s IndexedDB (kvóta, privátní režim, Node) → tiše se
 * přeskočí a jede se ze sítě. Cache nesmí nikdy shodit appku. V Node (bez `indexedDB`) je no-op,
 * takže tenhle modul jde importovat i z `tiles.ts`, který se testuje mimo prohlížeč.
 */
const DB_NAME = 'geo-tile-cache'
const STORE = 'tiles'
// Malé key→value úložiště (mimo LRU) — drobná metadata, aby přežila refresh.
const KV = 'kv'
// „Lokální mapa": trvale napečené ortofoto dlaždice (pyramida) — klíč `owms/{level}/{x}/{y}`.
// VLASTNÍ store MIMO LRU → nikdy se neevictují, přežijí refresh, načítají se lokálně.
const BAKED = 'baked'
const DB_VERSION = 3
const CACHE_MAX_BYTES = 800 * 1024 * 1024 // ~800 MB strop; přes to se mažou nejstarší

// pin=1 → „stažené natrvalo": LRU eviction je NIKDY nesmaže (viz „Stáhnout do localu")
type Row = { b: Uint8Array; ts: number; n: number; pin?: 1 } // data, čas posledního použití, velikost

const hasIDB = typeof indexedDB !== 'undefined'
let dbPromise: Promise<IDBDatabase> | null = null
let totalBytes = -1 // −1 = ještě nesečteno
let pinnedBytes = 0 // kolik z toho je „připnuté" (jen pro UI)

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE)
          s.createIndex('ts', 'ts') // pro mazání nejstarších (LRU)
        }
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV) // v2: drobná metadata
        if (!db.objectStoreNames.contains(BAKED)) db.createObjectStore(BAKED) // v3: napečené ortofoto dlaždice
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/** Součet velikostí v cache (jednou spočítá, pak drží v paměti). */
async function ensureTotal(): Promise<number> {
  if (totalBytes >= 0) return totalBytes
  let sum = 0, pin = 0
  await openDb().then(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly')
    const cur = t.objectStore(STORE).openCursor()
    cur.onsuccess = () => {
      const c = cur.result
      if (c) { const r = c.value as Row; sum += r.n; if (r.pin) pin += r.n; c.continue() } else resolve()
    }
    cur.onerror = () => reject(cur.error)
  }))
  totalBytes = sum; pinnedBytes = pin
  return sum
}

/** Vrátí uložené bajty, nebo null. Při hitu osvěží čas (LRU), ať se nesmažou aktivní dlaždice. */
export async function cacheGet(key: string): Promise<Uint8Array | null> {
  if (!hasIDB) return null
  try {
    const row = await tx<Row | undefined>('readonly', s => s.get(key))
    if (!row) return null
    // osvěžení času děláme na pozadí (nečekáme na něj) — na výsledek nemá vliv
    tx('readwrite', s => s.put({ ...row, ts: Date.now() }, key)).catch(() => {})
    return row.b
  } catch { return null }
}

/** Uloží bajty. Přes strop maže nejstarší. Selhání (kvóta) tiše ignoruje. */
export async function cachePut(key: string, bytes: Uint8Array): Promise<void> {
  if (!hasIDB) return
  try {
    const total = await ensureTotal()
    if (total + bytes.length > CACHE_MAX_BYTES) await evictTo(CACHE_MAX_BYTES - bytes.length)
    await tx('readwrite', s => s.put({ b: bytes, ts: Date.now(), n: bytes.length } as Row, key))
    totalBytes = Math.max(0, totalBytes) + bytes.length
  } catch { /* kvóta / jiná chyba → prostě necachujeme */ }
}

/** Maže nejstarší NEPŘIPNUTÉ položky (podle indexu ts), dokud velikost neklesne pod target. */
async function evictTo(target: number): Promise<void> {
  await openDb().then(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    const cur = store.index('ts').openCursor() // od nejstaršího
    cur.onsuccess = () => {
      const c = cur.result
      if (!c || totalBytes <= target) { resolve(); return }
      if ((c.value as Row).pin) { c.continue(); return } // připnuté nikdy nemažeme
      totalBytes -= (c.value as Row).n
      c.delete()
      c.continue()
    }
    cur.onerror = () => reject(cur.error)
  }))
}

/** Kolik cache zabírá (položky + bajty, z toho připnuté) — pro UI. */
export async function cacheStats(): Promise<{ count: number; bytes: number; pinnedBytes: number }> {
  if (!hasIDB) return { count: 0, bytes: 0, pinnedBytes: 0 }
  try {
    const count = await tx<number>('readonly', s => s.count())
    const bytes = await ensureTotal()
    return { count, bytes, pinnedBytes }
  } catch { return { count: 0, bytes: 0, pinnedBytes: 0 } }
}

/** Smaže celou cache (VČETNĚ připnutých stažených dlaždic). */
export async function cacheClear(): Promise<void> {
  if (!hasIDB) return
  try {
    await tx('readwrite', s => s.clear())
    totalBytes = 0; pinnedBytes = 0
  } catch { /* nevadí */ }
}

// ── key→value úložiště (mimo LRU) — pro „lokální 2D mapu", ať přežije refresh ──
function kvReq<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(KV, mode).objectStore(KV))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/** Načte uložené bajty z KV (mimo LRU), nebo null. */
export async function kvGet(key: string): Promise<Uint8Array | null> {
  if (!hasIDB) return null
  try { return (await kvReq<Uint8Array | undefined>('readonly', s => s.get(key))) ?? null }
  catch { return null }
}

/** Uloží bajty do KV (mimo LRU — nikdy se neevictují). Selhání (kvóta) tiše ignoruje. */
export async function kvPut(key: string, bytes: Uint8Array): Promise<void> {
  if (!hasIDB) return
  try { await kvReq('readwrite', s => s.put(bytes, key)) }
  catch { /* kvóta / jiná chyba → prostě neuložíme */ }
}

/** Smaže klíč z KV. */
export async function kvDel(key: string): Promise<void> {
  if (!hasIDB) return
  try { await kvReq('readwrite', s => s.delete(key)) }
  catch { /* nevadí */ }
}

// ── „Lokální mapa": trvale napečené ortofoto dlaždice (store BAKED, mimo LRU) ──
function bakedReq<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(BAKED, mode).objectStore(BAKED))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/** Napečená dlaždice, nebo null. */
export async function bakedGet(key: string): Promise<Uint8Array | null> {
  if (!hasIDB) return null
  try { return (await bakedReq<Uint8Array | undefined>('readonly', s => s.get(key))) ?? null }
  catch { return null }
}

/** Uloží napečenou dlaždici (mimo LRU — nikdy se neeviktuje). */
export async function bakedPut(key: string, bytes: Uint8Array): Promise<void> {
  if (!hasIDB) return
  try { await bakedReq('readwrite', s => s.put(bytes, key)) }
  catch { /* kvóta / jiná chyba → tiše přeskoč */ }
}

/** Klíče všech napečených dlaždic (pro synchronní index v paměti při startu). */
export async function bakedAllKeys(): Promise<string[]> {
  if (!hasIDB) return []
  try { return (await bakedReq<IDBValidKey[]>('readonly', s => s.getAllKeys())).map(String) }
  catch { return [] }
}

/** Počet napečených dlaždic (pro UI; velikost se odhaduje). */
export async function bakedCount(): Promise<number> {
  if (!hasIDB) return 0
  try { return await bakedReq<number>('readonly', s => s.count()) }
  catch { return 0 }
}

/** Smaže VŠECHNY napečené dlaždice (celou lokální mapu). */
export async function bakedClear(): Promise<void> {
  if (!hasIDB) return
  try { await bakedReq('readwrite', s => s.clear()) }
  catch { /* nevadí */ }
}
