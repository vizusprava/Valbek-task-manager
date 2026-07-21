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
const CACHE_MAX_BYTES = 800 * 1024 * 1024 // ~800 MB strop; přes to se mažou nejstarší

type Row = { b: Uint8Array; ts: number; n: number } // data, čas posledního použití, velikost

const hasIDB = typeof indexedDB !== 'undefined'
let dbPromise: Promise<IDBDatabase> | null = null
let totalBytes = -1 // −1 = ještě nesečteno

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE)
          s.createIndex('ts', 'ts') // pro mazání nejstarších (LRU)
        }
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
  let sum = 0
  await openDb().then(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly')
    const cur = t.objectStore(STORE).openCursor()
    cur.onsuccess = () => {
      const c = cur.result
      if (c) { sum += (c.value as Row).n; c.continue() } else resolve()
    }
    cur.onerror = () => reject(cur.error)
  }))
  totalBytes = sum
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

/** Maže nejstarší položky (podle indexu ts), dokud celková velikost neklesne pod target. */
async function evictTo(target: number): Promise<void> {
  await openDb().then(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    const cur = store.index('ts').openCursor() // od nejstaršího
    cur.onsuccess = () => {
      const c = cur.result
      if (!c || totalBytes <= target) { resolve(); return }
      totalBytes -= (c.value as Row).n
      c.delete()
      c.continue()
    }
    cur.onerror = () => reject(cur.error)
  }))
}

/** Kolik cache zabírá (položky + bajty) — pro UI. */
export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  if (!hasIDB) return { count: 0, bytes: 0 }
  try {
    const count = await tx<number>('readonly', s => s.count())
    const bytes = await ensureTotal()
    return { count, bytes }
  } catch { return { count: 0, bytes: 0 } }
}

/** Smaže celou cache. */
export async function cacheClear(): Promise<void> {
  if (!hasIDB) return
  try {
    await tx('readwrite', s => s.clear())
    totalBytes = 0
  } catch { /* nevadí */ }
}
