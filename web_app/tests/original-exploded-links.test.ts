import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ORIGINAL_EXPLODED_LINKS, explodedLinkFrame } from '../src/original-exploded-link-data';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/original-exploded-links.json', import.meta.url), 'utf8'));
describe('frozen SemiconFab exploded equipment connections', () => {
  it('matches the frozen-source FAB_EQUIPMENT table row-for-row', () => {
    expect(fixture.equipmentCount).toBe(69);
    expect(fixture.sourceLines.FAB_EQUIPMENT).toEqual([5069, 7490]);
    expect(fixture.sourceSha256).toBe('633598e4ab21c13eab440f65fb1c427bad08d147b2218f320bedb2770d32fc30');
    expect(fixture.pairs).toEqual(ORIGINAL_EXPLODED_LINKS);
  });
  it('has 12 exact B1-to-L1 connections', () => {
    expect(ORIGINAL_EXPLODED_LINKS).toHaveLength(12);
    expect(new Set(ORIGINAL_EXPLODED_LINKS.map(x => x.subId)).size).toBe(12);
    expect(ORIGINAL_EXPLODED_LINKS[0]).toMatchObject({
      subId: 'subfab.litho.laser.1', hostId: 'fe.litho.euv.1',
      subX: -30, subZ: -22, hostX: -30, hostZ: -22, color: 0xf59e0b,
    });
    expect(ORIGINAL_EXPLODED_LINKS.at(-1)).toMatchObject({
      subId: 'subfab.upw.manifold.1', hostId: 'fe.clean.single.1', color: 0x8b5cf6,
    });
  });
  it('matches source 7 m base and 18 m vertical expansion', () => {
    expect(explodedLinkFrame(0, 0, 0)).toMatchObject({ visible: false, scaleY: 1, y: -3.5 });
    expect(explodedLinkFrame(0.5, 0, 0)).toMatchObject({ visible: true, scaleY: 16 / 7, y: -8 });
    expect(explodedLinkFrame(1, 0, 0)).toMatchObject({ visible: true, scaleY: 25 / 7, y: -12.5 });
  });
  it('matches source ring sinusoid and rejects invalid factor', () => {
    expect(explodedLinkFrame(1, 0, Math.PI / 2).ringY).toBeCloseTo(3.08);
    expect(explodedLinkFrame(Number.NaN, 0, 0).visible).toBe(false);
  });
});
