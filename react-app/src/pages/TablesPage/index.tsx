import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Table2, Trash2, ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { PageLayout } from '@/components/layout/PageLayout'
import { formatDate } from '@/lib/utils'
import type { Spreadsheet } from '@/lib/types'
import { SpreadsheetEditor } from './SpreadsheetEditor'

export function TablesPage() {
  const { profile } = useAuthStore()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: spreadsheets = [], isLoading } = useQuery({
    queryKey: ['spreadsheets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('spreadsheets')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return data as Spreadsheet[]
    },
  })

  // Realtime
  useEffect(() => {
    const ch = supabase.channel('spreadsheets-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spreadsheets' }, () => {
        qc.invalidateQueries({ queryKey: ['spreadsheets'] })
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [qc])

  async function handleCreate() {
    if (!profile) return
    const { data, error } = await supabase
      .from('spreadsheets')
      .insert({ name: 'Nová tabulka', created_by: profile.id, updated_by: profile.id })
      .select()
      .single()
    if (error) { toast.error(error.message); return }
    qc.invalidateQueries({ queryKey: ['spreadsheets'] })
    setSelectedId((data as Spreadsheet).id)
  }

  async function handleDelete(s: Spreadsheet) {
    if (!await confirm({ title: 'Smazat tabulku', message: `Opravdu smazat tabulku „${s.name}"? Tato akce je nevratná.`, confirmLabel: 'Smazat', variant: 'danger' })) return
    const { error } = await supabase.from('spreadsheets').delete().eq('id', s.id)
    if (error) { toast.error(error.message); return }
    qc.invalidateQueries({ queryKey: ['spreadsheets'] })
    if (selectedId === s.id) setSelectedId(null)
    toast.success('Tabulka smazána')
  }

  const selected = spreadsheets.find(s => s.id === selectedId) ?? null

  if (selected) {
    return (
      <PageLayout>
        <div className="mb-4">
          <button
            onClick={() => setSelectedId(null)}
            className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            <ChevronLeft size={16} /> Zpět na tabulky
          </button>
        </div>
        <SpreadsheetEditor
          spreadsheet={selected}
          onSaved={() => qc.invalidateQueries({ queryKey: ['spreadsheets'] })}
        />
      </PageLayout>
    )
  }

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Tabulky</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Sdílené živé tabulky pro celý tým</p>
          </div>
          {profile && (
            <button
              onClick={handleCreate}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Plus size={15} /> Nová tabulka
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : spreadsheets.length === 0 ? (
          <div className="text-center py-28 text-gray-400 dark:text-gray-500">
            <Table2 size={44} className="mx-auto mb-3 opacity-25" />
            <p className="text-sm">Zatím žádné tabulky</p>
            {profile && (
              <button onClick={handleCreate} className="mt-3 text-sm text-indigo-500 hover:text-indigo-600">
                Vytvořit první tabulku
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {spreadsheets.map(s => (
              <div
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Table2 size={18} className="text-indigo-400 shrink-0" />
                    <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{s.name}</p>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(s) }}
                    className="p-1 rounded text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2 pl-7">
                  Vytvořeno {formatDate(s.created_at)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  )
}
