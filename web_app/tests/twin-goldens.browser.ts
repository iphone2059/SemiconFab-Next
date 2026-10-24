// @ts-nocheck — reference-only browser capture. Never imported by the product.
// Original uses its own renderer; Next must still identify as WebGPU.
export const GOLDEN_SETTINGS = { width: 1536, height: 735, devicePixelRatio: 2, seed: 20261024, language: 'zh-CN', virtualFrameMs: 1000 / 60 };

export const GOLDEN_CLOCK = `(() => {
  let seed=20261024, now=0, nextId=1;
  const callbacks=new Map();
  Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  Date.now=()=>1792800000000;
  Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
  window.requestAnimationFrame=callback=>{const id=nextId++;callbacks.set(id,callback);return id};
  window.cancelAnimationFrame=id=>callbacks.delete(id);
  window.__twinGoldenClock={step:async(frames=1)=>{for(let i=0;i<frames;i++){now+=1000/60;const batch=[...callbacks.values()];callbacks.clear();for(const callback of batch)callback(now);await new Promise(resolve=>setTimeout(resolve,0))}},get timeMs(){return now}};
  localStorage.setItem('semiconfab_lang','zh-CN');
  localStorage.setItem('semicon_lang','zh');
  localStorage.setItem('semicon_twin_onboarding_dismissed','1');
})()`;

export const GOLDEN_CASES = [
  { id: 'iso', original: `setCameraPreset('iso')`, next: `document.querySelector('button[aria-label="ISO"]').click()` },
  { id: 'top', original: `setCameraPreset('top')`, next: `document.querySelector('button[aria-label="Top"]').click()` },
  { id: 'litho', original: `setCameraPreset('litho')`, next: `document.querySelector('button[aria-label="Litho"]').click()` },
  { id: 'b1', original: `switchFabLevel('B1')`, next: `document.querySelector('#level-btn-b1').click()` },
  { id: 'cut', original: `toggleSpatialMode('cut');setCutAxis('X');onCutSliderChange(0)`, next: `document.querySelector('#btn-toggle-cut').click()` },
  { id: 'xray', original: `toggleSpatialMode('xray');setXRayFilter('ALL')`, next: `document.querySelector('#btn-toggle-xray').click()` },
  { id: 'research', original: `switchEntryMode('research');await initResearchReplayEngine();onScrubInput(1000000)`, next: `select('mode-select','research');await waitFor(()=>document.querySelector('.twin-research-scrubber'));input('.twin-research-scrubber',1000000)` },
  { id: 'wafer', original: `await toggleWaferFollowPanel()`, next: `document.querySelector('#btn-follow-wafer').click();await waitFor(()=>document.querySelector('.twin-wafer-scrubber'))` },
  { id: 'mes', original: `selectEquipment('2c8ee49e-b417-50be-a642-6fe000760c2a',false);document.querySelector('#mes-job-state-badge').closest('.glass-card').scrollIntoView({block:'center',behavior:'instant'})`, next: `document.querySelector('#sidebar-item-2c8ee49e-b417-50be-a642-6fe000760c2a').click();await __twinGoldenClock.step(3);document.querySelector('.twin-mes').scrollIntoView({block:'center',behavior:'instant'})` },
  { id: 'spc', original: `selectEquipment('2c8ee49e-b417-50be-a642-6fe000760c2a',false);document.querySelector('#spc-status-badge').closest('.glass-card').scrollIntoView({block:'center',behavior:'instant'})`, next: `document.querySelector('#sidebar-item-2c8ee49e-b417-50be-a642-6fe000760c2a').click();await __twinGoldenClock.step(3);document.querySelector('.twin-spc').scrollIntoView({block:'center',behavior:'instant'})` },
  { id: 'yms', original: `toggleWaferMapModal(true);selectDefectPattern('clean')`, next: `document.querySelector('.twin-yms-toggle').click()` },
];

export async function goldenEvaluate(command, expression) {
  const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
  return result.result.value;
}

export async function waitForGoldenReady(command, side) {
  const condition = side === 'original' ? `typeof draftStackLightGroups!=='undefined'&&draftStackLightGroups.length===117`
    : `document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')`;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    if(await goldenEvaluate(command,condition)){
      await goldenEvaluate(command,`document.fonts.ready`);
      await goldenEvaluate(command,`__twinGoldenClock.step(180)`);
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Golden page did not initialize: '+side);
}

export async function prepareGoldenCase(command, side, entry) {
  const helpers = `
    const waitFor=async(test)=>{for(let i=0;i<200;i++){if(test())return;await __twinGoldenClock.step(1);await new Promise(r=>setTimeout(r,20))}throw new Error('Golden control did not appear')};
    const select=(id,value)=>{const node=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('change',{bubbles:true}))};
    const input=(selector,value)=>{const node=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,String(value));node.dispatchEvent(new Event('input',{bubbles:true}))};
  `;
  const reset = side === 'original' ? `
    stopCinematicTour();closeWaferFollow(false);dismissOnboarding(false);
    if(currentSpatialMode)toggleSpatialMode(currentSpatialMode);
    switchEntryMode('engineer');switchFabLevel('L1');closeInspector();
    toggleWaferMapModal(false);if(!document.getElementById('yield-waterfall-panel').classList.contains('hidden'))toggleYieldWaterfall();
    isSimulating=false;if(simInterval){clearInterval(simInterval);simInterval=null}updateSimPlayButtonUI();
    setCameraPreset('iso');
  ` : `
    select('mode-select','engineer');await __twinGoldenClock.step(2);
    document.querySelector('.twin-onboarding-head button')?.click();
    document.querySelector('.twin-wafer-head button')?.click();
    document.querySelector('.twin-yms-close')?.click();
    if(document.querySelector('#btn-cinematic-tour').getAttribute('aria-pressed')==='true')document.querySelector('#btn-cinematic-tour').click();
    document.querySelector('#level-btn-l1').click();
    document.querySelector('.twin-inspector button[aria-label="关闭设备详情"]')?.click();
    if(document.querySelector('#btn-sim-play').getAttribute('aria-pressed')==='true')document.querySelector('#btn-sim-play').click();
    document.querySelector('button[aria-label="ISO"]').click();
  `;
  await goldenEvaluate(command,`(async()=>{${helpers}${reset}await __twinGoldenClock.step(180);${entry[side]};await __twinGoldenClock.step(180);})()`);
  return goldenEvaluate(command,`(()=>{
    const box=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,fontSize:s.fontSize,fontFamily:s.fontFamily,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,zIndex:s.zIndex,disabled:!!element.disabled,text:element.textContent.trim().slice(0,350),title:element.getAttribute('title'),ariaLabel:element.getAttribute('aria-label')}};
    const ids=[...document.querySelectorAll('[id]')].map(element=>({id:element.id,...box(element)}));
    const interactive=[...document.querySelectorAll('button,input,select,a,[onclick]')].map(element=>({tag:element.tagName,id:element.id,event:element.getAttribute('onclick'),...box(element)}));
    return {case:${JSON.stringify(entry.id)},side:${JSON.stringify(side)},url:location.href,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},clockMs:__twinGoldenClock.timeMs,language:document.documentElement.lang,ids,interactive,visibleText:document.body.innerText};
  })()`);
}
