/**
 * DWG → DXF přes LibreDWG (WASM), pak stejná cesta jako DXF (dxfToPrims).
 *
 * WASM se v prohlížeči načítá automaticky (Vite ho zabalí jako asset). Import je líný (volá se
 * jen z loadDrawing při .dwg), takže dokud uživatel DWG nenahraje, nula dopadu na velikost/výkon.
 *
 * POZOR: LibreDWG a jeho WASM wrapper jsou GPL (copyleft) — pro interní nástroj OK.
 */
import { LibreDwg } from '@mlightcad/libredwg-web'
import { dxfToPrims, type DrawParse } from './dxf'

let libP: ReturnType<typeof LibreDwg.create> | null = null

export async function dwgToPrims(buf: ArrayBuffer): Promise<DrawParse> {
  if (!libP) libP = LibreDwg.create() // v prohlížeči si WASM najde sám
  const lib = await libP
  const dxf = lib.dwg_write_dxf(buf)
  if (!dxf) throw new Error('DWG se nepodařilo převést (poškozený soubor nebo nepodporovaná verze)')
  const text = typeof dxf === 'string' ? dxf : new TextDecoder('utf-8').decode(dxf)
  return dxfToPrims(text)
}
