import type { VegGroup } from './Vegetation'
import type { CameraState, CameraSaveResult } from './shared'

export interface ViewerAnnotation {
  id: string
  x: number
  y: number
  z: number
  text: string
  object_name: string | null
  /** posun textového boxu vůči ukotvení (tečce) ve screen px; tečka zůstává na 3D bodě */
  offsetX?: number
  offsetY?: number
  /** další ukotvené body v 3D — z boxu vede do každého z nich spojnice s tečkou */
  extraPoints?: { x: number; y: number; z: number }[]
  /** vlastní barva anotace (box + spojnice s tečkou); prázdné = výchozí indigo */
  color?: string | null
}

export interface NewAnnotation {
  x: number
  y: number
  z: number
  text: string
  object_name: string | null
}

export interface ObjectColorRecord {
  object_name: string
  color: string
}

/** Uživatelská vrstva v panelu Objekty — členové jsou jména uzlů modelu. */
export interface SceneLayer {
  id: string
  name: string
  members: string[]
}

export interface ViewerSettings {
  env?: 'studio' | 'sun'
  /** venkovní HDRI obloha: ráno / odpoledne / večer */
  skyPreset?: 'morning' | 'afternoon' | 'evening'
  /** otočení HDRI oblohy kolem svislé osy, ve stupních */
  skyRotation?: number
  ground?: boolean
  /** Výškový posun terénu, -1..1 (zlomek velikosti modelu). */
  groundY?: number
  /** bloom efekt (AO běží vždy) */
  fx?: boolean
  toneMapping?: 'agx' | 'aces' | 'neutral'
  exposure?: number
  /** měkkost stínů (PCSS size), 0 = jen PCF soft */
  shadowSoftness?: number
}

export type TextureMapType = 'albedo' | 'normal' | 'roughness' | 'metalness' | 'ao' | 'emissive' | 'opacity' | 'height'

/** PBR materiál v globální knihovně. `maps` mapuje typ mapy na cestu v úložišti. */
export interface MaterialDef {
  id: string
  name: string
  /** hex barva násobící albedo */
  tint: string
  roughness: number
  metalness: number
  /** síla normal mapy (normalScale), default 1 */
  normalStrength?: number
  /** síla height/bump mapy (bumpScale), default 1 */
  heightStrength?: number
  /** procedurální grunge 0–1 — world-space šum rozbíjející opakování textury */
  grunge?: number
  /** velikost grunge skvrn v metrech, default 8 */
  grungeScale?: number
  maps: Partial<Record<TextureMapType, string>>
}

/** Přiřazení materiálu na objekt (per model, ukládá se v SceneOrg). */
export interface MaterialAssignment {
  materialId: string
  /** velikost jedné dlaždice textury v metrech (world scale UV) */
  tileSize: number
  /** rotace UV ve stupních */
  rotation: number
  offsetX: number
  offsetY: number
}

/** Organizace scény: přejmenování objektů, vrstvy, materiály a nastavení prostředí. */
export interface SceneOrg {
  renames: Record<string, string>
  layers: SceneLayer[]
  settings?: ViewerSettings
  materials?: Record<string, MaterialAssignment>
}

export interface SavedView {
  id: string
  name: string
  camera: CameraState
  /** id anotací přiřazených tomuto pohledu — v prezentaci naskáčou po příletu kamery */
  annotationIds?: string[]
}

/**
 * Persistence vrstvy vieweru. Hlavní appka ji implementuje přes Supabase,
 * 3d-lab přes localStorage — jádro vieweru o úložišti nic neví.
 */
export interface ViewerAdapter {
  fetchObjectColors(modelId: string): Promise<ObjectColorRecord[]>
  saveObjectColor(modelId: string, objectName: string, color: string): Promise<void>
  fetchVegetation(modelId: string): Promise<VegGroup[] | null>
  saveVegetation(modelId: string, groups: VegGroup[]): Promise<void>
  fetchAnnotations(modelId: string): Promise<ViewerAnnotation[]>
  createAnnotation(modelId: string, annotation: NewAnnotation): Promise<void>
  deleteAnnotation(modelId: string, id: string): Promise<void>
  /** Uloží posun textového boxu anotace (drag na obrazovce). */
  updateAnnotationOffset(modelId: string, id: string, offsetX: number, offsetY: number): Promise<void>
  /** Uloží seznam dalších ukotvených bodů anotace (víc spojnic z jednoho boxu). */
  updateAnnotationPoints(modelId: string, id: string, points: { x: number; y: number; z: number }[]): Promise<void>
  /** Uloží vlastní barvu anotace (null = výchozí). */
  updateAnnotationColor(modelId: string, id: string, color: string | null): Promise<void>
  fetchSceneOrg(modelId: string): Promise<SceneOrg | null>
  saveSceneOrg(modelId: string, org: SceneOrg): Promise<void>
  fetchViews(modelId: string): Promise<SavedView[]>
  createView(modelId: string, view: SavedView): Promise<void>
  deleteView(modelId: string, viewId: string): Promise<void>
  renameView(modelId: string, viewId: string, name: string): Promise<void>
  /** Přepíše uloženou kameru pohledu aktuálním záběrem. */
  updateViewCamera(modelId: string, viewId: string, camera: CameraState): Promise<void>
  /** Uloží nové pořadí pohledů — `orderedIds` v cílovém pořadí. */
  reorderViews(modelId: string, orderedIds: string[]): Promise<void>
  /** Přiřadí pohledu seznam anotací (pro prezentaci). */
  updateViewAnnotations(modelId: string, viewId: string, annotationIds: string[]): Promise<void>
  /** Globální knihovna PBR materiálů. */
  fetchMaterials(): Promise<MaterialDef[]>
  saveMaterial(material: MaterialDef): Promise<void>
  deleteMaterial(materialId: string): Promise<void>
  /** Uloží zpracovanou texturu (už zkonvertovanou viewerem) a vrátí cestu pro getTextureUrl. */
  uploadTexture(materialId: string, mapType: TextureMapType, data: Blob, ext: string): Promise<string>
  getTextureUrl(path: string): Promise<string>
  /** Po zavření vieweru — uložená pozice kamery + snímek plátna (thumbnail). */
  onViewerClosed?(modelId: string, result: CameraSaveResult): void
}

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'default'
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
