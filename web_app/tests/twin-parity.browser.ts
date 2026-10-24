// @ts-nocheck — real browser acceptance through a supplied connected-tab CDP transport.
import assert from 'node:assert/strict';

function evaluator(command) {
  return async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
}

export async function attachTwinScene(command) {
  const evaluate = evaluator(command);
  return evaluate(`(async () => {
    const entry = performance.getEntriesByType('resource').findLast(r => r.name.includes('@babylonjs_core_Engines_webgpuEngine.js'))?.name;
    if (!entry) throw new Error('Wait for the Twin WebGPU scene to load');
    const source = await (await fetch(entry)).text();
    const path = source.match(/import \\{[^}]* as EngineStore[^}]*\\} from "([^"]+)"/)[1];
    const exports = await import(new URL(path, entry).href);
    const store = Object.values(exports).find(value => typeof value === 'function' && 'LastCreatedScene' in value);
    window.__twinAcceptanceScene = store.LastCreatedScene;
    const scene = __twinAcceptanceScene;
    if (!scene?.metadata?.staticShadows) throw new Error('The native WebGPU shadow scene is not ready');
    return { engine: scene.getEngine().getClassName(), meshes: scene.meshes.length, shadows: scene.metadata.staticShadows.stats };
  })()`);
}

export async function runTwinGeometryAcceptance(command, originalTools) {
  await attachTwinScene(command);
  const evaluate = evaluator(command);
  const actual = await evaluate(`(()=>{const scene=__twinAcceptanceScene;return Array.from({length:121},(_,index)=>{const group=scene.getTransformNodeByName('procedural-tool-'+index);const bounds=group.getHierarchyBoundingVectors(true,mesh=>group.metadata.recordId&&(!mesh.name.startsWith('status-')||[52,70,98,99].includes(index)));return {index,id:group.metadata.recordId,position:group.position.asArray(),rotation:group.rotation.y,min:bounds.min.asArray(),max:bounds.max.asArray()}})})()`);
  assert.equal(actual.length,121); assert.equal(originalTools.length,121);
  let maxBoundsError=0;
  for(const original of originalTools){
    const current=actual[original.layoutIndex]; assert.equal(current.id,original.id);
    assert.ok(Math.abs(current.rotation-original.rotation)<1e-8);
    for(let axis=0;axis<3;axis++){
      assert.ok(Math.abs(current.position[axis]-original.position[axis])<1e-8);
      for(const bound of ['min','max'])maxBoundsError=Math.max(maxBoundsError,Math.abs(current[bound][axis]-original[bound][axis]));
    }
  }
  assert.ok(maxBoundsError<0.00001,'all rendered bounds must reproduce the original');
  return {tools:121,identities:true,positions:true,rotations:true,maxBoundsErrorMetres:maxBoundsError};
}

export async function runTwinGestureAcceptance(command) {
  await attachTwinScene(command);
  const evaluate = evaluator(command);
  const initial = await evaluate(`(() => {
    const camera = __twinAcceptanceScene.activeCamera;
    const rect = document.querySelector('.scene canvas').getBoundingClientRect();
    return { radius: camera.radius, x: rect.x + rect.width * .55, y: rect.y + rect.height * .5, pageScale: visualViewport.scale };
  })()`);
  try {
    const wheel = await evaluate(`(async () => {
      const camera = __twinAcceptanceScene.activeCamera;
      const canvas = document.querySelector('.scene canvas');
      const before = camera.radius;
      const inward = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -80 });
      canvas.dispatchEvent(inward);
      await new Promise(requestAnimationFrame);
      const enlarged = camera.radius;
      const outward = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 80 });
      canvas.dispatchEvent(outward);
      await new Promise(requestAnimationFrame);
      return { before, enlarged, reduced: camera.radius, inwardPrevented: inward.defaultPrevented, outwardPrevented: outward.defaultPrevented, pageScale: visualViewport.scale };
    })()`);
    assert.ok(wheel.inwardPrevented && wheel.outwardPrevented, 'trackpad pinch must not zoom the web page');
    assert.ok(wheel.enlarged < wheel.before, 'pinch out must enlarge the scene');
    assert.ok(wheel.reduced > wheel.enlarged, 'pinch in must reduce the scene');
    assert.equal(wheel.pageScale, initial.pageScale);
    assert.ok(Math.abs(wheel.reduced - wheel.before) < 0.001, 'the wheel event must not be consumed twice');

    await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const touch = async (type, spread) => command('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [
        { id: 0, x: initial.x - spread, y: initial.y, radiusX: 3, radiusY: 3, force: 1 },
        { id: 1, x: initial.x + spread, y: initial.y, radiusX: 3, radiusY: 3, force: 1 },
      ],
    });
    await touch('touchStart', 50);
    await touch('touchMove', 60);
    await touch('touchMove', 90);
    await touch('touchMove', 120);
    await touch('touchEnd', 0);
    const afterTouch = await evaluate(`(async () => { for(let i=0;i<8;i++) await new Promise(requestAnimationFrame); return __twinAcceptanceScene.activeCamera.radius; })()`);
    assert.ok(afterTouch < wheel.reduced - 0.5, 'two actual touch contacts must change the camera radius');
    return { wheel, touch: { before: wheel.reduced, after: afterTouch }, pageScale: initial.pageScale };
  } finally {
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await evaluate(`__twinAcceptanceScene.activeCamera.radius = ${initial.radius}; __twinAcceptanceScene.activeCamera.inertialRadiusOffset = 0;`);
  }
}

