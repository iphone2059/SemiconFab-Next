import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { throws, doesNotThrow } from 'node:assert/strict';
import { validateOriginalTwinUi, validateElevationData } from './check_frozen_assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = name => JSON.parse(readFileSync(resolve(root, 'web_app/assets/', name), 'utf8'));
const twin = load('original-twin-ui.json');
const graphics = load('original-elevations.json');

test('frozen reference data and elevation assets pass their build contracts', () => {
  doesNotThrow(() => validateOriginalTwinUi(twin));
  doesNotThrow(() => validateElevationData(graphics));
});

test('invalid equipment geometry and duplicate identities fail', () => {
  const broken = structuredClone(twin);
  broken.equipment[0].dimensions.width = 'bad';
  throws(() => validateOriginalTwinUi(broken), /Invalid frozen asset/);
  const duplicate = structuredClone(twin);
  duplicate.equipment[1].id = duplicate.equipment[0].id;
  throws(() => validateOriginalTwinUi(duplicate), /duplicate-id/);
});

test('unmatched localization and invalid OEM identity fail', () => {
  const broken = structuredClone(twin);
  broken.localized[0].en.id = 'other';
  throws(() => validateOriginalTwinUi(broken), /localized/);
  const oem = structuredClone(twin);
  oem.oem[0].vendor = null;
  throws(() => validateOriginalTwinUi(oem), /vendor/);
});

test('unsafe SVG event attributes and script tags fail', () => {
  const event = structuredClone(graphics);
  event.generic_chamber.attrs.onload = 'alert(1)';
  throws(() => validateElevationData(event), /onload/);
  const tag = structuredClone(graphics);
  tag.generic_chamber.children.push({ tag: 'script', attrs: {}, children: [] });
  throws(() => validateElevationData(tag), /Invalid frozen asset/);
});
