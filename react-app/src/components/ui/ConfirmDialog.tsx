import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { Button } from './Button'

interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'default'
}

type Resolver = (value: boolean) => void

interface ContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ContextValue | null>(null)

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<Resolver | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      setOptions(opts)
      resolverRef.current = resolve
    })
  }, [])

  function handleResponse(value: boolean) {
    resolverRef.current?.(value)
    resolverRef.current = null
    setOptions(null)
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-99999"
          onClick={() => handleResponse(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-sm p-6"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              {options.variant === 'danger' && (
                <div className="shrink-0 w-9 h-9 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                  <AlertTriangle size={18} className="text-red-600 dark:text-red-400" />
                </div>
              )}
              <div>
                {options.title && (
                  <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">{options.title}</h2>
                )}
                <p className="text-sm text-gray-600 dark:text-gray-400">{options.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleResponse(false)}>
                {options.cancelLabel ?? 'Zrušit'}
              </Button>
              <Button
                variant={options.variant === 'danger' ? 'danger' : 'primary'}
                size="sm"
                onClick={() => handleResponse(true)}
              >
                {options.confirmLabel ?? 'Potvrdit'}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmDialogProvider')
  return ctx.confirm
}
