/* eslint-disable react-hooks/refs -- registr geometrie spojnic se záměrně přebudovává během renderu (čte ho per-frame useFrame, ne React render) */
import { useState, useRef } from 'react'
import { Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ViewerAnnotation } from './adapter'

// výchozí pozice boxu, dokud ho uživatel nepřetáhne (nad tečkou)
const DEFAULT_OFFSET = { x: 0, y: -64 }
const DEFAULT_COLOR = '#818cf8'

function hexToRgba(hex: string, a: number) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(full, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

type DragState = { id: string; startX: number; startY: number; baseX: number; baseY: number; x: number; y: number }
type Geom = { primary: { x: number; y: number; z: number }; point: { x: number; y: number; z: number }; boxOff: { x: number; y: number } }

const _v = new THREE.Vector3()
function projectPx(p: { x: number; y: number; z: number }, camera: THREE.Camera, w: number, h: number) {
  _v.set(p.x, p.y, p.z).project(camera)
  return { x: (_v.x * 0.5 + 0.5) * w, y: (1 - (_v.y * 0.5 + 0.5)) * h, behind: _v.z > 1 }
}

export function AnnotationMarkers({ annotations, onDelete, canDelete, visible, hiddenIds, forceIds = null, stagger = false, onMoveBox, onAddPin, onRemovePin, onColorChange, onCreateTask }: {
  annotations: ViewerAnnotation[]
  onDelete: (id: string) => void
  canDelete: boolean
  visible: boolean
  hiddenIds: Set<string>
  /** když je zadáno, zobrazí jen tyto anotace (prezentační režim per pohled) */
  forceIds?: Set<string> | null
  /** postupné naskakování — zpoždění podle pořadí (prezentace) */
  stagger?: boolean
  /** uloží přetažený box; když není, drag je vypnutý */
  onMoveBox?: (id: string, offsetX: number, offsetY: number) => void
  /** spustí režim přidání dalšího bodu k anotaci */
  onAddPin?: (id: string) => void
  /** odebere další bod anotace podle indexu */
  onRemovePin?: (id: string, index: number) => void
  /** změní barvu anotace */
  onColorChange?: (id: string, color: string) => void
  /** vytvoří úkol z anotace (řeší hostitelská appka) */
  onCreateTask?: (ann: ViewerAnnotation) => void
}) {
  const { camera, gl } = useThree()
  const [drag, setDrag] = useState<DragState | null>(null)
  const editable = canDelete && !!onMoveBox
  const shown = forceIds ? annotations.filter(a => forceIds.has(a.id)) : annotations

  // mapy DOM elementů extra spojnic (refy fungují i přes separátní root drei Html)
  const dotEls  = useRef(new Map<string, HTMLDivElement>())
  const lineEls = useRef(new Map<string, HTMLDivElement>())
  // geometrie extra spojnic, přebudovaná každý render (drží aktuální boxOff i při dragu)
  const geom = useRef(new Map<string, Geom>())
  geom.current = new Map()

  // projekce extra bodů do obrazovky každý snímek (běží pod Canvasem → kontext je k dispozici)
  useFrame(() => {
    const w = gl.domElement.clientWidth, h = gl.domElement.clientHeight
    geom.current.forEach((g, key) => {
      const dot = dotEls.current.get(key)
      const line = lineEls.current.get(key)
      const p = projectPx(g.primary, camera, w, h)
      const q = projectPx(g.point, camera, w, h)
      const dx = q.x - p.x, dy = q.y - p.y
      const disp = q.behind ? 'none' : 'block'
      if (dot) {
        dot.style.display = disp
        dot.style.transform = `translate(${dx}px, ${dy}px) translate(-50%, -50%)`
      }
      if (line) {
        line.style.display = disp
        const lx = g.boxOff.x, ly = g.boxOff.y
        line.style.width = `${Math.hypot(dx - lx, dy - ly)}px`
        line.style.transform = `translate(${lx}px, ${ly}px) rotate(${Math.atan2(dy - ly, dx - lx) * 180 / Math.PI}deg)`
      }
    })
  })

  return (
    <>
      {shown.map((ann, i) => {
        const isVisible = forceIds ? visible : (visible && !hiddenIds.has(ann.id))
        const delay = stagger && isVisible ? i * 160 : 0

        const stored = (ann.offsetX || ann.offsetY) ? { x: ann.offsetX ?? 0, y: ann.offsetY ?? 0 } : DEFAULT_OFFSET
        const off = drag?.id === ann.id ? { x: drag.x, y: drag.y } : stored

        const lineLen = Math.hypot(off.x, off.y)
        const lineAngle = Math.atan2(off.y, off.x) * 180 / Math.PI
        const extra = ann.extraPoints ?? []
        const accent = ann.color || DEFAULT_COLOR
        const dotStyle = { width: 7, height: 7, borderRadius: '50%', background: accent, boxShadow: `0 0 6px ${hexToRgba(accent, 0.9)}` }

        return (
          <Html key={ann.id} position={[ann.x, ann.y, ann.z]} style={{ pointerEvents: 'none' }}>
            <div style={{ position: 'relative', width: 0, height: 0 }}>
              <div style={{
                opacity: isVisible ? 1 : 0,
                transition: `opacity ${stagger ? '0.5s' : '0.9s'} ease ${delay}ms`,
              }}>
                {/* další ukotvené body (pozice nastavuje useFrame přes refy) */}
                {extra.map((pt, idx) => {
                  const key = `${ann.id}:${idx}`
                  geom.current.set(key, { primary: { x: ann.x, y: ann.y, z: ann.z }, point: pt, boxOff: off })
                  return (
                    <div key={idx}>
                      <div
                        ref={el => { if (el) lineEls.current.set(key, el); else lineEls.current.delete(key) }}
                        style={{
                          position: 'absolute', left: 0, top: 0, height: 1, display: 'none',
                          transformOrigin: '0 50%',
                          background: `linear-gradient(to right, ${hexToRgba(accent, 0.85)}, ${hexToRgba(accent, 0.3)})`,
                          pointerEvents: 'none',
                        }}
                      />
                      <div
                        ref={el => { if (el) dotEls.current.set(key, el); else dotEls.current.delete(key) }}
                        onPointerDown={editable && isVisible ? (e => { e.stopPropagation(); onRemovePin?.(ann.id, idx) }) : undefined}
                        title={editable ? 'Klikni pro odebrání bodu' : undefined}
                        style={{
                          position: 'absolute', left: 0, top: 0, display: 'none',
                          width: 16, height: 16, alignItems: 'center', justifyContent: 'center',
                          pointerEvents: editable && isVisible ? 'auto' : 'none',
                          cursor: editable ? 'pointer' : 'default',
                        }}
                      >
                        <div style={dotStyle} />
                      </div>
                    </div>
                  )
                })}

                {/* spojnice tečka → box (primární) */}
                <div style={{
                  position: 'absolute', left: 0, top: 0,
                  width: lineLen, height: 1,
                  transformOrigin: '0 50%',
                  transform: `rotate(${lineAngle}deg)`,
                  background: `linear-gradient(to right, ${hexToRgba(accent, 0.3)}, ${hexToRgba(accent, 0.85)})`,
                  pointerEvents: 'none',
                }} />
                {/* ukotvená tečka na primárním 3D bodě */}
                <div style={{
                  position: 'absolute', left: 0, top: 0,
                  ...dotStyle,
                  transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                }} />

                {/* textový box (přetahovatelný) */}
                <div
                  onPointerDown={editable && isVisible ? (e => {
                    e.stopPropagation()
                    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
                    setDrag({ id: ann.id, startX: e.clientX, startY: e.clientY, baseX: off.x, baseY: off.y, x: off.x, y: off.y })
                  }) : undefined}
                  onPointerMove={drag?.id === ann.id ? (e => {
                    setDrag(d => d && ({ ...d, x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) }))
                  }) : undefined}
                  onPointerUp={drag?.id === ann.id ? (e => {
                    e.stopPropagation()
                    onMoveBox?.(ann.id, Math.round(drag.x), Math.round(drag.y))
                    setDrag(null)
                  }) : undefined}
                  style={{
                    position: 'absolute', left: off.x, top: off.y,
                    transform: 'translate(-50%, -100%)',
                    background: 'rgba(10,12,20,0.95)',
                    border: `1px solid ${hexToRgba(accent, 0.6)}`,
                    borderRadius: 6,
                    overflow: 'hidden',
                    width: 200,
                    boxShadow: '0 3px 12px rgba(0,0,0,0.6)',
                    pointerEvents: isVisible ? 'auto' : 'none',
                    cursor: editable ? (drag?.id === ann.id ? 'grabbing' : 'move') : 'default',
                    userSelect: 'none',
                  }}
                >
                  {ann.object_name && (
                    <div style={{
                      background: hexToRgba(accent, 0.25),
                      borderBottom: `1px solid ${hexToRgba(accent, 0.35)}`,
                      padding: '2px 8px',
                      fontSize: 9,
                      color: '#dbe1f3',
                      letterSpacing: '0.03em',
                      textTransform: 'uppercase',
                      overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
                    }}>
                      {ann.object_name}
                    </div>
                  )}
                  <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span style={{ color: '#e5e7eb', fontSize: 11, flex: 1, wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{ann.text}</span>
                    {canDelete && (
                      <div style={{ display: 'flex', gap: 3, flexShrink: 0, alignItems: 'center' }}>
                        {onColorChange && (
                          <label onPointerDown={e => e.stopPropagation()} title="Barva anotace" style={{ cursor: 'pointer', display: 'flex' }}>
                            <input
                              type="color"
                              value={accent}
                              onChange={e => onColorChange(ann.id, e.target.value)}
                              style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                            />
                            <span style={{ width: 11, height: 11, borderRadius: '50%', background: accent, border: '1px solid rgba(255,255,255,0.35)', display: 'block' }} />
                          </label>
                        )}
                        {onAddPin && (
                          <button
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); onAddPin(ann.id) }}
                            title="Přidat další bod (klikni pak na model)"
                            style={{ color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}
                          >+</button>
                        )}
                        {onCreateTask && (
                          <button
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); onCreateTask(ann) }}
                            title="Vytvořit úkol z této poznámky"
                            style={{ color: '#818cf8', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                              <rect x="9" y="3" width="6" height="4" rx="1" />
                              <path d="m9 14 2 2 4-4" />
                            </svg>
                          </button>
                        )}
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); onDelete(ann.id) }}
                          title="Smazat poznámku"
                          style={{ color: '#4b5563', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', fontSize: 14, lineHeight: 1 }}
                        >×</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Html>
        )
      })}
    </>
  )
}
