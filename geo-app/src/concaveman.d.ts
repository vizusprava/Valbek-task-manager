declare module 'concaveman' {
  /** Konkávní obal 2D bodů. concavity: menší = detailnější (výchozí 2). lengthThreshold: zálivy kratší než tohle vyhladí. Vrací uzavřený prstenec [[x,y],…]. */
  export default function concaveman(points: number[][], concavity?: number, lengthThreshold?: number): number[][]
}
