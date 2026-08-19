/**
 * Společný kontext dlouhých exportů.
 *
 * Exportní moduly nesmí sahat na stav komponenty — dostanou tohle a víc nepotřebují: kudy se
 * pozná zrušení a kam hlásit průběh. Díky tomu jsou volatelné odkudkoliv (i z testu) a MapView
 * si sám rozhoduje, do kterého ukazatele průběh teče.
 *
 * Job vrací HLÁŠKU pro úspěšný toast, nezobrazuje ji sám — o toasty i o úklid se stará jediná
 * obálka `runExport` v MapView, ne každý export zvlášť.
 */
export type ExportCtx = {
  signal: AbortSignal
  /** `pct < 0` = neurčitý průběh (ukáže se jen text) */
  report: (pct: number, msg: string) => void
}

/** Vyhodí AbortError, když uživatel mezitím export zrušil. Volat v každé delší smyčce. */
export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError')
}
