import { expect, it } from 'vitest';
import { FAB_LAYOUT } from '../src/fab-layout';
import { ORIGINAL_TWIN_UI, filterReferenceEquipment, filterOriginalOem, buildOriginalSignalRegistry } from '../src/original-twin-data';
import { createDemoState, demoReducer } from '../src/twin-equipment';

it('preserves the final 18-row directory separately from 121 placements and the original stale 67 badge', () => {
  expect(ORIGINAL_TWIN_UI.equipment).toHaveLength(18);
  expect(ORIGINAL_TWIN_UI.equipment.filter(row => row.level === 'B1')).toHaveLength(12);
  expect(ORIGINAL_TWIN_UI.bootstrapEquipmentCount).toBe(67);
  expect(ORIGINAL_TWIN_UI.oem).toHaveLength(116);
  expect(ORIGINAL_TWIN_UI.equipment.map(row => row.id).slice(-4)).toEqual([52,70,98,99].map(index => FAB_LAYOUT[index].recordId));
});

it('filters original directory and OEM records without pretending draft placements are directory cards', () => {
  expect(filterReferenceEquipment({query:'Trumpf', category:'ALL', state:'ALL', language:'zh', states:{}}).map(row => row.id)).toEqual(['subfab.litho.laser.1']);
  expect(filterReferenceEquipment({query:'',category:'facility',state:'ALL',language:'en',states:{}})).toHaveLength(2);
  expect(filterReferenceEquipment({query:'',category:'ALL',state:'DOWN',language:'en',states:{'fac.airshower.main.1':'down'}}).map(row=>row.id)).toEqual(['fac.airshower.main.1']);
  expect(filterOriginalOem('NXT:2050i','ALL')[0].id).toBe('eq_db_001');
  expect(filterOriginalOem('','Lithography')).toHaveLength(16);
});

it('reproduces all 220 original signal keys and last-writer targets for record and machine aliases', () => {
  const registry=buildOriginalSignalRegistry();
  expect([...registry.keys()]).toEqual(ORIGINAL_TWIN_UI.signalKeys);
  expect(registry.get('TG01_LITHO_03')?.layoutIndex).toBe(100);
  // Independent original runtime read: parent [-25.75, .12, 4.5].
  expect(registry.get(FAB_LAYOUT[8].recordId)?.layoutIndex).toBe(14);
  expect(registry.get('subfab.litho.laser.1')?.referenceId).toBe('subfab.litho.laser.1');
});

it('keeps source state keys distinct from the visible last-written light state', () => {
  const history=[{key:FAB_LAYOUT[8].recordId,state:'idle' as const},{key:'TG02_TRACK_01',state:'down' as const}];
  const result=history.reduce((state,event)=>demoReducer(state,{type:'manual-key',...event}),createDemoState(42));
  expect(result.states[8]).toBe('down');
  expect(result.states[14]).toBe('idle');
  expect(result.keys[FAB_LAYOUT[8].recordId]).toBe('idle');
  expect(result.keys['TG02_TRACK_01']).toBe('down');
});
