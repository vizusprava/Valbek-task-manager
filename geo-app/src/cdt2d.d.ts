declare module 'cdt2d' {
  /** Constrained Delaunay triangulation. Vrací trojúhelníky jako indexy do `points`. */
  export default function cdt2d(
    points: number[][],
    edges?: number[][],
    options?: { delaunay?: boolean; interior?: boolean; exterior?: boolean; infinity?: boolean },
  ): number[][]
}
