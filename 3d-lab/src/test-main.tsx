import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { StudioLights, HdriSky, SectionPlane, Effects, ToneMapping } from '@core'
import type { SkyPreset } from '@core'

const q = new URLSearchParams(location.search)
const mode = q.get('mode') ?? 'sun' // 'sun' | 'studio'
const preset = (q.get('preset') ?? 'afternoon') as SkyPreset
const fx = q.get('fx') !== '0'
const section = q.get('section') === '1'
const ghostInit = q.get('ghost') === '1'
const delayGhost = q.get('delay') === '1' // zapni ghost až po načtení (jako v appce)

const boundsRef = { current: new THREE.Box3(new THREE.Vector3(-2, -1, -2), new THREE.Vector3(2, 2, 2)) }

function Scene() {
  const [ghost, setGhost] = useState(delayGhost ? false : ghostInit)
  useEffect(() => { if (delayGhost) { const t = setTimeout(() => setGhost(true), 900); return () => clearTimeout(t) } }, [])
  return (
    <>
      {mode === 'studio'
        ? <StudioLights boundsRef={boundsRef} shadows />
        : <HdriSky preset={preset} boundsRef={boundsRef} />}
      <ToneMapping mode="aces" exposure={1} />
      {fx && <Effects bloom={false} />}
      {section && <SectionPlane active axis="x" offset={0.5} flip={false} ghost={ghost} modelRoot={null} showHelper={false} boundsRef={boundsRef} />}
      {/* matný kvádr — na ghostu má polovina zprůhlednět */}
      <mesh castShadow position={[0, 0.6, 0]}>
        <boxGeometry args={[2, 1.6, 1.4]} />
        <meshStandardMaterial color="#cc7744" roughness={0.6} metalness={0} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]}>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#667788" />
      </mesh>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <Canvas shadows gl={{ preserveDrawingBuffer: true }} camera={{ position: [4, 2.5, 4], fov: 45 }}>
    <Scene />
  </Canvas>,
)
