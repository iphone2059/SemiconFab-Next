import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Matrix } from '@babylonjs/core/Maths/math.vector';

export interface NativeShadowBinding {
  matrix: Matrix;
  texture?: BaseTexture;
  enabled: boolean;
}

/** Key light only: ambient, emissive, environment and other lights remain independent. */
export class NativeShadowMaterial extends MaterialPluginBase {
  constructor(material: Material, private readonly binding: NativeShadowBinding) {
    super(material, 'FABNativeDepthShadow', 200, {}, true, true);
  }
  override isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  override getSamplers(samplers: string[]) { samplers.push('fabShadowDepth'); }
  override getActiveTextures(textures: BaseTexture[]) { if (this.binding.texture) textures.push(this.binding.texture); }
  override getUniforms() {
    return { ubo: [{ name: 'fabLightVP', size: 16, type: 'mat4' }, { name: 'fabShadowEnabled', size: 1, type: 'float' }] };
  }
  override bindForSubMesh(buffer: UniformBuffer) {
    buffer.updateMatrix('fabLightVP', this.binding.matrix);
    buffer.updateFloat('fabShadowEnabled', this.binding.enabled ? 1 : 0);
    if (this.binding.texture) buffer.setTexture('fabShadowDepth', this.binding.texture);
  }
  override getCustomCode(type: string) {
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
var fabShadowDepth: texture_depth_2d;
var fabShadowDepthSampler: sampler_comparison;
fn fabShadowVisibility(worldPosition: vec3f) -> f32 {
  let clip = uniforms.fabLightVP * vec4f(worldPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let texelSize = 1.0 / vec2f(textureDimensions(fabShadowDepth));
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompare(fabShadowDepth, fabShadowDepthSampler,
        uv + vec2f(f32(x), f32(y)) * texelSize, ndc.z - 0.00015);
    }
  }
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z >= 0.0 && ndc.z <= 1.0;
  return mix(1.0, select(1.0, visibility / 9.0, inside), uniforms.fabShadowEnabled);
}`,
      // The key has the highest renderPriority, so Babylon binds it in light slot 0.
      CUSTOM_LIGHT0_COLOR: `let fabVisibility = fabShadowVisibility(fragmentInputs.vPositionW);
diffuse0 = vec4f(diffuse0.rgb * fabVisibility, diffuse0.a);`,
      '!light0\\.vLightSpecular\\.rgb': '(light0.vLightSpecular.rgb * fabVisibility)',
    };
  }
}
