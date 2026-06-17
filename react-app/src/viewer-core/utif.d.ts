declare module 'utif' {
  export interface UtifIFD {
    width: number
    height: number
    [key: string]: unknown
  }
  const UTIF: {
    decode(buffer: ArrayBuffer | Uint8Array): UtifIFD[]
    decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: UtifIFD): void
    toRGBA8(ifd: UtifIFD): Uint8Array
  }
  export default UTIF
}
