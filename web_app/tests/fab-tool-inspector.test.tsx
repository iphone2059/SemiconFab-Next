import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CatalogEntryDto } from '../src/contracts';
import type { PickedTool } from '../src/fab-scene';
import { FabToolInspector, matchToolCatalog } from '../src/fab-tool-inspector';

const tool: PickedTool = { index: 0, x: -31, z: -22.5, width: 3, depth: 4, height: 3.2,
  vendor: 'ASML', model: 'TWINSCAN NXT:2050i', category: 'lithography', state: 'down' };
const entry = { recordId: 'record-1', vendor: tool.vendor, model: tool.model, category: tool.category,
  conformanceLevel: 'L1', record: { record_status: 'draft', identity: {
    wafer_sizes_mm: { value: [300] }, node_applicability: { value: '7nm' } },
    physical: { weight_kg: { value: 0, unit: 'kg', provenance: { tier: 'inferred', source: 'javascript:alert(1)' } } },
    process_capability: { capabilities: [{ detail: { value: '193nm immersion', provenance: { source: 'https://example.com/oem' } } }] } },
} as unknown as CatalogEntryDto;

it('matches both vendor and model and refuses ambiguous catalog identities', () => {
  expect(matchToolCatalog(tool, [{ ...entry, vendor: 'Other' }])).toBeUndefined();
  expect(matchToolCatalog(tool, [{ ...entry, model: tool.model + ' prototype' }])).toBeUndefined();
  expect(matchToolCatalog(tool, [entry, { ...entry, recordId: 'duplicate' }])).toBeUndefined();
  expect(matchToolCatalog(tool, [entry])).toBe(entry);
});

it('shows real state, OEM fields and provenance without inventing telemetry or hiding draft status', () => {
  const html = renderToStaticMarkup(<FabToolInspector tool={tool} entry={entry} onClose={() => {}} onFocus={() => {}} />);
  expect(html).toContain('故障');
  expect(html).toContain('300');
  expect(html).toContain('7nm');
  expect(html).toContain('193nm immersion');
  expect(html).toContain('0 kg');
  expect(html).toContain('draft');
  expect(html).toContain('https://example.com/oem');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('98.4%');
});
