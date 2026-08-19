/**
 * Pozadí scény — co je kolem glóbu, když nekoukáme na fotorealistické dlaždice.
 *
 * Cesium umí nativně jen hvězdné nebe (skyBox) nebo JEDNU plnou barvu (`scene.backgroundColor`).
 * Přechod („šedá do ztracena") proto kreslíme post-process stagí: kde se nic nevykreslilo
 * (hloubka == 1), nahradíme barvu radiálním přechodem od středu obrazovky ven.
 *
 * Stage keyuje i na ALFU: glóbus mimo dostupná data (mimo ČR) vykreslí `globe.baseColor`, a když
 * mu dáme alfu 0, splyne s pozadím místo aby kolem republiky svítil obdélník. Kdyby alfa
 * pipeline někde nepřežila (MSAA/tonemapping), zůstane vidět obdélník v barvě `outer` — tedy
 * nejhorší případ je „nenápadný okraj", ne bílá plocha. Proto má `baseColor` smysluplné RGB.
 */
import * as Cesium from 'cesium'

export type BgMode = 'vesmir' | 'tmava' | 'svetla' | 'vlastni'

export const BG_MODES: { id: BgMode; label: string; title: string }[] = [
  { id: 'vesmir', label: 'vesmír', title: 'Hvězdné nebe + atmosféra (výchozí Cesium)' },
  { id: 'tmava', label: 'tmavé', title: 'Tmavý přechod do ztracena — model vynikne' },
  { id: 'svetla', label: 'světlé', title: 'Světlý přechod — pro snímky do dokumentace' },
  { id: 'vlastni', label: 'barva', title: 'Jednolitá barva podle výběru' },
]

/** střed obrazovky → okraje */
const PRESETS: Record<'tmava' | 'svetla', { inner: string; outer: string }> = {
  tmava: { inner: '#2b323c', outer: '#0a0d12' },
  svetla: { inner: '#ffffff', outer: '#c9d1da' },
}

const FS = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec4 innerColor;
uniform vec4 outerColor;

in vec2 v_textureCoordinates;

