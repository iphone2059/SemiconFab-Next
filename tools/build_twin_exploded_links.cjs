// Test-only execution of the frozen original FAB_EQUIPMENT table; no original runtime ships.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.resolve(root, '../SemiconFab/twin.html'), 'utf8');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== manifest.source_sha256['twin.html']) throw new Error('Original source drift');

const marker = '      const FAB_EQUIPMENT = [';
const start = source.indexOf(marker);
const end = source.indexOf('\n      ];', start);
if (start < 0 || end < 0) throw new Error('FAB_EQUIPMENT not found');
const slice = source.slice(start, end + '\n      ];'.length);
const context = {};
vm.createContext(context);
vm.runInContext(slice + '\n;globalThis.__equipment = FAB_EQUIPMENT;', context);
const equipment = context.__equipment;

const conduitColors = {
  subfab_laser: 0xf59e0b,
  subfab_plinth: 0x94a3b8,
  subfab_pump: 0x0284c7,
  subfab_scrubber: 0xd97706,
  subfab_vmb: 0x10b981,
  subfab_chiller: 0x8b5cf6,
  default: 0x38bdf8,
};
const byId = new Map(equipment.map(entry => [entry.id, entry]));
const pairs = [];
for (const sub of equipment) {
  if (sub.level !== 'B1' || !sub.connectedTool) continue;
  const host = byId.get(sub.connectedTool);
  if (!host) continue;
  pairs.push({
    subId: sub.id,
    hostId: host.id,
    svgType: sub.svgType,
    subX: sub.position.x,
    subZ: sub.position.z,
    hostX: host.position.x,
    hostZ: host.position.z,
    color: conduitColors[sub.svgType] ?? conduitColors.default,
  });
}
const lineOf = index => source.slice(0, index).split('\n').length;
const result = {
  sourceSha256: hash,
  sourceLines: { FAB_EQUIPMENT: [lineOf(start), lineOf(end)] },
  equipmentCount: equipment.length,
  pairs,
};
const json = JSON.stringify(result) + '\n';
const destination = path.join(root, 'web_app/tests/fixtures/original-exploded-links.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== json) throw new Error('Exploded link vectors drift');
  console.log('Exploded link vectors stable: ' + pairs.length + ' B1 pairs from ' + equipment.length + ' source records');
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json);
  console.log('Original exploded links: ' + pairs.length + ' pairs from ' + equipment.length + ' source records, lines ' + lineOf(start) + '-' + lineOf(end));
}
