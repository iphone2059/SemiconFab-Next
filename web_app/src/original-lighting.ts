import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';

/** Original r128: physicallyCorrectLights=false, decay=2, LinearEncoding.
 * Babylon still emits a gamma conversion with imageProcessing.isEnabled=false;
 * bypass it for these source materials and retain the original fog factor.
 */
export class OriginalLegacyLightFalloff extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, 'OriginalLegacyLightFalloff', 150, {}, true, true);
    material.usePhysicalLightFalloff = false;
  }
  override isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  override getCustomCode(type: string) {
    if (type !== 'fragment') return null;
    return {
      '!rgb=toGammaSpaceVec3\\(rgb\\);': 'rgb=rgb;',
      '!fog=toLinearSpace\\(fog\\);': 'fog=fog;',
      '!return max\\(0\\.,1\\.0-length\\(lightOffset\\)/range\\);':
        'let originalRangeFalloff = max(0., 1.0-length(lightOffset)/range); return originalRangeFalloff*originalRangeFalloff;',
      '!falloff=max\\(0\\.,pow\\(cosAngle,exponent\\)\\);':
        'falloff=smoothstep(cosHalfAngle, cos(acos(cosHalfAngle)*0.55), cosAngle);',
    };
  }
}