export async function runTwinCameraAcceptance(command) {
  await attachTwinScene(command);
  const evaluate = evaluator(command);
  const actual = async () => {
    await new Promise(resolve => setTimeout(resolve, 1250));
    return evaluate(`(()=>{const c=__twinAcceptanceScene.activeCamera;return {position:c.position.asArray(),target:c.target.asArray()}})()`);
  };
  const check = (pose, position, target) => {
    for (let i=0;i<3;i++) { assert.ok(Math.abs(pose.position[i]-position[i])<0.001, 'original preset position'); assert.ok(Math.abs(pose.target[i]-target[i])<0.001, 'original preset target'); }
  };
  const poses={iso:await actual()};
  check(poses.iso,[38,48,58],[0,0,0]);
  for (const [label,position,target] of [['Top',[0,95,.1],[0,0,0]],['Litho',[-21,3.6,-12.5],[-30,1.8,-22]],['Airlock',[-12.5,4.2,7.5],[-16.5,1.5,3]]]) {
    await evaluate(`document.querySelector('button[aria-label="${label}"]').click()`);
    poses[label]=await actual(); check(poses[label],position,target);
  }
  await evaluate(`document.querySelector('button[aria-label="ISO"]').click()`);
  await actual();
  return poses;
}

export async function runCutShadowAcceptance(command) {
  await attachTwinScene(command);
  const evaluate = evaluator(command);
  await evaluate(`window.__readTwinDepth = async () => {
    const scene = __twinAcceptanceScene;
    const engine = scene.getEngine();
    const texture = scene.textures.find(t => t.name === 'FAB native shadow depth').getInternalTexture()._hardwareTexture.underlyingResource;
    const device = engine._device;
    const size = 2048;
    const buffer = device.createBuffer({ size: size*size*4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer, bytesPerRow: size*4, rowsPerImage: size }, [size,size]);
      device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(buffer.getMappedRange());
      let covered = 0, sum = 0;
      for (const value of values) if (value < 1) { covered++; sum += value; }
      return { covered, sum, passes: scene.metadata.staticShadows.stats.passes, enabled: scene.metadata.staticShadows.enabled, plane: scene.metadata.staticShadows.stats.clipPlane };
    } finally { buffer.destroy(); }
  }`);
  const frames = () => evaluate(`(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)})()`);
  try {
    await evaluate(`if(document.querySelector('.twin-cut-toggle')?.getAttribute('aria-pressed')==='true') document.querySelector('.twin-cut-toggle').click()`);
    await frames();
    const initial = await evaluate(`__readTwinDepth()`);
    await evaluate(`document.querySelector('.twin-cut-toggle').click()`); await frames();
    const clipped = await evaluate(`__readTwinDepth()`);
    assert.equal(clipped.enabled, true, 'Cut must keep real native shadows enabled');
    assert.equal(JSON.stringify(clipped.plane), '[1,0,0,0]');
    assert.ok(clipped.covered < initial.covered - 1000, 'the actual depth texture must exclude clipped caster fragments');
    assert.ok(clipped.passes > initial.passes);
    const contrast = await evaluate(`(async()=>{
      const s=__twinAcceptanceScene, e=s.getEngine(), shadow=s.metadata.staticShadows;
      const w=e.getRenderWidth(),h=e.getRenderHeight();
      const frame=async()=>{for(let i=0;i<4;i++)await new Promise(requestAnimationFrame)};
      shadow.enabled=true;await frame();const a=await e.readPixels(0,0,w,h);
      shadow.enabled=false;await frame();const b=await e.readPixels(0,0,w,h);
      shadow.enabled=true;await frame();let darkened=0;
      for(let i=0;i<a.length;i+=4)if(b[i]+b[i+1]+b[i+2]-a[i]-a[i+1]-a[i+2]>24)darkened++;
      return {darkened,width:w,height:h};
    })()`);
    assert.ok(contrast.darkened > 1000, 'native shadow contrast must remain visible on the uncut floor');
    await evaluate(`document.querySelector('.twin-cut-toggle').click()`); await frames();
    const restored = await evaluate(`__readTwinDepth()`);
    assert.equal(JSON.stringify(restored.plane), '[0,0,0,0]');
    assert.equal(restored.covered, initial.covered, 'leaving Cut must restore the original static depth');
    return { initial, clipped, restored, contrast };
  } finally {
    await evaluate(`if(document.querySelector('.twin-cut-toggle')?.getAttribute('aria-pressed')==='true')document.querySelector('.twin-cut-toggle').click();__twinAcceptanceScene.metadata.staticShadows.enabled=true;delete window.__readTwinDepth`);
  }
}

