import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { PageLayout } from '@/components/layout/PageLayout'
import { setBgModel } from '@/components/layout/BackgroundScene'
import { Upload, X, Box, Trash2, FolderOpen, Monitor, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelFile } from '@/lib/types'
import { Viewer } from '@/viewer-core'
import type { ViewerAnnotation } from '@/viewer-core'
import { BUCKET } from './shared'
import { makeSupabaseViewerAdapter } from './viewerAdapter'
import { TaskFromAnnotationModal } from './TaskFromAnnotationModal'

function ModelThumb({ modelId, thumbnailPath }: { modelId: string; thumbnailPath: string }) {
  const [v, setV] = useState(() => localStorage.getItem(`thumb_v_${modelId}`) ?? '')
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<string>).detail === modelId)
        setV(localStorage.getItem(`thumb_v_${modelId}`) ?? Date.now().toString())
    }
    window.addEventListener('thumb-updated', handler)
    return () => window.removeEventListener('thumb-updated', handler)
  }, [modelId])
  const base = supabase.storage.from(BUCKET).getPublicUrl(thumbnailPath).data.publicUrl
  return <img src={v ? `${base}?v=${v}` : base} alt="" className="w-full h-full object-cover" />
}

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function generateThumbnail(file: File): Promise<Blob> {
  const W = 480, H = 320
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(W, H)
  renderer.setPixelRatio(1)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#111827')

  const ambient = new THREE.AmbientLight(0xffffff, 0.7)
  scene.add(ambient)
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
  dirLight.position.set(5, 10, 7)
  scene.add(dirLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
  fillLight.position.set(-5, -3, -5)
  scene.add(fillLight)

  const camera = new THREE.PerspectiveCamera(45, W / H, 0.001, 10000)

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const loader = new GLTFLoader()
    loader.load(url, (gltf) => {
      scene.add(gltf.scene)
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.6
      camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist)
      camera.lookAt(center)
      camera.near = dist / 100
      camera.far = dist * 10
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url)
        renderer.dispose()
        if (blob) resolve(blob)
        else reject(new Error('canvas.toBlob failed'))
      }, 'image/jpeg', 0.88)
    }, undefined, (err) => {
      URL.revokeObjectURL(url)
      renderer.dispose()
      reject(err)
    })
  })
}

