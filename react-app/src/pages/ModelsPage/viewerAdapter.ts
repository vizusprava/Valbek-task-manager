import type { QueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { signedUrl } from '@/lib/storage'
import { useAuthStore } from '@/stores/authStore'
import type { ModelObjectColor } from '@/lib/types'
import type { ViewerAdapter, VegGroup, SceneOrg, CameraState, MaterialDef } from '@/viewer-core'
import { BUCKET } from './shared'

// Supabase implementace persistence vieweru (3d-lab používá localStorage variantu).
export function makeSupabaseViewerAdapter(queryClient: QueryClient): ViewerAdapter {
  return {
    async fetchObjectColors(modelId) {
      const { data, error } = await supabase.from('model_object_colors').select('*').eq('model_id', modelId)
      if (error) throw error
      return data as ModelObjectColor[]
    },

    async saveObjectColor(modelId, objectName, color) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      const { error } = await supabase.from('model_object_colors').upsert(
        { model_id: modelId, object_name: objectName, color, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'model_id,object_name' }
      )
      if (error) throw error
    },

    async fetchVegetation(modelId) {
      const { data } = await supabase.from('model_vegetation').select('data').eq('model_id', modelId).order('updated_at', { ascending: false }).limit(1).maybeSingle()
      return (data?.data ?? null) as VegGroup[] | null
    },

    async saveVegetation(modelId, groups) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      const { error } = await supabase.from('model_vegetation').upsert(
        { model_id: modelId, data: groups, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'model_id' }
      )
      if (error) throw error
    },

    async fetchAnnotations(modelId) {
      const { data, error } = await supabase.from('model_annotations').select('*').eq('model_id', modelId).order('created_at')
      if (error) throw error
      return (data ?? []).map(r => ({
        id: r.id, x: r.x, y: r.y, z: r.z, text: r.text, object_name: r.object_name,
        offsetX: (r.offset_x as number | null) ?? 0, offsetY: (r.offset_y as number | null) ?? 0,
        extraPoints: (r.extra_points as { x: number; y: number; z: number }[] | null) ?? [],
        color: (r.color as string | null) ?? null,
      }))
    },

    async createAnnotation(modelId, annotation) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      const { error } = await supabase.from('model_annotations').insert({
        model_id: modelId, x: annotation.x, y: annotation.y, z: annotation.z,
        text: annotation.text, object_name: annotation.object_name, created_by: profile.id,
      })
      if (error) throw error
    },

    async deleteAnnotation(_modelId, id) {
      const { error } = await supabase.from('model_annotations').delete().eq('id', id)
      if (error) throw error
    },

    async updateAnnotationOffset(_modelId, id, offsetX, offsetY) {
      const { error } = await supabase.from('model_annotations').update({ offset_x: offsetX, offset_y: offsetY }).eq('id', id)
      if (error) throw error
    },

    async updateAnnotationPoints(_modelId, id, points) {
      const { error } = await supabase.from('model_annotations').update({ extra_points: points }).eq('id', id)
      if (error) throw error
    },

    async updateAnnotationColor(_modelId, id, color) {
      const { error } = await supabase.from('model_annotations').update({ color }).eq('id', id)
      if (error) throw error
    },

    async fetchSceneOrg(modelId) {
      const { data, error } = await supabase.from('model_scene_org').select('data').eq('model_id', modelId).maybeSingle()
      // tabulka nemusí existovat před spuštěním migrace — viewer pak jede bez organizace scény
      if (error) { console.warn('model_scene_org:', error.message); return null }
      return (data?.data ?? null) as SceneOrg | null
    },

    async saveSceneOrg(modelId, org) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      const { error } = await supabase.from('model_scene_org').upsert(
        { model_id: modelId, data: org, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'model_id' }
      )
      if (error) throw error
    },

    async fetchViews(modelId) {
      const mapRows = (rows: Record<string, unknown>[]) =>
        rows.map(row => ({ id: row.id as string, name: row.name as string, camera: row.camera as CameraState, annotationIds: (row.annotation_ids as string[] | null) ?? [] }))
      const { data, error } = await supabase.from('model_views').select('*').eq('model_id', modelId)
        .order('sort_order', { nullsFirst: false }).order('created_at')
      if (error) {
        // sloupec sort_order chybí (před migrací 004) — fallback na created_at
        const fb = await supabase.from('model_views').select('*').eq('model_id', modelId).order('created_at')
        if (fb.error) { console.warn('model_views:', fb.error.message); return [] }
        return mapRows(fb.data ?? [])
      }
      return mapRows(data ?? [])
    },

    async createView(modelId, view) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      // sort_order ve velkém měřítku → nový pohled jde vždy na konec; reorder pak přepíše na 0..n
      const { error } = await supabase.from('model_views').insert({
        id: view.id, model_id: modelId, name: view.name, camera: view.camera, created_by: profile.id, sort_order: Date.now(), annotation_ids: view.annotationIds ?? [],
      })
      if (error) throw error
    },

    async deleteView(_modelId, viewId) {
      const { error } = await supabase.from('model_views').delete().eq('id', viewId)
      if (error) throw error
    },

    async updateViewAnnotations(_modelId, viewId, annotationIds) {
      const { error } = await supabase.from('model_views').update({ annotation_ids: annotationIds }).eq('id', viewId)
      if (error) throw error
    },

    async renameView(_modelId, viewId, name) {
      const { error } = await supabase.from('model_views').update({ name }).eq('id', viewId)
      if (error) throw error
    },

    async updateViewCamera(_modelId, viewId, camera) {
      const { error } = await supabase.from('model_views').update({ camera }).eq('id', viewId)
      if (error) throw error
    },

    async reorderViews(_modelId, orderedIds) {
      const results = await Promise.all(
        orderedIds.map((id, i) => supabase.from('model_views').update({ sort_order: i }).eq('id', id))
      )
      const failed = results.find(r => r.error)
      if (failed?.error) throw failed.error
    },

    async fetchMaterials() {
      const { data, error } = await supabase.from('viewer_materials').select('*').order('updated_at')
      if (error) { console.warn('viewer_materials:', error.message); return [] }
      return (data ?? []).map(row => ({ ...(row.data as MaterialDef), id: row.id as string }))
    },

    async saveMaterial(material) {
      const profile = useAuthStore.getState().profile
      if (!profile) return
      const { error } = await supabase.from('viewer_materials').upsert(
        { id: material.id, data: material, updated_by: profile.id, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      )
      if (error) throw error
    },

    async deleteMaterial(materialId) {
      const { data: files } = await supabase.storage.from(BUCKET).list(`textures/${materialId}`)
      if (files?.length) await supabase.storage.from(BUCKET).remove(files.map(f => `textures/${materialId}/${f.name}`))
      const { error } = await supabase.from('viewer_materials').delete().eq('id', materialId)
      if (error) throw error
    },

    async uploadTexture(materialId, mapType, data, ext) {
      const path = `textures/${materialId}/${mapType}_${Date.now()}.${ext}`
      const { error } = await supabase.storage.from(BUCKET).upload(path, data, {
        contentType: data.type || 'application/octet-stream',
      })
      if (error) throw error
      return path
    },

    async getTextureUrl(path) {
      return (await signedUrl(BUCKET, path)) ?? ''
    },

    onViewerClosed(modelId, { canvas, cameraState }) {
      supabase.from('model_files').update({ camera_state: cameraState }).eq('id', modelId).then(() => {
        queryClient.invalidateQueries({ queryKey: ['model_files'] })
      })
      canvas.toBlob(async (blob) => {
        if (!blob || blob.size < 1000) return
        const path = `thumbs/cam_${modelId}.jpg`
        await supabase.storage.from(BUCKET).remove([path])
        const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
        if (error) return
        await supabase.from('model_files').update({ thumbnail_path: path }).eq('id', modelId)
        const ts = Date.now().toString()
        localStorage.setItem(`thumb_v_${modelId}`, ts)
        window.dispatchEvent(new CustomEvent('thumb-updated', { detail: modelId }))
        queryClient.invalidateQueries({ queryKey: ['model_files'] })
      }, 'image/jpeg', 0.88)
    },
  }
}
