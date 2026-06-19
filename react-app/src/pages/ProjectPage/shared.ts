export const inputClass = "w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"

export function formatFileSize(bytes: number): string {
  if (bytes < 1024)           return `${bytes} B`
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isImageUrl(s: string) {
  return /^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?\S*)?$/i.test(s)
    || /\/storage\/v1\/object\/(public|sign)\//.test(s)
    // nově: holá cesta v privátním bucketu (obrázky komentářů se ukládají jako cesta)
    || /^comment-images\/\S+\.(jpe?g|png|gif|webp)$/i.test(s)
}