void main(void)
{
    vec4 c = texture(colorTexture, v_textureCoordinates);
    float depth = czm_readDepth(depthTexture, v_textureCoordinates);
    // pozadí = nic nevykresleno (prázdná hloubka) NEBO průhledný pixel (glóbus mimo data)
    bool bg = depth >= 1.0 - czm_epsilon6 || c.a < 0.5;

    // aspekt srovnaný kratší stranou, ať je z kruhu kruh; 1.45 ≈ roh obrazovky
    vec2 res = czm_viewport.zw;
    vec2 d = (v_textureCoordinates - vec2(0.5)) * (res / min(res.x, res.y)) * 2.0;
    float t = smoothstep(0.0, 1.0, clamp(length(d) / 1.45, 0.0, 1.0));
    vec3 g = mix(innerColor.rgb, outerColor.rgb, t);

    out_FragColor = vec4(bg ? g : c.rgb, 1.0);
}
`

function makeStage(inner: Cesium.Color, outer: Cesium.Color): Cesium.PostProcessStage {
  return new Cesium.PostProcessStage({
    name: 'pozadi_prechod',
    fragmentShader: FS,
    uniforms: { innerColor: inner, outerColor: outer },
  })
}

/**
 * Mlha na dálku — bez ní terén na obzoru končí břitvou (data ČÚZK jsou jen ČR, dál se nekreslí nic)
 * a při odzoomování je z toho ostrá vodorovná hrana mezi mapou a pozadím.
 *
 * Nepočítáme si ji sami: Cesium má `scene.fog`, který škáluje hustotu podle výšky kamery
 * (`density * (h/maxHeight)^-0.59`) a navíc ji násobí `1 - |dot(směr, nahoru)|` — tedy naplno
 * působí přesně při pohledu k obzoru a vůbec při pohledu kolmo dolů. To je chování, které se
 * vlastním „fade podle vzdálenosti" nedá trefit jednou konstantou (u země vidíš 30 km, z 300 km
 * výšky 1500 km). Mlha se počítá v shaderu glóbu, takže ji přechodová stage nepřemaluje.
 *
 * Barvu mlhy si Cesium bere z atmosféry → posuny (`saturationShift` -1 = do šeda) ji sladí
 * s barvou pozadí. `minBright` drží mlhu svítivou i na noční straně (jinak zčerná).
 */
// `density` 6e-3 = 10× Cesium default, `heightFalloff` 0.35 místo 0.59 → mlha neroste tak prudko
// při klesání, takže se z 500 m nad zemí prakticky neprojeví (~9 % na 5 km), ale z 60–200 km výšky
// při šikmém pohledu rozpustí hranu (~50–70 % na okraji dat). Chce to jinak? Tyhle dvě čísla.
const FOG_DENSITY = 6e-3
const FOG_FALLOFF = 0.35

const HAZE: Record<'tmava' | 'svetla' | 'vlastni', { brightness: number; minBright: number }> = {
  tmava: { brightness: -0.35, minBright: 0.05 },
  svetla: { brightness: 0.45, minBright: 0.85 },
  vlastni: { brightness: 0.0, minBright: 0.35 },
}

/**
 * Nastaví pozadí scény podle režimu. `stageRef` drží přechodovou stage (nebo null) — funkce si ji
 * sama přidá/odebere ze scény, takže volající jen podrží referenci.
 */
export function applyBackground(
  v: Cesium.Viewer,
  mode: BgMode,
  custom: string,
  stageRef: { current: Cesium.PostProcessStage | null },
): void {
  const scene = v.scene
  const space = mode === 'vesmir'

  // vesmírné kulisy dávají smysl jen v režimu „vesmír" — jinak by přes plochou barvu prosvítaly.
  // POZOR: skyAtmosphere se kreslí bez zápisu do hloubky, takže by ho přechodová stage stejně
  // přemalovala — proto je mimo „vesmír" vypnutý a haze na obzoru dělá `scene.fog` (viz HAZE).
  if (scene.skyBox) scene.skyBox.show = space
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = space
  if (scene.sun) scene.sun.show = space
  if (scene.moon) scene.moon.show = space
  scene.globe.showGroundAtmosphere = true // i mimo vesmír: přidává úbytek kontrastu do dálky

  if (space) {
    scene.atmosphere.saturationShift = 0
    scene.atmosphere.brightnessShift = 0
    scene.fog.density = 6e-4           // Cesium default
    scene.fog.heightFalloff = 0.59     // Cesium default
    scene.fog.minimumBrightness = 0.03
  } else {
    const h = HAZE[mode]
    scene.atmosphere.saturationShift = -1  // atmosféra (= barva mlhy) do šeda, ať nemodrá do pozadí
    scene.atmosphere.brightnessShift = h.brightness
    scene.fog.density = FOG_DENSITY
    scene.fog.heightFalloff = FOG_FALLOFF
    scene.fog.minimumBrightness = h.minBright
  }

  const gradient = mode === 'tmava' || mode === 'svetla'

  if (gradient) {
    const p = PRESETS[mode]
    const inner = Cesium.Color.fromCssColorString(p.inner)
    const outer = Cesium.Color.fromCssColorString(p.outer)
    if (!stageRef.current) stageRef.current = scene.postProcessStages.add(makeStage(inner, outer)) as Cesium.PostProcessStage
    else { stageRef.current.uniforms.innerColor = inner; stageRef.current.uniforms.outerColor = outer }
    scene.backgroundColor = outer                              // záloha, kdyby stage neběžela
    scene.globe.baseColor = Cesium.Color.fromAlpha(outer, 0)   // mimo data → vyklíčuje se do přechodu
  } else {
    if (stageRef.current) { scene.postProcessStages.remove(stageRef.current); stageRef.current = null }
    // plná barva: glóbus mimo data dostane TÉŽ barvu pozadí → obdélník kolem ČR zmizí bez shaderu
    const flat = space ? Cesium.Color.BLACK : Cesium.Color.fromCssColorString(custom)
    scene.backgroundColor = flat
    scene.globe.baseColor = flat
  }

  scene.requestRender()
}
