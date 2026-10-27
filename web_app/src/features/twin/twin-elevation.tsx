import { createElement, type CSSProperties, type ReactNode } from 'react';
import source from '../../../assets/original-elevations.json';

interface SvgNode { tag:string;attrs:Record<string,string>;children:(SvgNode|string)[] }
const graphics:Readonly<Record<string,SvgNode>>=source as unknown as Record<string,SvgNode>;
const tags=new Set(['svg','path','line','rect','circle','text','g','polygon','polyline','ellipse','defs','linearGradient','stop']);
function properties(attributes:Record<string,string>) {
  const result:Record<string,string|CSSProperties>={};
  for(const [name,value] of Object.entries(attributes)) {
    if(name.startsWith('on'))continue;
    if(name==='style')result.style=Object.fromEntries(value.split(';').filter(Boolean).map(pair=>{const index=pair.indexOf(':');return [pair.slice(0,index).trim().replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase()),pair.slice(index+1).trim()]}));
    else result[name==='class'?'className':name==='viewbox'?'viewBox':name.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())]=value;
  }
  return result;
}
function graphic(node:SvgNode|string,key:number,model:string):ReactNode {
  if(typeof node==='string')return node.replaceAll('__MODEL__',model);
  if(!tags.has(node.tag))return null;
  return createElement(node.tag,{...properties(node.attrs),key},...node.children.map((child,index)=>graphic(child,index,model)));
}
export function OriginalElevation({id,model,draft=false}: {id:string;model:string;draft?:boolean}) {
  if(draft)return <div className="flex flex-col items-center justify-center text-center p-3 text-slate-500"><svg className="w-12 h-12 text-slate-400 mb-1" fill="none" stroke="currentColor" strokeDasharray="4,3" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="1.5"/><path d="M3 9h18M9 21V9" strokeWidth="1.2"/></svg><span className="text-[9px] font-mono text-slate-600 font-bold">Category Generic Shell · Pending Verification</span><span className="text-[8px] text-slate-400 mt-0.5">{model}</span></div>;
  const node=graphics[id]??graphics.generic_chamber;
  return graphic(node,0,model);
}
