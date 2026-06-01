import type { TaskStatus, TaskPriority } from './types'

export const AVATAR_COLORS = [
  '#4F46E5', '#0891B2', '#059669', '#D97706',
  '#DC2626', '#7C3AED', '#DB2777', '#0284C7',
  '#65A30D', '#EA580C', '#0D9488', '#9333EA',
  '#BE185D', '#1D4ED8', '#B45309', '#047857',
]

export function avatarColor(name: string): string {
  let hash = 5381
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(i)
    hash = hash & 0x7fffffff
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleDateString('cs-CZ', {
    day: 'numeric', month: 'numeric', year: 'numeric',
  })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleString('cs-CZ', {
    day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function isOverdue(dueDateStr: string | null | undefined): boolean {
  if (!dueDateStr) return false
  return new Date(dueDateStr) < new Date(new Date().toDateString())
}

export function isDueSoon(dueDateStr: string | null | undefined, days = 7): boolean {
  if (!dueDateStr) return false
  const due   = new Date(dueDateStr)
  const today = new Date(new Date().toDateString())
  const soon  = new Date(today)
  soon.setDate(today.getDate() + days)
  return due >= today && due <= soon
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  'neudělano':              'Neudělano',
  'rozpracováno':           'Rozpracováno',
  'připraveno ke kontrole': 'Ke kontrole',
  'schváleno':              'Schváleno',
  'hotovo':                 'Hotovo',
}

export const STATUS_COLORS: Record<TaskStatus, string> = {
  'neudělano':              'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'rozpracováno':           'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'připraveno ke kontrole': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'schváleno':              'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'hotovo':                 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low:    'Nízká',
  medium: 'Střední',
  high:   'Vysoká',
}

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  high:   'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: unknown[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function pluralCz(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`
  if (n >= 2 && n <= 4) return `${n} ${few}`
  return `${n} ${many}`
}
