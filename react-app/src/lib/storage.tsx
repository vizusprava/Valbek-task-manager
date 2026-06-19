import { useState, useEffect } from 'react'
import { supabase } from './supabase'

// Privátní buckety: soubory se zpřístupňují přes dočasné signed URL místo veřejných URL.
const SIGN_TTL = 60 * 60 // 1 h

/** Vytáhne cestu uvnitř bucketu — přijme buď čistou cestu, nebo starou public/sign URL. */
export function storagePath(bucket: string, value: string): string {
  for (const kind of ['public', 'sign']) {
    const marker = `/storage/v1/object/${kind}/${bucket}/`
    const i = value.indexOf(marker)
    if (i >= 0) return decodeURIComponent(value.slice(i + marker.length).split('?')[0])
  }
  return value // už je to cesta
}

const cache = new Map<string, { url: string; exp: number }>()

/** Vrátí dočasné signed URL pro soubor v privátním bucketu (s in-memory cache). */
export async function signedUrl(bucket: string, value: string | null | undefined, ttl = SIGN_TTL): Promise<string | null> {
  if (!value) return null
  const path = storagePath(bucket, value)
  const key = `${bucket}:${path}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.exp > now + 60_000) return hit.url
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttl)
  if (error || !data) return null
  cache.set(key, { url: data.signedUrl, exp: now + ttl * 1000 })
  return data.signedUrl
}

/** React hook: vrátí signed URL (nebo null, dokud se nenačte). `bust` vynutí re-sign. */
export function useSignedUrl(bucket: string, value: string | null | undefined, bust?: string | number): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!value) { setUrl(null); return }
    signedUrl(bucket, value).then(u => { if (alive) setUrl(u) })
    return () => { alive = false }
  }, [bucket, value, bust])
  return url
}

/** <img> pro soubor v privátním bucketu — podepíše cestu/URL za běhu. */
export function SignedImg({ bucket, value, className, onClick }: {
  bucket: string; value: string; className?: string; onClick?: (src: string) => void
}) {
  const src = useSignedUrl(bucket, value)
  if (!src) return <div className={className} style={{ background: 'rgba(0,0,0,0.06)' }} />
  return <img src={src} alt="" className={className} onClick={onClick ? () => onClick(src) : undefined} />
}
