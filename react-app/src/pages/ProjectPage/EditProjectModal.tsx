import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { Project, Profile } from '@/lib/types'
import { inputClass } from './shared'

export function EditProjectModal({ project, allProfiles, onClose, onSaved }: {
  project: Project; members: Profile[]; allProfiles: Profile[]
  onClose: () => void; onSaved: () => void
}) {
  const [name,      setName]      = useState(project.name)
  const [desc,      setDesc]      = useState(project.description ?? '')
  const [dueDate,   setDueDate]   = useState(project.due_date ?? '')
  const [filePath,  setFilePath]  = useState(project.file_path ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(allProfiles.map(m => m.id))
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('*').order('name')
      return (data || []) as Profile[]
    },
  })

  async function handleSave() {
    if (!name.trim()) { setError('Název nesmí být prázdný.'); return }
    setLoading(true); setError('')
    const { error: projErr } = await supabase.from('projects').update({
      name: name.trim(), description: desc.trim() || null, due_date: dueDate || null,
      file_path: filePath.trim() || null,
    }).eq('id', project.id)
    if (projErr) { setError(projErr.message); setLoading(false); return }

    await supabase.from('project_members').delete().eq('project_id', project.id)
    if (memberIds.length > 0) {
      await supabase.from('project_members').insert(memberIds.map(uid => ({ project_id: project.id, user_id: uid })))
    }
    toast.success('Projekt uložen.')
    onSaved()
  }

  return (
    <Modal open title="Upravit projekt" onClose={onClose} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Název *</label>
          <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Popis</label>
          <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} className={`${inputClass} resize-none`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Termín</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cesta k souboru</label>
            <input value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share" className={inputClass} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Členové</label>
          <div className="flex flex-wrap gap-2">
            {profiles.map(p => {
              const checked = memberIds.includes(p.id)
              return (
                <label key={p.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  <input type="checkbox" className="sr-only" checked={checked} onChange={() => setMemberIds(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])} />
                  <Avatar name={p.name} initials={p.initials} color={p.color} small />
                  {p.name}
                </label>
              )
            })}
          </div>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button variant="primary" loading={loading} onClick={handleSave}>Uložit změny</Button>
        </div>
      </div>
    </Modal>
  )
}
