import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { Light } from '@babylonjs/core/Lights/light';
import type { Scene } from '@babylonjs/core/scene';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Effect } from '@babylonjs/core/Materials/effect';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';

const LOCAL_LIGHT_LIMIT = 24;
const packedFrames = new WeakMap<Scene, { frame: number; count: number; data: Float32Array }>();

/** Four vec4s per source light, in the material UBO (not one GPU binding per light). */
export function packOriginalLocalLights(scene: Scene): { count: number; data: Float32Array } {
  const data = new Float32Array(LOCAL_LIGHT_LIMIT * 16);
  let count = 0;
  for (const light of scene.lights) {
    if (!(light instanceof OriginalPointLight || light instanceof OriginalSpotLight) || !light.isEnabled()) continue;
    if (count >= LOCAL_LIGHT_LIMIT) throw new Error('Frozen local-light capacity exceeded');
    light.parent?.computeWorldMatrix(true);
    light.computeTransformedInformation();
    const position = light.transformedPosition ?? light.position;
    const offset = count++ * 16;
    data.set([position.x, position.y, position.z, light.range], offset);
    data.set([light.diffuse.r * light.intensity, light.diffuse.g * light.intensity, light.diffuse.b * light.intensity, 0], offset + 4);
    const spot = light instanceof OriginalSpotLight;
    const direction = spot ? (light.transformedDirection ?? light.direction).normalizeToNew() : { x: 0, y: 0, z: 0 };
    data.set([direction.x, direction.y, direction.z, light.legacyDecay], offset + 8);
    data.set([spot ? Math.cos(light.angle / 2) : 0, spot ? Math.cos(light.innerAngle / 2) : 0, spot ? 1 : 0, 0], offset + 12);
  }
  return { count, data };
}

/** Source r128 point lights use pow(1-distance/range, decay), default decay=1.
 * vLightFalloff.z is unused by Babylon's STANDARD point-light branch. Preserve
 * the source exponent there rather than overloading radius/intensity/range.
 */
export class OriginalPointLight extends PointLight {
  constructor(name: string, position: Vector3, scene: Scene, readonly legacyDecay = 1) {
    super(name, position, scene);
    this.falloffType = Light.FALLOFF_STANDARD;
  }
  override transferToEffect(effect: Effect, lightIndex: string): this {
    super.transferToEffect(effect, lightIndex);
    this._uniformBuffer.updateFloat4('vLightFalloff', this.range, 1 / (this.range * this.range), this.legacyDecay, 0, lightIndex);
    return this;
  }
}

/** STANDARD spot lighting uses its direction/cone uniforms, not the GLTF z/w
 * scale/offset. Source spots keep the same explicit decay payload as points.
 */
export class OriginalSpotLight extends SpotLight {
  constructor(name: string, position: Vector3, direction: Vector3, angle: number, exponent: number, scene: Scene, readonly legacyDecay = 2) {
    super(name, position, direction, angle, exponent, scene);
    this.falloffType = Light.FALLOFF_STANDARD;
  }
  override transferToEffect(effect: Effect, lightIndex: string): this {
    super.transferToEffect(effect, lightIndex);
    this._uniformBuffer.updateFloat4('vLightFalloff', this.range, 1 / (this.range * this.range), this.legacyDecay, 0, lightIndex);
    return this;
  }
}

/** Original r128: physicallyCorrectLights=false, per-light decay, LinearEncoding.
 * Babylon still emits a gamma conversion with imageProcessing.isEnabled=false;
 * bypass it for these source materials and retain the original fog factor.
 */
