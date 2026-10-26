// @ts-nocheck — material response sampled from frozen r128, with independent input swatches.
// CPU tests do not compile the WGSL compatibility equations; this production test does.
import assert from 'node:assert/strict';
import { GOLDEN_CLOCK, goldenEvaluate, waitForGoldenReady } from './twin-goldens.browser.ts';
import { decodePng } from './xray-acceptance.browser.ts';

const SWATCH_SETUP = `(async()=>{
 const s=__SEMICONFAB_PERF__.getScene(), engine=s.getEngine(), camera=s.activeCamera;
 const source=s.getMeshByName('procedural-column-0');
 const material=s.getMaterialByName('original-tool-material-1');
 const Lighting=material.pluginManager.getPlugin('OriginalLegacyLightFalloff').constructor;
 const PBR=material.constructor, V=camera.position.constructor, C=material.albedoColor.constructor;
 s.meshes.forEach(m=>m.setEnabled(false));
 s.lights.forEach(l=>l.setEnabled(['native-key','legacy-fill'].includes(l.name)));
 s.metadata.staticShadows.enabled=false;s.fogMode=0;
 camera.setTarget(new V(0,0,0));camera.alpha=Math.PI/2;camera.beta=Math.PI/4;camera.radius=Math.sqrt(72);camera.fov=Math.PI/4;
 const canvas=engine.getRenderingCanvas();document.querySelectorAll('body *').forEach(e=>e.style.setProperty('visibility','hidden','important'));canvas.style.setProperty('visibility','visible','important');
 Object.assign(canvas.style,{visibility:'visible',position:'fixed',left:'0',top:'0',width:'512px',height:'512px',zIndex:'99999'});
 canvas.style.setProperty('width','512px','important');canvas.style.setProperty('height','512px','important');engine.setSize(512,512);
 window.__sourceLightingMeshes=[];
 const specs=[[0xeeeeF5,.22,.38],[0x8c94a3,.22,.38],[0x1e293b,.15,.75],[0xd8e2ec,.92,.18],[0xc77a4d,.5,.35]];
 const meshes=[];
 for(let i=0;i<specs.length;i++){
  const m=source.clone('swatch-'+i,null,true);m.parent=null;m.setEnabled(true);m.position.set((i-2)*1.2,0,0);m.scaling.set(1/.7,.1/10,1/.7);
  const [col,metal,rough]=specs[i];const mat=new PBR('swatch-material-'+i,s);new Lighting(mat);
  mat.albedoColor=C.FromInts(col>>16&255,col>>8&255,col&255);mat.metallic=metal;mat.roughness=rough;mat.directIntensity=Math.PI;mat.ambientColor=C.White();mat.environmentIntensity=0;
  m.material=mat;meshes.push(m);window.__sourceLightingMeshes.push(m);await mat.forceCompilationAsync(m);
 }
 await __twinGoldenClock.step(12); await new Promise(r=>setTimeout(r,250));
 return {specs,ambient:s.ambientColor.asArray(),camera:camera.position.asArray(),output:[engine.getRenderWidth(),engine.getRenderHeight()],lighting:meshes[0].lightSources.map(l=>l.name)};
})()
`;

export async function runLightingAcceptance(command, baseUrl = 'http://127.0.0.1:4173') {
  const evaluate = expression => goldenEvaluate(command, expression);
  const injection = await command('Page.addScriptToEvaluateOnNewDocument', { source: GOLDEN_CLOCK });
  const pixel = async (x = 256) => {
    const shot = await command('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 512, height: 512, scale: 1 } });
    const png = decodePng(Buffer.from(shot.data, 'base64'));
    const at = (253 * png.width + x) * png.channels;
    return Array.from(png.data.slice(at, at + 3));
  };
  const near = (actual, expected, label) => actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= 1, label + ': ' + actual + ' vs ' + expected));
  try {
    await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
    await waitForGoldenReady(command, 'next');
    const statusMaterials = await evaluate(`__SEMICONFAB_PERF__.getScene().materials.filter(m=>m.name.startsWith('native-status-')).map(m=>({name:m.name,sourceResponse:!!m.pluginManager?.getPlugin('OriginalLegacyLightFalloff')}))`);
    assert.ok(statusMaterials.length > 0 && statusMaterials.every(m => m.sourceResponse), 'live status lamps must retain the source material response');
    await evaluate("window.__lightingErrors=[];__SEMICONFAB_PERF__.getEngine()._device.addEventListener('uncapturederror',e=>__lightingErrors.push(e.error.message))");
    const setup = await evaluate(SWATCH_SETUP);
    // Independently rendered by frozen THREE r128, LinearEncoding, no IBL/fog/shadow.
    const expected = [[255,255,255],[152,162,179],[40,54,76],[24,26,27],[140,87,55]];
    const swatches = [];
    for (const [i, x] of [81,169,256,343,431].entries()) {
      const actual = await pixel(x); near(actual, expected[i], 'source material swatch ' + i); swatches.push(actual);
    }
    await evaluate(`(() => {
      const scene=__SEMICONFAB_PERF__.getScene(); scene.lights.forEach(l=>l.setEnabled(false));scene.ambientColor.set(0,0,0);
      const Point=scene.getLightByName('original-litho-amber-0').constructor, V=scene.activeCamera.position.constructor;
      window.__lightingPointClass=Point;
      const centre=window.__sourceLightingMeshes[2].material;centre.albedoColor.set(1,1,1);centre.metallic=0;centre.roughness=1;
      for(let i=0;i<8;i++){const light=new Point('range-control-'+i,new V(1000+i,1000,1000),scene,2);light.range=1;light.intensity=1;}
    })()`);
    const falloff = [];
    for (const [decay, value] of [[1,129],[1.2,112],[1.5,91],[2,64]]) {
      await evaluate(`(async()=>{
        const scene=__SEMICONFAB_PERF__.getScene(),V=scene.activeCamera.position.constructor;
        scene.getLightByName('range-under-test')?.dispose();
        const light=new __lightingPointClass('range-under-test',new V(0,5.05,0),scene,${decay});
        light.range=10;light.intensity=1;
        await __twinGoldenClock.step(8);await new Promise(r=>setTimeout(r,250));
      })()`);
      const actual = await pixel(); near(actual, [value,value,value], 'source decay ' + decay + ' beyond light slot eight');
      falloff.push({ decay, pixel: actual });
    }
    assert.deepEqual(await evaluate('__lightingErrors'), []);
    return { statusMaterials, setup, swatches, falloff, deviceErrors: 0 };
  } finally { await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier }); }
}