export function ModelsPage() {
  const { profile } = useAuthStore()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [searchParams] = useSearchParams()
  const viewerAdapter = useMemo(() => makeSupabaseViewerAdapter(qc), [qc])

  const [viewerModel, setViewerModel] = useState<{ model: ModelFile; url: string } | null>(null)
  const [focusAnnotationPos, setFocusAnnotationPos] = useState<THREE.Vector3 | null>(null)
  const [taskFromAnnotation, setTaskFromAnnotation] = useState<ViewerAnnotation | null>(null)
  const [bgModelId, setBgModelId]         = useState(() => localStorage.getItem('bg_model_id') ?? '')
  const [uploadOpen, setUploadOpen]       = useState(false)
  const [uploading, setUploading]         = useState(false)
  const [uploadName, setUploadName]       = useState('')
  const [uploadDesc, setUploadDesc]       = useState('')
  const [uploadFile, setUploadFile]       = useState<File | null>(null)
  const [assigningModelId, setAssigningModelId] = useState<string | null>(null)
  const [uploadProjectId, setUploadProjectId]   = useState('')
  const [reuploadingId, setReuploadingId]       = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const reuploadRef = useRef<HTMLInputElement>(null)

  const { data: projects = [] } = useQuery({
    queryKey: ['projects_list_for_models'],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name').order('name')
      return (data ?? []) as { id: string; name: string }[]
    },
  })

  const { data: models = [], isLoading } = useQuery({
    queryKey: ['model_files'],
    queryFn: async () => {
      const { data, error } = await supabase.from('model_files').select('*').order('created_at', { ascending: false })
      if (error) throw error
      return data as ModelFile[]
    },
  })

  function openViewer(model: ModelFile) {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(model.file_path)
    setViewerModel({ model, url: data.publicUrl })
  }

  async function handleAssignProject(modelId: string, projectId: string | null) {
    const { error } = await supabase.from('model_files').update({ project_id: projectId }).eq('id', modelId)
    if (error) { toast.error('Chyba: ' + error.message); return }
    qc.invalidateQueries({ queryKey: ['model_files'] })
    setAssigningModelId(null)
    toast.success(projectId ? 'Model přiřazen k projektu' : 'Model odebrán z projektu')
  }

  const modelGroups = useMemo(() => {
    const groups: { projectId: string | null; name: string; models: ModelFile[] }[] = []
    const projectsWithModels = projects.filter(p => models.some(m => m.project_id === p.id))
    for (const p of projectsWithModels) {
      groups.push({ projectId: p.id, name: p.name, models: models.filter(m => m.project_id === p.id) })
    }
    const unassigned = models.filter(m => !m.project_id)
    if (unassigned.length > 0 || groups.length === 0) {
      groups.push({ projectId: null, name: 'Bez projektu', models: unassigned })
    }
    return groups
  }, [models, projects])

  // auto-otevření z odkazu (?model=&annotation=) jen JEDNOU — jinak by invalidace
  // model_files (např. uložení kamery při zavření) viewer hned zase otevřela
  const didDeepLink = useRef(false)
  useEffect(() => {
    if (didDeepLink.current) return
    const modelParam      = searchParams.get('model')
    const annotationParam = searchParams.get('annotation')
    if (!modelParam || models.length === 0) return
    const found = models.find(m => m.id === modelParam)
    if (!found) return
    didDeepLink.current = true
    openViewer(found)
    if (annotationParam) {
      supabase.from('model_annotations').select('x, y, z').eq('id', annotationParam).maybeSingle()
        .then(({ data }) => {
          if (data) setFocusAnnotationPos(new THREE.Vector3(data.x, data.y, data.z))
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  function handleFileSelect(f: File) {
    setUploadFile(f)
    if (!uploadName) setUploadName(f.name.replace(/\.(glb|gltf)$/i, ''))
  }

  async function handleUpload() {
    if (!uploadFile || !uploadName || !profile) return
    setUploading(true)
    try {
      const base = `${Date.now()}_${uploadName.replace(/\s+/g, '_')}`
      const ext = uploadFile.name.split('.').pop() ?? 'glb'
      const path = `${base}.${ext}`

      const { error: storageErr } = await supabase.storage.from(BUCKET).upload(path, uploadFile)
      if (storageErr) throw storageErr

      let thumbnailPath: string | null = null
      try {
        const thumbBlob = await generateThumbnail(uploadFile)
        const thumbPath = `thumbs/${base}.jpg`
        const { error: thumbErr } = await supabase.storage.from(BUCKET).upload(thumbPath, thumbBlob, { contentType: 'image/jpeg' })
        if (!thumbErr) thumbnailPath = thumbPath
      } catch {
        // thumbnail is optional
      }

      const { error: dbErr } = await supabase.from('model_files').insert({
        name: uploadName,
        description: uploadDesc || null,
        file_path: path,
        thumbnail_path: thumbnailPath,
        file_size: uploadFile.size,
        project_id: uploadProjectId || null,
        created_by: profile.id,
      })
      if (dbErr) throw dbErr

      qc.invalidateQueries({ queryKey: ['model_files'] })
      toast.success('Model nahrán')
      setUploadOpen(false)
      setUploadFile(null)
      setUploadName('')
      setUploadDesc('')
      setUploadProjectId('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Chyba při nahrávání')
    } finally {
      setUploading(false)
    }
  }

  async function handleReupload(model: ModelFile, file: File) {
    setReuploadingId(model.id)
    try {
      const base = `${Date.now()}_${model.name.replace(/\s+/g, '_')}`
      const ext = file.name.split('.').pop() ?? 'glb'
      const newPath = `${base}.${ext}`

      const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(newPath, file)
      if (uploadErr) throw uploadErr

      let thumbnailPath: string | null = model.thumbnail_path ?? null
      try {
        const thumbBlob = await generateThumbnail(file)
        const thumbPath = `thumbs/${base}.jpg`
        const { error: thumbErr } = await supabase.storage.from(BUCKET).upload(thumbPath, thumbBlob, { contentType: 'image/jpeg' })
        if (!thumbErr) {
          if (model.thumbnail_path) await supabase.storage.from(BUCKET).remove([model.thumbnail_path])
          thumbnailPath = thumbPath
          localStorage.setItem(`thumb_v_${model.id}`, Date.now().toString())
        }
      } catch { /* thumbnail optional */ }

      const { error: dbErr } = await supabase.from('model_files').update({
        file_path: newPath,
        file_size: file.size,
        thumbnail_path: thumbnailPath,
      }).eq('id', model.id)
      if (dbErr) throw dbErr

      await supabase.storage.from(BUCKET).remove([model.file_path])

      qc.invalidateQueries({ queryKey: ['model_files'] })
      toast.success('Model aktualizován — anotace a vegetace zůstaly zachovány')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Chyba při nahrávání')
    } finally {
      setReuploadingId(null)
    }
  }

  async function handleDelete(model: ModelFile) {
    if (!await confirm({ title: 'Smazat model', message: `Opravdu smazat model „${model.name}"? Tato akce je nevratná.`, confirmLabel: 'Smazat', variant: 'danger' })) return
    const filesToRemove = [model.file_path, ...(model.thumbnail_path ? [model.thumbnail_path] : [])]
    const { error: storageErr } = await supabase.storage.from(BUCKET).remove(filesToRemove)
    if (storageErr) { toast.error('Chyba při mazání souboru: ' + storageErr.message); return }
    const { error: dbErr } = await supabase.from('model_files').delete().eq('id', model.id)
    if (dbErr) { toast.error('Chyba při mazání záznamu: ' + dbErr.message); return }
    qc.invalidateQueries({ queryKey: ['model_files'] })
    toast.success('Model smazán')
  }

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">3D Modely</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Prohlížeč modelů mostů a konstrukcí</p>
          </div>
          {profile && (
            <button
              onClick={() => setUploadOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Upload size={15} /> Nahrát model
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-28 text-gray-400 dark:text-gray-500">
            <Box size={44} className="mx-auto mb-3 opacity-25" />
            <p className="text-sm">Zatím žádné modely</p>
            {profile && (
              <button onClick={() => setUploadOpen(true)} className="mt-3 text-sm text-indigo-500 hover:text-indigo-600">
                Nahrát první model
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {modelGroups.map(group => (
              <div key={group.projectId ?? '__none__'}>
                {modelGroups.length > 1 && (
                  <div className="flex items-center gap-2 mb-3">
                    <FolderOpen size={15} className="text-indigo-400 shrink-0" />
                    <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{group.name}</h2>
                    <span className="text-xs text-gray-400">({group.models.length})</span>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {group.models.map(model => (
                    <div
                      key={model.id}
                      onClick={() => { if (assigningModelId !== model.id) openViewer(model) }}
                      className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-lg transition-all"
                    >
                      <div className="h-40 bg-linear-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center overflow-hidden">
                        {model.thumbnail_path ? (
                          <ModelThumb modelId={model.id} thumbnailPath={model.thumbnail_path} />
                        ) : (
                          <Box size={48} className="text-gray-300 dark:text-gray-700 group-hover:text-indigo-400 dark:group-hover:text-indigo-500 transition-colors" />
                        )}
                      </div>
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{model.name}</p>
                            {model.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{model.description}</p>}
                            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1.5">
                              {[formatSize(model.file_size), new Date(model.created_at).toLocaleDateString('cs-CZ')].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={e => { e.stopPropagation(); setBgModel(model.id); setBgModelId(model.id); toast.success('Nastaveno jako pozadí') }}
                              title="Nastavit jako pozadí aplikace"
                              className={`p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 ${bgModelId === model.id ? 'text-indigo-500 dark:text-indigo-400 opacity-100' : 'text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'}`}>
                              <Monitor size={14} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); setAssigningModelId(assigningModelId === model.id ? null : model.id) }}
                              title="Přiřadit k projektu"
                              className={`p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 ${model.project_id ? 'text-indigo-500 dark:text-indigo-400 opacity-100' : 'text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'}`}>
                              <FolderOpen size={14} />
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); reuploadRef.current?.setAttribute('data-model-id', model.id); reuploadRef.current?.click() }}
                              title="Přenahrát model (zachová anotace a vegetaci)"
                              disabled={reuploadingId === model.id}
                              className="p-1.5 rounded-md text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50">
                              <RefreshCw size={14} className={reuploadingId === model.id ? 'animate-spin' : ''} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); handleDelete(model) }}
                              className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {assigningModelId === model.id && (
                          <div className="mt-2" onClick={e => e.stopPropagation()}>
                            <select
                              defaultValue={model.project_id ?? ''}
                              onChange={e => handleAssignProject(model.id, e.target.value || null)}
                              autoFocus
                              className="w-full px-2 py-1.5 text-xs rounded-md border border-indigo-300 dark:border-indigo-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            >
                              <option value="">— bez projektu —</option>
                              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Nahrát 3D model</h2>
              <button onClick={() => setUploadOpen(false)} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X size={16} />
              </button>
            </div>
            <div
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${uploadFile ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-300 dark:border-gray-700 hover:border-indigo-400 dark:hover:border-indigo-600'}`}
            >
              <input ref={fileRef} type="file" accept=".glb,.gltf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }} />
              <Upload size={24} className="mx-auto mb-2 text-gray-400" />
              {uploadFile ? (
                <p className="text-sm text-indigo-600 dark:text-indigo-400 font-medium">{uploadFile.name}</p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Klikni nebo přetáhni soubor <strong>.glb</strong> nebo <strong>.gltf</strong>
                </p>
              )}
            </div>
            <input value={uploadName} onChange={e => setUploadName(e.target.value)} placeholder="Název modelu"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <textarea value={uploadDesc} onChange={e => setUploadDesc(e.target.value)} placeholder="Popis (volitelné)" rows={2}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
            <select value={uploadProjectId} onChange={e => setUploadProjectId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">— bez projektu —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={handleUpload} disabled={!uploadFile || !uploadName || uploading}
              className="w-full py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {uploading ? 'Nahrávám…' : 'Nahrát'}
            </button>
          </div>
        </div>
      )}

      <input
        ref={reuploadRef}
        type="file"
        accept=".glb,.gltf"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0]
          const modelId = reuploadRef.current?.getAttribute('data-model-id')
          if (!file || !modelId) return
          const model = models.find(m => m.id === modelId)
          if (model) handleReupload(model, file)
          e.target.value = ''
        }}
      />

      {viewerModel && (
        <Viewer
          url={viewerModel.url}
          name={viewerModel.model.name}
          modelId={viewerModel.model.id}
          adapter={viewerAdapter}
          canEdit={!!profile}
          confirm={confirm}
          onClose={() => { setViewerModel(null); setFocusAnnotationPos(null) }}
          focusAnnotationPos={focusAnnotationPos}
          initialCameraState={viewerModel.model.camera_state ?? null}
          onCreateTask={profile ? setTaskFromAnnotation : undefined}
        />
      )}

      {viewerModel && (
        <TaskFromAnnotationModal
          open={!!taskFromAnnotation}
          onClose={() => setTaskFromAnnotation(null)}
          annotation={taskFromAnnotation}
          model={viewerModel.model}
          projects={projects}
          onCreated={() => qc.invalidateQueries({ queryKey: ['tasks'] })}
        />
      )}
    </PageLayout>
  )
}
