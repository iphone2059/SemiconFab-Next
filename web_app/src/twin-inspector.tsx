import { useEffect, useMemo } from 'react';
import { useTwinLocale } from './twin-i18n';
import { useTwinPageStore, twinPageActions } from './state/twinPageStore';
import { useTwinDemoStore } from './state/twinDemoStore';
import { ORIGINAL_TWIN_UI, localizedEquipment, type TwinSelection } from './original-twin-data';
import type { FabToolState } from './fab-layout';
import { OriginalElevation } from './twin-elevation';
import { applyMesAction, computeSpc, createProcessMesJob, type MesAction, type MesJob } from './process-control';
const STATE_LABEL: Record<FabToolState,{zh:string;en:string;className:string}> = {
  running:{zh:'运行中',en:'Running',className:'state-running'}, idle:{zh:'待料',en:'Idle',className:'state-idle'},
  down:{zh:'告警',en:'Down',className:'state-down'}, maint:{zh:'维保',en:'PM',className:'state-maint'},
};
function findSourceUrl(value: unknown, depth=0): string | undefined {
  if(depth>6||value===null||value===undefined) return undefined;
  if(typeof value==='string') return /^https?:\/\//.test(value)?value:undefined;
  if(Array.isArray(value)){for(const item of value){const found=findSourceUrl(item,depth+1);if(found)return found;}return undefined;}
  if(typeof value==='object'){for(const [key,item] of Object.entries(value)){if(/source|url/i.test(key)){const found=findSourceUrl(item,depth+1);if(found)return found;} } for(const item of Object.values(value)){const found=findSourceUrl(item,depth+1);if(found)return found;}}
  return undefined;
}
export function OriginalInspector({selection,states,onClose,onManualKey,onSelectReference,onSelectOem}:{
  selection:TwinSelection; states:Readonly<Record<string,FabToolState>>; onClose:()=>void;
  onManualKey:(key:string,state:FabToolState)=>void; onSelectReference?:(id:string)=>void; onSelectOem?:(id:string)=>void;
}) {
  const {language,t}=useTwinLocale(); const zh=language==='zh';
  const equipment = selection.kind==='reference' ? localizedEquipment(selection.id,language) ?? ORIGINAL_TWIN_UI.equipment.find(row=>row.id===selection.id) : undefined;
  const oem = selection.kind==='oem' ? ORIGINAL_TWIN_UI.oem.find(row=>row.id===selection.id) : undefined;
  const processEquipment = selection.kind==='reference' ? ORIGINAL_TWIN_UI.equipment.find(row=>row.id===selection.id) : undefined;
  const telemetry = useTwinDemoStore(state=>processEquipment ? state.telemetry[processEquipment.id] : undefined);
  const spc = useMemo(()=>telemetry?computeSpc(telemetry.history,telemetry.sensors[0],(states[equipment?.id??'']??'running')==='down'):undefined,[telemetry,states,equipment?.id]);
  const storedMes=useTwinPageStore(state=>equipment ? state.inspectorMes[equipment.id] : undefined);
  const initialMes=useMemo(()=>processEquipment?createProcessMesJob(processEquipment):undefined,[processEquipment]);
  const mes=storedMes??initialMes;
  useEffect(()=>{if(processEquipment&&initialMes&&!storedMes)twinPageActions.inspectorMesSet({id:processEquipment.id,job:initialMes});},[processEquipment,initialMes,storedMes]);
  const setMes=(update:(current:MesJob|undefined)=>MesJob|undefined)=>{const job=update(mes)??mes;if(equipment&&job)twinPageActions.inspectorMesSet({id:equipment.id,job});};
  if(selection.kind==='layout')return null;
  if(selection.kind==='oem'&&oem) {
    return <aside className="twin-inspector original-inspector" aria-label={t('设备详情')}>
      <div className="twin-panel-title"><span>OEM CATALOG · {oem.id}</span><button type="button" aria-label={t('关闭设备详情')} onClick={onClose}>×</button></div>
      <h2 id="inspect-name">{oem.vendor} {oem.model}</h2>
      <h3>{oem.segment}</h3>
      <span className="twin-chip">{oem.process_node}</span><span className="twin-chip">{oem.wafer_size}</span>
      <dl>
        <dt>{t('厂商')}</dt><dd id="inspect-brand">{oem.vendor}</dd>
        <dt>{t('型号')}</dt><dd id="inspect-model">{oem.model}</dd>
        <dt>{t('尺寸')}</dt><dd id="inspect-dimensions">{oem.dimensions}</dd>
        <dt>{t('重量')}</dt><dd id="inspect-weight">{oem.weight}</dd>
        <dt>{t('来源等级')}</dt><dd>{oem.source_tier}</dd>
      </dl>
      <section id="inspect-specs" className="twin-process"><div className="twin-process-head"><strong>KEY SPECS</strong></div><p>{oem.key_specs}</p><p>{oem.notes}</p></section>
      <section id="inspect-source-card" className="twin-process"><div className="twin-process-head"><strong>SOURCE</strong></div><a href={oem.source_url} target="_blank" rel="noreferrer">{oem.source_url}</a></section>
    </aside>;
  }
  if(!equipment) return null;
  const state=states[equipment.id]??'running'; const stateStyle=STATE_LABEL[state];
  const catalog=(equipment.catalogRecord?.record??{}) as {physical?:Record<string,{value?:unknown;unit?:string;provenance?:{source?:string;tier?:string}}>;process_capability?:{capabilities?:{process?:string;detail?:{value?:string}}[]};notes?:string;record_status?:string;source_tier?:string};
  const weight=catalog.physical?.weight_kg?.value;
  const sourceUrl=equipment.sourceUrl??findSourceUrl(equipment.catalogRecord)??findSourceUrl(catalog);
  const oemMatch=ORIGINAL_TWIN_UI.oem.find(row=>row.inFabId===equipment.id)??ORIGINAL_TWIN_UI.oem.find(row=>row.model===equipment.model);
  const completeness=(equipment.catalogRecord as {completeness_pct?:number}|undefined)?.completeness_pct;
  const capabilities=(catalog.process_capability?.capabilities??[]).map(item=>`${item.process??''}: ${item.detail?.value??''}`).filter(Boolean);
  const act=(action:MesAction)=>setMes(current=>current?applyMesAction(current,action):current);
  return <aside className="twin-inspector original-inspector" aria-label={t('设备详情')}>
    <div className="twin-panel-title"><span>FAB REFERENCE · {equipment.level}</span><button type="button" aria-label={t('关闭设备详情')} onClick={onClose}>×</button></div>
    <h2 id="inspect-name">{equipment.name}</h2>
    <h3>{equipment.model}</h3>
    <span className="twin-chip">{equipment.categoryName}</span><span className={'twin-chip ' + stateStyle.className}>{zh?stateStyle.zh:stateStyle.en}</span>
    <dl>
      <dt>{t('厂商')}</dt><dd id="inspect-brand">{equipment.brand}</dd>
      <dt>{t('型号')}</dt><dd id="inspect-model">{equipment.model}</dd>
      <dt>{t('尺寸 (m)')}</dt><dd id="inspect-dimensions">{equipment.dimensions.width} × {equipment.dimensions.length} × {equipment.dimensions.height}</dd>
      <dt>{t('重量')}</dt><dd id="inspect-weight">{equipment.weight??(weight?`${Number(weight).toLocaleString('en-US')} kg`:'—')}</dd>
      <dt>{t('位置')}</dt><dd>{equipment.bay}</dd>
      <dt>{t('来源等级')}</dt><dd>{equipment.conformance_level??equipment.sourceTier??'—'}</dd>
    </dl>
    <div id="line-art-svg-container" className="twin-elevation"><OriginalElevation id={equipment.id} model={equipment.model} draft={!equipment.catalogRecord}/></div>
    <p className="twin-data-note">{equipment.desc}</p>
    <section id="inspect-specs" className="twin-process"><div className="twin-process-head"><strong>SPECIFICATIONS</strong></div>
      {equipment.specs?Object.entries(equipment.specs).map(([key,value])=><div key={key} className="twin-spec-row"><span>{key}</span><b>{value}</b></div>):null}
      {capabilities.map((text)=><p key={text} className="twin-data-note">{text}</p>)}
      {catalog.notes&&<p className="twin-data-note">{catalog.notes}</p>}
      {!equipment.specs&&!capabilities.length&&<p>{equipment.locationDesc}</p>}
    </section>
    {oemMatch&&<button type="button" className="twin-primary" onClick={()=>onSelectOem?.(oemMatch.id)}>{t('OEM 目录')} · {oemMatch.model}</button>}
    {equipment.connectedTool&&<button type="button" className="twin-primary" onClick={()=>{const target=ORIGINAL_TWIN_UI.equipment.find(row=>row.id===equipment.connectedTool); if(target) onSelectReference?.(target.id);}}>{t('联动设备')} · {equipment.connectedTool}</button>}
    <div className="twin-manual-state" role="group" aria-label={t('设备状态干预')}>
      {(['running','idle','down','maint'] as const).map(value=><button type="button" key={value} aria-pressed={state===value} onClick={()=>onManualKey(equipment.id,value)}>{value.toUpperCase()}</button>)}
    </div>
    <section id="inspect-source-card" className="twin-process"><div className="twin-process-head"><strong>SOURCE</strong><span>{equipment.conformance_level??catalog.record_status??''}</span></div><p>{equipment.locationDesc??`${equipment.bay} · ${equipment.level}`}</p>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noreferrer">{sourceUrl}</a>}<div className="twin-spec-row"><span>{t('完整度')}</span><b>{completeness===undefined?'—':`${completeness}%`}</b></div><div className="twin-spec-row"><span>{t('记录状态')}</span><b>{catalog.record_status??'—'}</b></div></section>
    {telemetry&&mes&&spc&&<>
      <section id="telemetry-sensors-grid" className="twin-process"><div className="twin-process-head"><strong>FDC TELEMETRY</strong><span>{telemetry.soh.toFixed(1)}% SOH</span></div><div className="twin-spc-sensors">{telemetry.sensors.map(sensor=><div key={sensor.name}><span>{sensor.name}</span><b>{sensor.value<0.01?sensor.value.toExponential(2):sensor.value.toFixed(2)} <small>{sensor.unit}</small></b></div>)}</div></section>
      <section className="twin-process twin-mes"><div className="twin-process-head"><strong>SEMI MES · E40 / E87 / E94</strong><span id="mes-job-state-badge" className={`twin-mes-state ${mes.state.toLowerCase()}`}>{mes.state}</span></div><div className="twin-mes-grid"><div><span>CARRIER</span><b>{mes.carrierId}</b></div><div><span>RECIPE</span><b>{mes.recipeId}</b></div><div><span>STEP</span><b>{mes.stepName}</b></div><div><span>WAFER SLOT</span><b>{mes.waferSlot} / 25</b></div></div><div className="twin-mes-actions"><button type="button" onClick={()=>act('track-in')}>Track-In</button><button type="button" onClick={()=>act('track-out')}>Track-Out</button><button type="button" className="hold" onClick={()=>act('hold')}>Hold</button></div></section>
      <section className="twin-process twin-spc"><div className="twin-process-head"><strong>PROCESS CAPABILITY</strong><span id="spc-status-badge" className={`twin-spc-state ${spc.status.startsWith('ALARM') ? 'alarm' : 'ok'}`}>{spc.status}</span></div><div className="twin-spc-grid"><div><span>Cp</span><b>{spc.cp.toFixed(2)}</b></div><div><span>Cpk</span><b>{spc.cpk.toFixed(2)}</b></div><div><span>SIGMA</span><b>{spc.sigma.toFixed(2)} σ</b></div></div><div className="twin-spc-rule"><span>Nelson</span><b>{spc.rule}</b></div></section>
    </>}
  </aside>;
}
