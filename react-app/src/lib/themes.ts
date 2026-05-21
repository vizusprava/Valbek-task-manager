export type ThemeAccent = 'default' | 'warm' | 'ocean' | 'navy' | 'violet'

export type ThemePreset = {
  bg: string
  accent: ThemeAccent
  accentHex: string
  label: string
  desc: string
}

export const LIGHT_THEMES: ThemePreset[] = [
  { bg: '#f9fafb', accent: 'default', accentHex: '#4f46e5', label: 'Klasická',  desc: 'Indigová' },
  { bg: '#fdf6ed', accent: 'warm',    accentHex: '#ea580c', label: 'Teplá',     desc: 'Oranžová' },
  { bg: '#eef9ff', accent: 'ocean',   accentHex: '#0d9488', label: 'Oceán',     desc: 'Tyrkysová' },
]

export const DARK_THEMES: ThemePreset[] = [
  { bg: '#030712', accent: 'default', accentHex: '#818cf8', label: 'Noční',     desc: 'Indigová' },
  { bg: '#0c1a2e', accent: 'navy',    accentHex: '#38bdf8', label: 'Navy',      desc: 'Nebeská modrá' },
  { bg: '#18181b', accent: 'violet',  accentHex: '#a78bfa', label: 'Grafitová', desc: 'Fialová' },
]

export function getAccentForBg(bg: string): ThemeAccent {
  const all = [...LIGHT_THEMES, ...DARK_THEMES]
  return all.find(t => t.bg === bg)?.accent ?? 'default'
}
