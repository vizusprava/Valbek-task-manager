/**
 * Umeyama/Horn similarity fit: najde měřítko c, rotaci R a posun t tak, že dst_i ≈ c·R·src_i + t
 * (least-squares). Používá se na georeferencování splatu/mračna přes vlícovací body: klikneš dvojice
 * (bod ve světě splatu ↔ tentýž bod na reálné mapě) a tohle spočítá nejlepší transformaci.
 *
 * Rotace přes Hornovu kvaternionovou metodu (největší vlastní vektor symetrické 4×4 matice) → vždy
 * validní rotace (žádný reflection problém). Bez závislostí (Cesium/DOM) → testovatelné v Node.
 */
export type V3 = [number, number, number]

/** Symetrický eigen-rozklad (cyklický Jacobi) pro n×n. A = symetrická (n×n, row-major pole polí).
 *  Vrací vlastní čísla + vektory (sloupce). Pro naše n≤4 pár desítek iterací bohatě stačí. */
export function jacobiEig(A: number[][], n: number): { values: number[]; vectors: number[][] } {
  const a = A.map(r => r.slice())
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += Math.abs(a[p][q])
    if (off < 1e-15) break
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p][q]
      if (Math.abs(apq) < 1e-18) continue
      const theta = (a[q][q] - a[p][p]) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < n; k++) {
        const akp = a[k][p], akq = a[k][q]
        a[k][p] = c * akp - s * akq
        a[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p][k], aqk = a[q][k]
        a[p][k] = c * apk - s * aqk
        a[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q]
        V[k][p] = c * vkp - s * vkq
        V[k][q] = s * vkp + c * vkq
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: V }
}

/** Kvaternion [w,x,y,z] → rotace (row-major 9). */
function quatToR(q: number[]): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  const w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]
}

const mulR = (R: number[], v: V3): V3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
]

/**
 * @returns {c, R (row-major 9), t (3)} nebo null (méně než 3 body / degenerovaná/kolineární sada).
 * `rms` = průměrná zbytková odchylka v jednotkách dst (metry) — pro info o kvalitě fitu.
 */
export function solveSimilarity(src: V3[], dst: V3[]): { c: number; R: number[]; t: V3; rms: number } | null {
  const n = src.length
  if (n < 3 || dst.length !== n) return null
  // centroidy
  const mp: V3 = [0, 0, 0], mq: V3 = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { mp[k] += src[i][k]; mq[k] += dst[i][k] }
  for (let k = 0; k < 3; k++) { mp[k] /= n; mq[k] /= n }
  // kovariance M = Σ p' q'^T (p'=src centr., q'=dst centr.), var σ²_p, a src kovariance Cp (na kolinearitu)
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const Cp = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  let varP = 0
  for (let i = 0; i < n; i++) {
    const p: V3 = [src[i][0] - mp[0], src[i][1] - mp[1], src[i][2] - mp[2]]
    const q: V3 = [dst[i][0] - mq[0], dst[i][1] - mq[1], dst[i][2] - mq[2]]
    varP += p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
    for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) { M[r * 3 + cc] += p[r] * q[cc]; Cp[r][cc] += p[r] * p[cc] }
  }
  varP /= n
  if (varP < 1e-12) return null
  // kolineární body (2. největší vlastní číslo zanedbatelné) = rotace nedourčená → odmítni
  const ev = jacobiEig(Cp, 3).values.slice().sort((a, b) => b - a)
  if (ev[1] < 1e-6 * ev[0]) return null
  const Sxx = M[0], Sxy = M[1], Sxz = M[2], Syx = M[3], Syy = M[4], Syz = M[5], Szx = M[6], Szy = M[7], Szz = M[8]
  // Hornova symetrická 4×4 N; její největší vlastní vektor = rotační kvaternion
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]
  const { values, vectors } = jacobiEig(N, 4)
  let mi = 0
  for (let i = 1; i < 4; i++) if (values[i] > values[mi]) mi = i
  const q = [vectors[0][mi], vectors[1][mi], vectors[2][mi], vectors[3][mi]]
  const R = quatToR(q)
  // měřítko: c = Σ q'·(R p') / Σ|p'|²  (projekce s už známou rotací)
  let num = 0
  for (let i = 0; i < n; i++) {
    const p: V3 = [src[i][0] - mp[0], src[i][1] - mp[1], src[i][2] - mp[2]]
    const q2: V3 = [dst[i][0] - mq[0], dst[i][1] - mq[1], dst[i][2] - mq[2]]
    const Rp = mulR(R, p)
    num += q2[0] * Rp[0] + q2[1] * Rp[1] + q2[2] * Rp[2]
  }
  const c = num / (varP * n)
  // t = mq - c·R·mp
  const Rmp = mulR(R, mp)
  const t: V3 = [mq[0] - c * Rmp[0], mq[1] - c * Rmp[1], mq[2] - c * Rmp[2]]
  // zbytková odchylka
  let sse = 0
  for (let i = 0; i < n; i++) {
    const Rp = mulR(R, src[i])
    const pred: V3 = [c * Rp[0] + t[0], c * Rp[1] + t[1], c * Rp[2] + t[2]]
    sse += (pred[0] - dst[i][0]) ** 2 + (pred[1] - dst[i][1]) ** 2 + (pred[2] - dst[i][2]) ** 2
  }
  return { c, R, t, rms: Math.sqrt(sse / n) }
}
