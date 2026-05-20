import { useState } from 'react'

// ── HSV ↔ Hex helpers ─────────────────────────────────────────

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if      (h < 60)  { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else              { r = c; g = 0; b = x }
  const hex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return { h: 0, s: 0, v: 1 }
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break
      case g: h = ((b - r) / d + 2) * 60; break
      case b: h = ((r - g) / d + 4) * 60; break
    }
  }
  return { h, s, v }
}

// ── Component ─────────────────────────────────────────────────

export function ColorPicker({ color, onChange }: {
  color: string
  onChange: (hex: string) => void
}) {
  const init = hexToHsv(color)
  const [h, setH] = useState(init.h)
  const [s, setS] = useState(init.s)
  const [v, setV] = useState(init.v)
  const [hexInput, setHexInput] = useState(color)

  const hueColor = hsvToHex(h, 1, 1)
  const current  = hsvToHex(h, s, v)

  function emit(nh: number, ns: number, nv: number) {
    const hex = hsvToHex(nh, ns, nv)
    setHexInput(hex)
    onChange(hex)
  }

  // ── SV square ──────────────────────────────────────────────

  function getSv(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const ns = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const nv = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    return { ns, nv }
  }

  function handleSvDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const { ns, nv } = getSv(e)
    setS(ns); setV(nv); emit(h, ns, nv)
  }

  function handleSvMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return
    const { ns, nv } = getSv(e)
    setS(ns); setV(nv); emit(h, ns, nv)
  }

  // ── Hue slider ─────────────────────────────────────────────

  function getHue(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360))
  }

  function handleHueDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const nh = getHue(e)
    setH(nh); emit(nh, s, v)
  }

  function handleHueMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return
    const nh = getHue(e)
    setH(nh); emit(nh, s, v)
  }

  // ── Hex input ──────────────────────────────────────────────

  function handleHexInput(val: string) {
    setHexInput(val)
    const clean = val.startsWith('#') ? val : '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
      const { h: nh, s: ns, v: nv } = hexToHsv(clean)
      setH(nh); setS(ns); setV(nv)
      onChange(clean)
    }
  }

  return (
    <div className="select-none w-full space-y-2">
      {/* Saturation / brightness square */}
      <div
        className="relative w-full h-44 rounded-lg cursor-crosshair touch-none overflow-hidden"
        style={{ background: `linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={handleSvDown}
        onPointerMove={handleSvMove}
      >
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, transparent, #000)' }} />
        <div
          className="absolute w-5 h-5 rounded-full border-2 border-white shadow-lg pointer-events-none -translate-x-1/2 -translate-y-1/2 ring-1 ring-black/20"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, backgroundColor: current }}
        />
      </div>

      {/* Hue strip */}
      <div
        className="relative h-4 rounded-full cursor-pointer touch-none"
        style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}
        onPointerDown={handleHueDown}
        onPointerMove={handleHueMove}
      >
        <div
          className="absolute top-1/2 w-5 h-5 rounded-full border-2 border-white shadow-lg pointer-events-none -translate-x-1/2 -translate-y-1/2 ring-1 ring-black/20"
          style={{ left: `${(h / 360) * 100}%`, backgroundColor: hueColor }}
        />
      </div>

      {/* Hex + preview */}
      <div className="flex items-center gap-2 mt-1">
        <div className="w-8 h-8 rounded-md border border-gray-200 dark:border-gray-700 shrink-0" style={{ backgroundColor: current }} />
        <input
          value={hexInput}
          onChange={e => handleHexInput(e.target.value)}
          className="flex-1 px-2 py-1 text-sm font-mono rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="#f9fafb"
        />
      </div>
    </div>
  )
}