export class OriginalLegacyLightFalloff extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, 'OriginalLegacyLightFalloff', 150, {}, true, true);
    material.usePhysicalLightFalloff = false;
    material.brdf.baseDiffuseModel = Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT;
    // Key/fill retain native slots (key owns the native shadow). Source local
    // lights share the material UBO below, avoiding per-light GPU binding limits.
    material.maxSimultaneousLights = 2;
  }
  override isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  override getUniforms() {
    return { ubo: [{ name: 'originalLocalLightCount', size: 1, type: 'float' },
      { name: 'originalLocalLightData', size: 4, type: 'vec4', arraySize: LOCAL_LIGHT_LIMIT * 4 }] };
  }
  override bindForSubMesh(buffer: UniformBuffer): void {
    const scene = this._material.getScene();
    let packed = packedFrames.get(scene);
    if (!packed || packed.frame !== scene.getFrameId()) {
      packed = { ...packOriginalLocalLights(scene), frame: scene.getFrameId() };
      packedFrames.set(scene, packed);
    }
    buffer.updateFloat('originalLocalLightCount', packed.count);
    buffer.updateFloatArray('originalLocalLightData', packed.data);
  }
  override getCustomCode(type: string) {
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `fn fabLegacyRangeFalloff(offset: vec3f, range: f32, decay: f32) -> f32 {
  return pow(max(0.0, 1.0-length(offset)/range), select(1.0, decay, decay>0.0));
}`,
      // r128 MeshStandardMaterial uses albedo*(1-metalness) as its Lambert colour,
      // without Babylon's extra dielectric-F0 subtraction from that diffuse term.
      '!outParams.surfaceAlbedo=baseColor\\.rgb\\*\\(vec3f\\(1\\.0\\)-vec3f\\(dielectricF0\\)\\*surfaceReflectivityColor\\)\\*\\(1\\.0-outParams.metallic\\);':
        'outParams.surfaceAlbedo=baseColor.rgb*(1.0-outParams.metallic);',
      // Local lights are evaluated once below. The two native slots are reserved
      // for key/fill; a diagnostic scene containing only points must not double them.
      '!preInfo.attenuation=computeDistanceLightFalloff_Standard\\(preInfo.lightOffset,light(\\d+)\\.vLightFalloff.x\\);':
        'preInfo.attenuation=0.0;',
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifndef UNLIT
var originalDiffuse = vec3f(0.0);
var originalSpecular = vec3f(0.0);
for (var i = 0u; i < u32(uniforms.originalLocalLightCount); i = i + 1u) {
  let positionRange = uniforms.originalLocalLightData[i*4u];
  let colour = uniforms.originalLocalLightData[i*4u+1u].rgb;
  let directionDecay = uniforms.originalLocalLightData[i*4u+2u];
  let cone = uniforms.originalLocalLightData[i*4u+3u];
  var localInfo = computePointAndSpotPreLightingInfo(vec4f(positionRange.xyz,0.0),viewDirectionW,normalW,fragmentInputs.vPositionW);
  localInfo.NdotV = NdotV; localInfo.roughness = roughness;
  localInfo.diffuseRoughness = diffuseRoughness; localInfo.surfaceAlbedo = surfaceAlbedo;
  localInfo.attenuation = fabLegacyRangeFalloff(localInfo.lightOffset,positionRange.w,directionDecay.w);
  if (cone.z > 0.5) {
    localInfo.attenuation *= smoothstep(cone.x,cone.y,dot(-directionDecay.xyz,localInfo.L));
  }
  originalDiffuse += computeDiffuseLighting(localInfo,colour);
#ifdef SPECULARTERM
  let localFresnel = fresnelSchlickGGXVec3(localInfo.VdotH,reflectivityOut.colorReflectanceF0,reflectivityOut.colorReflectanceF90);
  originalSpecular += computeSpecularLighting(localInfo,normalW,reflectivityOut.colorReflectanceF0,localFresnel,AARoughnessFactors.x,colour);
#endif
}
finalDiffuse += originalDiffuse*surfaceAlbedo.rgb*uniforms.vLightingIntensity.x*ambientOcclusionForDirectDiffuse;
#ifdef SPECULARTERM
finalSpecularScaled += originalSpecular*uniforms.vLightingIntensity.x*uniforms.vLightingIntensity.w;
#endif
#endif`,
      '!rgb=toGammaSpaceVec3\\(rgb\\);': 'rgb=rgb;',
      '!fog=toLinearSpace\\(fog\\);': 'fog=fog;',
      '!return max\\(0\\.,1\\.0-length\\(lightOffset\\)/range\\);':
        'let originalRangeFalloff = max(0., 1.0-length(lightOffset)/range); return originalRangeFalloff*originalRangeFalloff;',
      '!falloff=max\\(0\\.,pow\\(cosAngle,exponent\\)\\);':
        'falloff=smoothstep(cosHalfAngle, cos(acos(cosHalfAngle)*0.55), cosAngle);',
    };
  }
}
