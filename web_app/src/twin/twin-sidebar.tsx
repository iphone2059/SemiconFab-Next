import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useMemo } from 'react';
import { classNames } from '@/components/class-names';
import { useTwinLocale } from '@/twin/twin-i18n';
import { twinPageAtom, twinPageActions } from '@/twin/twin-page.atom';
import { ORIGINAL_TWIN_UI, filterOriginalOem, filterReferenceEquipment, localizedEquipment, type TwinSelection } from '@/domain/original-twin-data';
import type { FabToolState } from '@/domain/fab-layout';
import { OriginalIcon } from '@/components/original-icons';

export const SOURCE_STATE_STYLE = {
  running: { bg:'bg-emerald-50 text-emerald-700 border-emerald-200',dot:'bg-emerald-500',zh:'运行中',en:'Running' },
  idle: { bg:'bg-amber-50 text-amber-700 border-amber-200',dot:'bg-amber-500',zh:'待料',en:'Idle' },
  down: { bg:'bg-rose-50 text-rose-700 border-rose-200',dot:'bg-rose-500',zh:'告警',en:'Down' },
  maint: { bg:'bg-indigo-50 text-indigo-700 border-indigo-200',dot:'bg-indigo-500',zh:'维保',en:'PM' },
} as const;
const CATEGORIES = [['ALL','全部','All'],['litho','光刻','Lithography'],['etch','刻蚀','Etch'],['depo','薄膜沉积','Thin Film'],['subfab','Subfab厂务','Subfab Utilities'],['facility','洁净环控','Facility & Airlock'],['imp_therm','注入/热处理','Implant/Thermal'],['wet_cmp','CMP/清洗','CMP/Cleans'],['metro','检测量测','Metrology'],['pkg','先进封装','Packaging'],['amhs','天轨物流','Logistics']];
const SEGMENTS = [['ALL','全部 (116)','All (116)'],['Lithography','光刻 (16)','Litho (16)'],['Etch','刻蚀 (15)','Etch (15)'],['Deposition','薄膜 (24)','Depo (24)'],['Metrology & Inspection','量测 (22)','Metro (22)'],['Ion Implant','注入 (12)','Implant (12)'],['CMP','研磨 (9)','CMP (9)'],['Cleaning','清洗 (9)','Cleans (9)'],['Diffusion & Anneal','扩散 (9)','Diff/Anneal (9)']];
export function segmentBadge(segment: string) {
  const text=segment.toLowerCase();
  if(text.includes('litho'))return 'badge-litho'; if(text.includes('etch'))return 'badge-etch';
  if(text.includes('implant')||text.includes('diff')||text.includes('anneal'))return 'badge-imp_therm';
  if(text.includes('cmp')||text.includes('clean'))return 'badge-wet_cmp';
  if(text.includes('metro')||text.includes('inspect'))return 'badge-metro';
  if(text.includes('pkg')||text.includes('pack'))return 'badge-pkg'; if(text.includes('test'))return 'badge-test';
  return 'badge-depo';
}
export function TwinSidebar({selection,states,badgeCount=67,onSelect,onArchitecture,onDatabase}: {
  selection?:TwinSelection;states:Readonly<Record<string,FabToolState>>;badgeCount?:number;
  onSelect:(selection:TwinSelection)=>void;onArchitecture:()=>void;onDatabase:()=>void;
}) {
  const registry = useContext(RegistryContext);
  const {language}=useTwinLocale(); const zh=language==='zh';
  const {tab,query,category,segment,stateFilter,switched}=useAtomValue(twinPageAtom, state=>state.sidebar);
  const setTab=(value:'fab'|'oem')=>twinPageActions.sidebarTabSet(registry, value);
  const setQuery=(value:string)=>twinPageActions.sidebarQuerySet(registry, value);
  const setCategory=(value:string)=>twinPageActions.sidebarCategorySet(registry, value);
  const setSegment=(value:string)=>twinPageActions.sidebarSegmentSet(registry, value);
  const setStateFilter=(value:string)=>twinPageActions.sidebarStateFilterToggle(registry, value);
  const equipment=useMemo(()=>filterReferenceEquipment({query,category,state:stateFilter,language,states}),[query,category,stateFilter,language,states]);
  const oem=useMemo(()=>filterOriginalOem(query,segment),[query,segment]);
  const counts=useMemo(()=>{const result={running:0,idle:0,down:0,maint:0};for(const row of ORIGINAL_TWIN_UI.equipment)result[states[row.id]??'running']++;return result},[states]);
  const chooseTab=(value:'fab'|'oem')=>setTab(value);
  return <aside id="left-sidebar" className="fixed top-12 left-2.5 bottom-2.5 glass-panel rounded-xl z-20 flex flex-col shadow-lg border border-slate-200/90 overflow-hidden" style={{width:315,top:48,bottom:10,height:'calc(100vh - 58px)',maxHeight:'calc(100vh - 58px)'}}>
    <div className="p-2 border-b border-slate-200/70 shrink-0 space-y-1.5">
      <div className="flex items-center bg-slate-100/90 p-0.5 rounded-lg border border-slate-200 text-[9px] font-semibold">
        <button id="sidebar-tab-fab" type="button" onClick={()=>chooseTab('fab')} className={`flex-1 py-1 rounded-md transition text-center ${tab==='fab'?'bg-white text-slate-900 shadow-sm':'text-slate-500 hover:text-slate-900'}`}><span>{zh?'车间机台':'Fab Tools'}</span> (<span id="tab-count-fab">{badgeCount}</span>)</button>
        <button id="sidebar-tab-oem" type="button" onClick={()=>chooseTab('oem')} className={`flex-1 py-1 rounded-md transition text-center ${tab==='oem'?'bg-white text-slate-900 shadow-sm':'text-slate-500 hover:text-slate-900'}`}><span>{zh?'全球图鉴':'OEM Catalog'}</span> (<span id="tab-count-oem">116</span>)</button>
      </div>
      <div className="relative">
        <span className="absolute left-2.5 top-2 text-slate-400"><OriginalIcon name="search"/></span>
        <input id="search-input" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'搜索设备、领军品牌 (ASML, Lam...)':'Search equipment or vendor...'} aria-label={zh?'搜索设备':'Search equipment'} className="w-full bg-slate-50/90 text-[9px] text-slate-800 pl-7 pr-6 py-1 rounded-lg border border-slate-200 focus:outline-none focus:border-slate-800 focus:bg-white transition-all shadow-inner"/>
        {query&&<button id="search-clear-btn" type="button" onClick={()=>setQuery('')} className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-700" aria-label={zh?'清空搜索':'Clear search'}>×</button>}
      </div>
      <div id="category-pills-container" className="flex items-center gap-1 overflow-x-auto pb-0.5 text-[8.5px] no-scrollbar">
        {(tab==='fab'?CATEGORIES:SEGMENTS).map(([id,chinese,english])=><button key={id} type="button" data-category={tab==='fab'?id:undefined} data-segment={tab==='oem'?id:undefined} onClick={()=>tab==='fab'?setCategory(id):setSegment(id)} className={`${tab==='fab'?'cat-pill':'oem-cat-pill'} ${id===(tab==='fab'?category:segment)?`active ${tab==='fab'?'bg-slate-900 text-white border-slate-900':'bg-indigo-600 text-white border-indigo-600'} shadow-sm`:'text-slate-600 bg-white border-slate-200 hover:bg-slate-50'} px-2 py-0.5 rounded-md font-medium border shrink-0`}>{zh?chinese:english}</button>)}
      </div>
      <div id="sidebar-secondary-controls">{tab==='fab'?<div className="grid grid-cols-4 gap-1 mt-2 text-[9px] font-mono">
        {(Object.keys(SOURCE_STATE_STYLE) as FabToolState[]).map(state=>{const cfg=SOURCE_STATE_STYLE[state];return <button key={state} id={`state-btn-${state.toUpperCase()}`} type="button" aria-pressed={stateFilter===state.toUpperCase()} onClick={()=>setStateFilter(state.toUpperCase())} className={`state-pill py-0.5 px-1 rounded ${cfg.bg} border font-semibold flex items-center justify-center gap-1 transition ${stateFilter===state.toUpperCase()?'ring-1 ring-slate-700':''}`}><span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${state==='down'?'animate-pulse':''}`}/><span id={`count-${state}`}>{counts[state]}</span><span>{state==='running'&&zh?'运行':zh?cfg.zh:cfg.en}</span></button>})}
      </div>:<div className="flex items-center justify-between text-[9px] text-slate-500 font-mono mt-1.5 px-0.5"><span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"/>{zh?'40 家全球标杆品牌':'40 Global OEMs'}</span><span className="bg-indigo-50 text-indigo-700 px-1.5 py-0.2 rounded font-semibold border border-indigo-200">116 SEMI-E72</span></div>}</div>
    </div>
    <div id="equipment-list" className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5 overscroll-contain" style={{overflowY:'auto',maxHeight:'100%'}}>
      {tab==='fab'?equipment.map(raw=>{const row=localizedEquipment(raw.id,language)??raw;const state=states[row.id]??'running',cfg=SOURCE_STATE_STYLE[state];const active=selection?.kind==='reference'&&selection.id===row.id;return <button type="button" key={row.id} id={`sidebar-item-${row.id}`} data-equipment-id={row.id} onClick={()=>onSelect({kind:'reference',id:row.id})} className={classNames('glass-card p-2 rounded-lg cursor-pointer w-full block text-left', active && 'border-slate-800 bg-slate-50 ring-1 ring-slate-800/10')}>
        <div className="flex items-center justify-between mb-1"><span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded badge-${row.category}`}>{row.categoryName}</span><div className="flex items-center gap-1.5"><span className={classNames('inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[8.5px] font-mono font-bold', cfg.bg)}><span className={classNames('w-1.5 h-1.5 rounded-full', cfg.dot, { 'animate-ping': state === 'down' })}/>{zh?cfg.zh:cfg.en}</span><span className="text-[9.5px] text-slate-700 font-mono font-bold">{row.brand.split(' ')[0]}</span></div></div>
        <div className="text-[11.5px] font-bold text-slate-900 tracking-tight truncate" title={row.name}>{row.name}</div><div className="text-[9.5px] text-slate-500 flex items-center justify-between mt-1"><span className="font-mono text-slate-600 truncate max-w-[190px]" title={row.model}>{row.model.split('/')[0]}</span><span className="text-[9px] text-slate-400 font-mono shrink-0">{row.dimensions.width}×{row.dimensions.length}m</span></div>
      </button>}):oem.map(row=><button type="button" key={row.id} id={`sidebar-oem-${row.id}`} data-oem-id={row.id} onClick={()=>onSelect({kind:'oem',id:row.id})} className={classNames('glass-card p-2 rounded-lg cursor-pointer transition border w-full block text-left', selection?.kind === 'oem' && selection.id === row.id ? 'border-indigo-600 bg-indigo-50/50 ring-1 ring-indigo-500/20 shadow-sm' : 'border-slate-200 hover:border-slate-300')}>
        <div className="flex items-center justify-between mb-1"><span className={`text-[9px] font-semibold px-1.5 py-0.2 rounded ${segmentBadge(row.segment)}`}>{row.segment}</span><div className="flex items-center gap-1">{row.inFabId?<span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[8.5px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300"><span className="w-1 h-1 rounded-full bg-emerald-500"/>In Fab</span>:<span className="text-[8.5px] font-mono text-slate-400">OEM Catalog</span>}<span className="text-[9.5px] text-slate-800 font-mono font-bold">{row.vendor.split(' ')[0]}</span></div></div><div className="text-[11.5px] font-bold text-slate-900 tracking-tight leading-snug truncate" title={row.model}>{row.model}</div><div className="text-[9.5px] text-slate-500 flex items-center justify-between mt-1 pt-0.5 border-t border-slate-100 font-mono"><span className="text-violet-700 font-medium truncate max-w-[180px]">{row.process_node||'General Node'}</span><span className="text-[9px] text-slate-400 shrink-0">{row.wafer_size}</span></div>{(row.substitute_brand||row.substitute_model)&&<div className="mt-1 pt-0.5 border-t border-indigo-100 text-[8px] font-mono text-indigo-700 flex items-center justify-between"><span className="truncate max-w-[200px]">替代: <b>{row.substitute_brand} {row.substitute_model}</b></span><span className="text-emerald-600 font-bold shrink-0">⚡ 可3D替代</span></div>}
      </button>)}
    </div>
    <div className="p-1.5 px-2.5 bg-slate-50/90 border-t border-slate-200/80 rounded-b-xl text-[9.5px] text-slate-500 flex items-center justify-between shrink-0"><span id="footer-tool-count" className="whitespace-nowrap shrink-0">{!switched?<>Catalog Tools: <b>121</b> (4 L1 · 117 Drafts)</>:<>{tab==='fab'?(zh?'当前机台':'Active Tools'):(zh?'OEM 数据库':'OEM Database')}: <b id="stat-count" className="text-slate-900 font-semibold">{tab==='fab'?equipment.length:oem.length}</b></>}</span><div className="flex items-center gap-2 shrink-0 whitespace-nowrap"><button type="button" onClick={onArchitecture} className="flex items-center gap-1 text-emerald-700 font-semibold hover:underline"><OriginalIcon name="l1"/>{zh?'开放软件架构':'Open Arch'}</button><span className="text-slate-300">·</span><button type="button" onClick={onDatabase} className="flex items-center gap-1 text-indigo-700 font-medium hover:underline">{zh?'完整数据库':'Full Database'}</button></div></div>
  </aside>;
}
