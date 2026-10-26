// @ts-nocheck — compare actual frozen Next scene output with the native Lite preview.
import fs from 'node:fs';
import assert from 'node:assert/strict';
export async function runLiteLayoutParityAcceptance(command, baseUrl) {
  const referenceUrl = process.env.NEXT_REFERENCE_URL ?? 'http://127.0.0.1:5176';
  const directory = process.env.LITE_EVIDENCE_DIR;
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, label) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const result = await evaluate(expression);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + label);
  }
  const hideHud = `(()=>{const canvas=document.querySelector('canvas');for(const node of document.body.querySelectorAll('*'))if(node!==canvas&&!node.contains(canvas))node.style.setProperty('visibility','hidden','important')})()`;
  const views = [
    { name: 'iso', selector: 'button[aria-label="ISO"]', action: '' },
    { name: 'top', selector: 'button[aria-label="Top"]', action: '__liteAcceptance.topView()' },
    ...['l1', 'b1', 'dual'].map(name => ({ name, selector: '#level-btn-' + name, action: `__liteAcceptance.structureView('${name}')` })),
  ];
  const results = [];
  for (const view of views) {
  await command('Page.navigate', { url: referenceUrl + '/twin?lang=zh-CN&mode=engineer&parity=1&perf=1' });
  await until(`window.__SEMICONFAB_PERF__?.getScene() && document.querySelector('.twin-status')?.title?.startsWith('WebGPU ·')`, 'frozen Next WebGPU');
  await evaluate(`document.querySelector(${JSON.stringify(view.selector)}).click()`);
  await evaluate('__twinGoldenClock.step(180)');
  const reference = await evaluate(`(()=>{
    const scene=__SEMICONFAB_PERF__.getScene(), camera=scene.activeCamera, engine=__SEMICONFAB_PERF__.getEngine();
    const bounds=vertices=>({min:[0,1,2].map(a=>Math.min(...vertices.map(p=>p[a]))),max:[0,1,2].map(a=>Math.max(...vertices.map(p=>p[a])))});
    const vertices=meshes=>meshes.flatMap(mesh=>{
      const positions=mesh.getVerticesData('position'); if(!positions)return [];
      const m=mesh.computeWorldMatrix(true).asArray(),out=[];
      for(let i=0;i<positions.length;i+=3)out.push([0,1,2].map(a=>m[a]*positions[i]+m[a+4]*positions[i+1]+m[a+8]*positions[i+2]+m[a+12]));
      return out;
    });
    const groups=scene.transformNodes.filter(n=>/^procedural-tool-\\d+$/.test(n.name)).sort((a,b)=>a.metadata.toolIndex-b.metadata.toolIndex);
    const tools=groups.map(group=>{const points=vertices(group.getChildMeshes());return {instanceId:'FAB-01/tool-'+String(group.metadata.toolIndex+1).padStart(3,'0'),recordId:group.metadata.recordId,vertices:points,bounds:bounds(points)}});
    const yellow=scene.meshes.filter(mesh=>mesh.name==='native-zone-0'||mesh.name.startsWith('original-amber-panel-')).map(mesh=>{const points=vertices([mesh]);return {name:mesh.name,vertices:points,bounds:bounds(points)}});
    const canvas=engine.getRenderingCanvas(),r=canvas.getBoundingClientRect();
    return {tools,yellow,viewProjection:Array.from(scene.getTransformMatrix().asArray()),camera:{position:camera.position.asArray(),target:camera.target.asArray(),fov:camera.fov},
      floorAlpha:scene.getMeshByName('procedural-floor').material.alpha,slabVisible:scene.getMeshByName('procedural-slab').isEnabled(),
      viewport:{width:engine.getRenderWidth(),height:engine.getRenderHeight()},clip:{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}};
  })()`);
  assert.equal(reference.tools.length, 121);
  assert.equal(reference.yellow.length, 56);
  await evaluate(hideHud);
  const oldImage = await command('Page.captureScreenshot', { format: 'png', clip: reference.clip });
  if (directory) fs.writeFileSync(directory + `/layout-next-${view.name}.png`, Buffer.from(oldImage.data, 'base64'));
  await command('Page.navigate', { url: baseUrl + '/?scene=structure' });
  await until(`window.__liteAcceptance?.snapshot().status==='ready'`, 'Lite preview');
  if (view.action) await evaluate(view.action);
  await evaluate(`(()=>{const canvas=document.querySelector('canvas');canvas.style.width='${reference.clip.width}px';canvas.style.height='${reference.clip.height}px'})()`);
  await evaluate(hideHud);
  const before = await evaluate('__liteAcceptance.snapshot().frames');
  await until(`__liteAcceptance.snapshot().frames>${before + 3}`, 'matching viewport');
  const lite = await evaluate('__liteAcceptance.inspectLayout()');
  const image = await command('Page.captureScreenshot', { format: 'png', clip: { ...reference.clip, x: 0, y: 0 } });
  if (directory) fs.writeFileSync(directory + `/layout-lite-${view.name}.png`, Buffer.from(image.data, 'base64'));
  const state = await evaluate('__liteAcceptance.snapshot()');
  assert.equal(state.structure.floorAlpha, reference.floorAlpha, view.name + ':floor opacity');
  assert.equal(state.structure.slabVisible, reference.slabVisible, view.name + ':slab visibility');
  assert.equal(state.equipment.visible, true, view.name + ':L1 equipment retained');
  function project(point, m, viewport) {
    const clip = [0,1,2,3].map(a => m[a]*point[0]+m[a+4]*point[1]+m[a+8]*point[2]+m[a+12]);
    return [(clip[0]/clip[3]*.5+.5)*viewport.width, (.5-clip[1]/clip[3]*.5)*viewport.height];
  }
  function screenBounds(row, side) {
    const points = row.vertices.map(point => project(point, side.viewProjection, side.viewport));
    return [...[0,1].map(a=>Math.min(...points.map(p=>p[a]))),...[0,1].map(a=>Math.max(...points.map(p=>p[a])))];
  }
  const differences = [];
  for (const [key, id] of [['tools','instanceId'],['yellow','name']]) {
    assert.equal(lite[key].length, reference[key].length);
    for (const original of reference[key]) {
      const current = lite[key].find(row=>row[id]===original[id]);
      assert.ok(current, `Missing ${key} ${original[id]}`);
      if (key === 'tools') assert.equal(current.recordId, original.recordId, original.instanceId + ':record');
      const sourceBounds=screenBounds(original,reference),liteBounds=screenBounds(current,lite);
      differences.push({ kind:key,id:original[id],source:sourceBounds,lite:liteBounds,
        maxPixels:Math.max(...sourceBounds.map((value,a)=>Math.abs(value-liteBounds[a]))) });
    }
  }
  const maxPixels=Math.max(...differences.map(row=>row.maxPixels));
  const result={view:view.name,referenceCamera:reference.camera,liteCamera:lite.camera,referenceViewport:reference.viewport,liteViewport:lite.viewport,
    tools:reference.tools.length,yellow:reference.yellow.length,maxPixels,differences};
  assert.ok(Number.isFinite(maxPixels) && maxPixels<=0.1,`${view.name}: layout screen bounds differ by ${maxPixels.toFixed(2)} px`);
  results.push(result);
  console.log(`Lite layout ${view.name}: ${reference.tools.length} tools + ${reference.yellow.length} yellow surfaces, max ${maxPixels.toFixed(6)} px`);
  }
  const result = {status:'PASS',views:results,maxPixels:Math.max(...results.map(row=>row.maxPixels))};
  if(directory)fs.writeFileSync(directory+'/layout-projection.json',JSON.stringify(result,null,2)+'\n');
  return result;
}
