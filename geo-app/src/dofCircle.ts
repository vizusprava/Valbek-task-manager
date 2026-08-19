/**
 * Kruhové rozostření v ploše obrazovky: uprostřed ostrý kruh, k okrajům přechod do rozmazání.
 *
 * POZOR na název: tohle NENÍ hloubka ostrosti. Vestavěná `createDepthOfFieldStage()` řídí ostrost
 * podle HLOUBKY pixelu, takže ostré je všechno v dané vzdálenosti od kamery, ať je to kdekoli na
 * obrazovce. Tady je faktor čistě poloměr od středu obrazovky — ostré je to, na co se díváte,
 * bez ohledu na vzdálenost. Pro zvýraznění místa v pohledu je to předvídatelnější.
 *
 * Skládá se stejně jako vestavěná DOF (Cesium PostProcessStageLibrary): rozmazávací stage +
 * composite, který mezi ostrým a rozmazaným obrazem míchá. `inputPreviousStageTexture: false`
 * zařídí, že composite dostane PŮVODNÍ ostrý obraz, ne výstup rozmazání.
 */
import * as Cesium from 'cesium'

const FS = `
uniform sampler2D colorTexture;
uniform sampler2D blurTexture;
uniform float radius;
uniform float feather;

in vec2 v_textureCoordinates;

void main(void)
{
    // Poměr stran se srovnává kratší stranou, jinak by z kruhu byla elipsa. Po přepočtu je
    // r == 1.0 přesně vzdálenost od středu k bližšímu okraji obrazovky, takže „velikost kruhu"
    // v UI je 0..1 nezávisle na rozlišení okna.
    vec2 res = czm_viewport.zw;
    vec2 d = (v_textureCoordinates - vec2(0.5)) * (res / min(res.x, res.y)) * 2.0;
    float t = smoothstep(radius, radius + max(feather, 0.001), length(d));
    out_FragColor = mix(texture(colorTexture, v_textureCoordinates), texture(blurTexture, v_textureCoordinates), t);
}
`

/** uniformy vystavené na výsledném compositu */
export type CircleDofUniforms = {
  /** poloměr ostrého kruhu; 1.0 = od středu k bližšímu okraji obrazovky */
  radius: number
  /** šířka přechodu ostré → rozmazané, ve stejných jednotkách jako radius */
  feather: number
  /** síla rozmazání (uniformy blur stage) */
  sigma: number
  stepSize: number
}

export function createCircleDofStage(): Cesium.PostProcessStageComposite {
  const blur = Cesium.PostProcessStageLibrary.createBlurStage()
  const composite = new Cesium.PostProcessStage({
    name: 'dof_circle_composite',
    fragmentShader: FS,
    // blurTexture se váže jménem stage — Cesium sem dosadí její výstupní texturu.
    // Výchozí radius/feather drž shodné se stavem v MapView, ať se to nerozejde.
    uniforms: { radius: 0.84, feather: 0.7, blurTexture: blur.name },
  })

  const uniforms = {}
  Object.defineProperties(uniforms, {
    radius: { get: () => composite.uniforms.radius, set: (v: number) => { composite.uniforms.radius = v } },
    feather: { get: () => composite.uniforms.feather, set: (v: number) => { composite.uniforms.feather = v } },
    sigma: { get: () => blur.uniforms.sigma, set: (v: number) => { blur.uniforms.sigma = v } },
    stepSize: { get: () => blur.uniforms.stepSize, set: (v: number) => { blur.uniforms.stepSize = v } },
  })

  return new Cesium.PostProcessStageComposite({
    name: 'dof_circle',
    stages: [blur, composite],
    inputPreviousStageTexture: false,
    uniforms,
  })
}
