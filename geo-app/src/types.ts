/**
 * Sdílené datové typy scény — model, parcela, výkres, uložený pohled.
 *
 * Typy sedí zvlášť, aby si je mohly natáhnout i moduly, které spolu jinak nemají co dělat
 * (export, měření, panel). Jsou to čistě popisy tvaru dat, žádná logika → nikdy nevznikne cyklus.
 */
import * as Cesium from 'cesium'

export type Base = 'ortofoto' | 'zm' | 'google'

// kotva modelu: zeměpisná poloha + výška nad terénem + natočení (heading/pitch/roll) + měřítko
export type Placement = { lon: number; lat: number; groundH: number; heightOffset: number; heading: number; pitch: number; roll: number; scale: number }
// uložený pohled kamery: ECEF pozice + heading/pitch/roll (radiány)
// Vzhled uložený spolu s pohledem — zorný úhel a rozostření, aby každý pohled mohl vypadat jinak.
// Pohybové efekty (`shake*`, `spin*`) jsou NEPOVINNÉ: pohledy uložené dřív je nemají a chybějící
// hodnota znamená VYPNUTO — nikdy se tedy nezapnou samy, uživatel si je dá jen tam, kam chce.
export type CamLook = {
  fov: number; bloom: boolean
  dofOn: boolean; dofMode: 'dist' | 'circle'; dofFocal: number; dofBlur: number; dofRadius: number; dofFeather: number
  shakeOn?: boolean; shakeAmt?: number
  /** kroužení kolem místa, na které se pohled dívá; `spinSpeed` je °/s a ZNAMÉNKO určuje směr */
  spinOn?: boolean; spinSpeed?: number
}
// `look` je NEPOVINNÝ schválně: pohledy uložené dřív ho v localStorage nemají a musí se dál načíst.
// Když chybí, přelet nechá aktuální nastavení být (viz gotoCamView).
export type CamView = { id: string; name: string; dest: [number, number, number]; h: number; p: number; r: number; look?: CamLook }

export type GroundHit = { lon: number; lat: number; height: number }
// `holes` = vykrojené parcely uvnitř (typicky stavební parcela v zahradě). Bez jejich
// odečtení vychází výměra pozemku větší, než má katastr — proto je vedeme zvlášť.
// `label` = číslo parcely z KN („354“), `knArea` = výměra zapsaná v KN (0 = neznámá).
export type Parcel = { id: string; label?: string; knArea?: number; positions: Cesium.Cartesian3[]; holes?: Cesium.Cartesian3[][] }
export type Anchor = { lon: number; lat: number; h: number }

// jeden importovaný model ve scéně
export type ModelEntry = {
  id: string
  name: string
  model: Cesium.Model
  url: string
  center: Cesium.Cartesian3
  yawDeg: number
  placement: Placement
  visible: boolean
  footprint?: Cesium.Cartesian3[][] // obrys(y) půdorysu ve světě (S-JTSK přes kotvu) pro skrytí mapy
  excavate?: boolean                // skrýt mapu (ortofoto/topo + terén + Google) pod/nad modelem
  outline?: boolean                 // svítící obrys (silhouette) kolem modelu; výchozí vypnuto
}
// položka panelu Scéna
export type SceneObj = { id: string; kind: 'model' | 'parcel' | 'surface' | 'drawing'; name: string; visible: boolean }
// jedna hladina výkresu — vlastní Cesium primitivy, aby šla samostatně zapnout/vypnout
// `labels` = texty jako geometrie v rovině výkresu (viz dxfText.ts), jeden Primitive na barvu
export type DrawLayer = { name: string; color: number; visible: boolean; prim: Cesium.Primitive | null; labels: Cesium.Primitive[]; points: Cesium.PointPrimitiveCollection | null }
// `up` = svislý směr ve středu výkresu (pro posun výšky přes modelMatrix). *Refs = odkazy na prvky
// + jejich základní barvy (pro živé nastavení průhlednosti celého výkresu).
export type DrawingEntry = {
  layers: DrawLayer[]; bounds: Cesium.Rectangle | null; up: Cesium.Cartesian3
  textMats: Cesium.Material[]
  pointRefs: { p: Cesium.PointPrimitive; c: Cesium.Color }[]
  polyRefs: { prim: Cesium.Primitive; id: string; c: Cesium.Color }[]
}
