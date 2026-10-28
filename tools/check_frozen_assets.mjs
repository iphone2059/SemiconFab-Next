/**
 * Build-time authority for checked-in frozen JSON assets. No runtime package
 * is loaded into the pure domain layer. CI rejects invalid structure, unsafe
 * SVG markup and misaligned localization before TypeScript can import the data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const check = (ok, path) => { if (!ok) throw new Error('Invalid frozen asset: ' + path); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const strProps = (o, keys, where) => keys.forEach(k => check(str(o[k]), where + '.' + k));
const numberProps = (o, keys, where) => keys.forEach(k => check(finite(o[k]), where + '.' + k));

export function validateOriginalTwinUi(data) {
  check(object(data), 'original-twin-ui');
  check(Array.isArray(data.equipment) && Array.isArray(data.oem) &&
    Array.isArray(data.localized) && Array.isArray(data.signalKeys), 'original-twin-ui collections');
  check(Number.isSafeInteger(data.bootstrapEquipmentCount) &&
    Number.isSafeInteger(data.layoutCount) && data.layoutCount > 0, 'original-twin-ui counts');
  const equipmentIds = new Set();
  const validateEquipment = (row, where) => {
    check(object(row), where);
    strProps(row, ['id','name','brand','model','category','categoryName','level','bay','color','svgType'], where);
    check(row.level === 'L1' || row.level === 'B1', where + '.level');
    check(object(row.dimensions) && object(row.position), where + '.geometry');
    numberProps(row.dimensions, ['width','length','height'], where + '.dimensions');
    numberProps(row.position, ['x','y','z'], where + '.position');
    check(row.position.rotY === undefined || finite(row.position.rotY), where + '.position.rotY');
    for (const key of ['brandCountry','desc','locationDesc','weight','processNode','waferSize',
      'sourceUrl','sourceTier','connectedTool','conformance_level','mimacTg']) {
      check(row[key] === undefined || str(row[key]), where + '.' + key);
    }
    if (row.specs !== undefined) {
      check(object(row.specs) && Object.values(row.specs).every(str), where + '.specs');
    }
    if (row.catalogRecord !== undefined) check(object(row.catalogRecord), where + '.catalogRecord');
  };
  data.equipment.forEach((row, i) => {
    const where = 'original-twin-ui.equipment[' + i + ']';
    validateEquipment(row, where);
    check(!equipmentIds.has(row.id), where + '.duplicate-id');
    equipmentIds.add(row.id);
  });
  const localizedIds = new Set();
  data.localized.forEach((row, i) => {
    const where = 'original-twin-ui.localized[' + i + ']';
    check(object(row) && str(row.id) && equipmentIds.has(row.id), where + '.id');
    check(!localizedIds.has(row.id), where + '.duplicate');
    localizedIds.add(row.id);
    for (const language of ['zh', 'en']) {
      validateEquipment(row[language], where + '.' + language);
      check(row[language].id === row.id, where + '.' + language + '.id');
    }
  });
  check(localizedIds.size === equipmentIds.size, 'original-twin-ui.localized coverage');
  const oemIds = new Set();
  data.oem.forEach((row, i) => {
    const where = 'original-twin-ui.oem[' + i + ']';
    check(object(row), where);
    strProps(row, ['id','vendor','model','segment','country','process_node','wafer_size',
      'dimensions','weight','key_specs','notes','source_url','source_tier'], where);
    check(row.inFabId === undefined || row.inFabId === null || str(row.inFabId), where + '.inFabId');
    check(!oemIds.has(row.id), where + '.duplicate-id');
    oemIds.add(row.id);
  });
  check(data.signalKeys.every(str) && new Set(data.signalKeys).size === data.signalKeys.length, 'original-twin-ui.signalKeys');
  check(object(data.states) && ['DOWN','IDLE','MAINT','RUNNING'].every(k => object(data.states[k])), 'original-twin-ui.states');
  check(object(data.provenance) && str(data.provenance.source), 'original-twin-ui.provenance');
}

const tags = new Set(['svg','rect','line','circle','text','path','ellipse','polygon','polyline','g','defs','linearGradient','stop']);
const attrs = new Set(['class','viewBox','fill','height','rx','stroke','stroke-width','width','x','y',
  'stroke-dasharray','x1','x2','y1','y2','cx','cy','r','font-size','text-anchor','font-weight','d','ry']);
export function validateElevationData(graphics) {
  check(object(graphics) && object(graphics.generic_chamber), 'original-elevations root');
  const visit = (node, path) => {
    if (str(node)) return;
    check(object(node) && tags.has(node.tag) && object(node.attrs) && Array.isArray(node.children), path);
    for (const [name, value] of Object.entries(node.attrs)) {
      check(attrs.has(name) && str(value) && !/url\s*\(|javascript:|data:/i.test(value), path + '.attrs.' + name);
    }
    node.children.forEach((child, index) => visit(child, path + '.children[' + index + ']'));
  };
  for (const [name, graphic] of Object.entries(graphics)) {
    check(!name.startsWith('__'), 'original-elevations.key');
    visit(graphic, 'original-elevations.' + name);
    check(graphic.tag === 'svg', 'original-elevations.' + name + '.root');
  }
}

validateOriginalTwinUi(load('web_app/assets/original-twin-ui.json'));
validateElevationData(load('web_app/assets/original-elevations.json'));
console.log('Frozen asset contracts PASS');
