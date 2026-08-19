/**
 * Katastrální území Liberce jako svítící „polární záře" nad terénem.
 *
 * Feature je za přepínačem `ENABLE_LIBEREC_DISTRICTS` (viz config.ts) a ve výchozím nasazení
 * vypnutá — proto sedí v samostatném modulu a nezatěžuje nic dalšího.
 */
import * as Cesium from 'cesium'
import { wgsOf } from './tiles'

// Katastrální území statutárního města Liberec (26) — kód k.ú. (RÚIAN) → název.
// Kód = `properties.id` z WFS cp:CadastralZoning; filtrujeme jimi „jen pod Libercem".
const LIBEREC_KU: Record<string, string> = {
  '682039': 'Liberec', '682144': 'Ruprechtice', '682161': 'Nové Pavlovice', '682179': 'Staré Pavlovice',
  '682209': 'Růžodol I', '682233': 'Františkov u Liberce', '682241': 'Janův Důl u Liberce', '682250': 'Horní Růžodol',
  '682268': 'Dolní Hanychov', '682314': 'Rochlice u Liberce', '682390': 'Starý Harcov', '682438': 'Kateřinky u Liberce',
  '682446': 'Rudolfov', '682462': 'Horní Hanychov', '682471': 'Ostašov u Liberce', '682489': 'Horní Suchá u Liberce',
  '682497': 'Karlinky', '673641': 'Krásná Studánka', '673650': 'Radčice u Krásné Studánky', '631086': 'Doubí u Liberce',
  '631094': 'Hluboká u Liberce', '631108': 'Pilínkov', '780472': 'Vesec u Liberce', '785628': 'Kunratice u Liberce',
  '785644': 'Vratislavice nad Nisou', '689823': 'Machnín',
}

export type District = { code: string; name: string; rings: Cesium.Cartesian3[][] }

export const AURORA_HEIGHT_M = 220 // jak vysoko stoupá „polární záře" nad terén
export const AURORA_LABEL_LIFT_M = 90 // popisek pluje kousek nad září
// o kolik zapustit základnu pod terén: kryje nesoulad výšek DMR (základna) vs. zobrazeného povrchu
// (hlavně Google 3D realita se liší i o desítky metrů). Zapuštěná část je pod zemí, glow začíná u povrchu.
export const AURORA_SINK_M = 50

// Shaderový materiál záře: svislý fade (dole sytě → nahoru mizí) + stoupající vlny (nahoru/dolů) — GPU, plynulé.
// st.t = 0 u základny stěny, 1 nahoře. czm_frameNumber pohání animaci (viewer renderuje kontinuálně).
export function auroraMaterial(color: Cesium.Color, phase: number): Cesium.Material {
  return new Cesium.Material({
    translucent: true,
    fabric: {
      uniforms: { uColor: color, uPhase: phase },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float v = clamp(materialInput.st.t, 0.0, 1.0);
          float s = materialInput.st.s;                                     // 0..1 podél délky stěny
          float fade = pow(1.0 - v, 1.3);                                   // sytě dole, mizí nahoru
          // fáze posunutá i podél délky (s) → vlna dojede nahoru na každém místě jindy (diagonální vlnění)
          float wave = 0.5 + 0.5 * sin(v * 9.0 - czm_frameNumber * 0.03 + uPhase + s * 22.0);
          m.diffuse = uColor.rgb;
          m.emission = uColor.rgb * 0.25;
          m.alpha = uColor.a * fade * (0.4 + 0.6 * wave);
          return m;
        }
      `,
    },
  })
}

/** Uzavřený obrys zhladí Catmull-Rom splinem — místo lomené čáry plynulá křivka (hladší stěna záře). */
export function smoothClosedRing(pts: [number, number][], stepsPerSeg: number): [number, number][] {
  const n = pts.length
  if (n < 3) return pts
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t, t3 = t2 * t
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  }
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    for (let s = 0; s < stepsPerSeg; s++) {
      const t = s / stepsPerSeg
      out.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t)])
    }
  }
  return out
}

/** Katastrální území Liberce z ČÚZK WFS (CadastralZoning), filtrovaná na obec Liberec dle LIBEREC_KU. */
export async function fetchLiberecDistricts(): Promise<District[]> {
  const bbox = '50.68,14.94,50.83,15.15,urn:ogc:def:crs:EPSG::4326'
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralZoning&COUNT=300&OUTPUTFORMAT=application/json&BBOX=${bbox}`
  const out: District[] = []
  try {
    const data = await (await fetch(url)).json() as { features?: Array<{ properties?: { id?: number | string }; geometry: { type: string; coordinates: unknown } }> }
    for (const f of data.features ?? []) {
      const code = String(f.properties?.id ?? '')
      const name = LIBEREC_KU[code]
      if (!name) continue
      const ringsRaw: number[][][] = []
      if (f.geometry.type === 'Polygon') ringsRaw.push((f.geometry.coordinates as number[][][])[0])
      else if (f.geometry.type === 'MultiPolygon') for (const poly of (f.geometry.coordinates as number[][][][])) ringsRaw.push(poly[0])
      const rings = ringsRaw.filter(r => r && r.length >= 3).map(r => r.map(([x, y]) => {
        const [lo, la] = wgsOf(x, y)
        return Cesium.Cartesian3.fromDegrees(lo, la)
      }))
      if (rings.length) out.push({ code, name, rings })
    }
  } catch { /* ignore */ }
  return out
}
