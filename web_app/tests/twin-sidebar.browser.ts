// @ts-nocheck — real UI contract; invoked with the connected-tab transport.
import assert from 'node:assert/strict';
export async function runOriginalSidebarAcceptance(command) {
  const evaluate=async expression=>{
    const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);
    return r.result.value;
  };
  const until=async expression=>{const end=Date.now()+15000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Missing original sidebar behavior: '+expression)};
  await command('Page.navigate', { url: 'http://127.0.0.1:5173/twin?lang=en' });
  await until(`!!document.querySelector('#sidebar-tab-fab')`);
  await until(`document.querySelector('#tab-count-fab')?.textContent === '67'`);
  assert.equal(await evaluate(`!!document.querySelector('#sidebar-tab-fab')`),true,'original FAB/OEM tabs must exist');
  assert.equal(await evaluate(`document.querySelector('#tab-count-fab').textContent`),'67','preserve the original bootstrap badge until Scenario application');
  assert.equal(await evaluate(`document.querySelectorAll('#equipment-list [data-equipment-id]').length`),18);
  await evaluate(`document.querySelector('#sidebar-tab-oem').click()`);
  await until(`document.querySelectorAll('#equipment-list [data-oem-id]').length===116`);
  assert.equal(await evaluate(`document.querySelector('[data-equipment-id="subfab.litho.laser.1"]')!==null`),false);
  await evaluate(`document.querySelector('[data-segment="Lithography"]').click()`);
  await until(`document.querySelectorAll('#equipment-list [data-oem-id]').length===16`);
  await evaluate(`(()=>{const i=document.querySelector('#search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'NXT:2050i');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until(`document.querySelectorAll('#equipment-list [data-oem-id]').length===1`);
  await evaluate(`document.querySelector('#sidebar-oem-eq_db_001').click()`);
  await until(`document.querySelector('#inspect-name')?.textContent==='ASML TWINSCAN NXT:2050i'`);
  assert.equal(await evaluate(`location.pathname`),'/twin','OEM browsing must remain in the same page');
  await evaluate(`document.querySelector('#sidebar-tab-fab').click()`);
  await until(`document.querySelectorAll('#equipment-list [data-equipment-id]').length===18`);
  assert.equal(await evaluate(`document.querySelector('#search-input').value`),'');
  await evaluate(`document.querySelector('[data-category="facility"]').click()`);
  await until(`document.querySelectorAll('#equipment-list [data-equipment-id]').length===2`);
  await evaluate(`document.querySelector('[data-category="ALL"]').click()`);
  await evaluate(`document.getElementById('sidebar-item-2c8ee49e-b417-50be-a642-6fe000760c2a').click()`);
  await until(`document.querySelector('#inspect-name')?.textContent==='Ebara F-REX300'`);
  for(const id of ['inspect-brand','inspect-model','inspect-dimensions','inspect-weight','line-art-svg-container','inspect-specs','inspect-source-card','telemetry-sensors-grid','mes-job-state-badge','spc-status-badge'])assert.equal(await evaluate(`!!document.getElementById(${JSON.stringify(id)})`),true,id);
  return {directory:18,oem:116,sourceBadge:67,search:true,category:true,inPageOem:true,inspectorFields:true};
}