export async function runDeviceLossAcceptance(command) {
  await attachTwinScene(command);
  const evaluate = evaluator(command);
  return evaluate(`(async()=>{
    const scene=__twinAcceptanceScene,engine=scene.getEngine(),oldDevice=engine._device;
    const errors=[];
    let restoredDevice;
    const onError=event=>errors.push(event.error.message);
    const restoredObserver=engine.onContextRestoredObservable.add(()=>{restoredDevice=engine._device;restoredDevice.addEventListener('uncapturederror',onError)});
    const history=[];
    const element=document.querySelector('.twin-status');
    const observe=new MutationObserver(()=>history.push({t:performance.now(),status:element.getAttribute('title')??element.textContent}));
    observe.observe(element,{subtree:true,childList:true,characterData:true,attributes:true});
    const started=performance.now(),before=scene.metadata.staticShadows.stats.passes;
    const camera=scene.activeCamera;
    camera.radius*=0.83;camera.target.x+=3;camera.inertialRadiusOffset=0;
    const beforePose=[camera.alpha,camera.beta,camera.radius,...camera.target.asArray()];
    try{
      oldDevice.destroy();
      const deadline=performance.now()+45000;
      while(performance.now()<deadline){
        const status=element.getAttribute('title')??element.textContent;
        if(engine._device!==oldDevice&&status.startsWith('WebGPU 设备和')&&status.includes('首帧完成')&&scene.metadata.staticShadows.stats.passes>before&&scene.metadata.staticShadows.readyForCurrentDevice){
          await new Promise(resolve=>setTimeout(resolve,1200));
          const afterPose=[camera.alpha,camera.beta,camera.radius,...camera.target.asArray()];
          const cameraDelta=Math.max(...afterPose.map((value,index)=>Math.abs(value-beforePose[index])));
          if(cameraDelta>0.0001)throw new Error('Device restoration reset the user camera pose: '+cameraDelta);
          if(errors.length)throw new Error('Recovered device validation errors: '+JSON.stringify(errors));
          // Acquire the current presentation frame; a timeout can otherwise
          // leave readPixels referring to an already-presented swap texture.
          await new Promise(requestAnimationFrame);
          const pixels=await engine.readPixels(Math.floor(engine.getRenderWidth()/2)-32,Math.floor(engine.getRenderHeight()/2)-32,64,64);
          if(!pixels?.length)throw new Error('Restored first frame has no GPU readback');
          await engine._device.queue.onSubmittedWorkDone();
          if(errors.length)throw new Error('Recovered device/readback validation errors: '+JSON.stringify(errors));
          return {recovered:true,elapsedMs:performance.now()-started,newDevice:true,completedStatus:status,before,after:scene.metadata.staticShadows.stats,cameraDelta,errors,readbackBytes:pixels.length,history};
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('Real GPUDevice.destroy() did not produce a completed restored first frame: '+JSON.stringify(history));
    }finally{observe.disconnect();engine.onContextRestoredObservable.remove(restoredObserver);restoredDevice?.removeEventListener('uncapturederror',onError)}
  })()`);
}
