import { expect, it } from 'vitest';
import { ORIGINAL_COLUMNS, ORIGINAL_AMBER_PANELS, ORIGINAL_ZONES } from '../src/original-environment';

it('preserves the original 24 ten-metre columns and always-visible 55 amber FFU panels', () => {
  expect(ORIGINAL_COLUMNS).toHaveLength(24);
  expect(ORIGINAL_COLUMNS[0]).toEqual([-40, 5, -25]);
  expect(ORIGINAL_COLUMNS.at(-1)).toEqual([35, 5, 23]);
  expect(ORIGINAL_AMBER_PANELS).toHaveLength(55);
  expect(ORIGINAL_AMBER_PANELS[0]).toEqual([-34, 5.22, -25]);
  expect(ORIGINAL_AMBER_PANELS.at(-1)?.[0]).toBeCloseTo(-21.2);
});

it('retains original warm/white/cold zone assignment and nominal metre bounds', () => {
  expect(ORIGINAL_ZONES).toHaveLength(9);
  expect(ORIGINAL_ZONES.map(zone => zone.tone)).toEqual(['amber', 'cold', 'white', 'cold', 'cold', 'white', 'white', 'cold', 'white']);
  expect(ORIGINAL_ZONES.at(-1)?.rect).toEqual([33, -27, 12, 58]);
});
