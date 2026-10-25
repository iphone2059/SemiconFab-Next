// Source-exact rows extracted from frozen SemiconFab/twin.html FAB_EQUIPMENT
// (commit b3666132e5d8cab2cebe4c4227fc04c52242eb28).
// These 12 B1-connected OEM reference records are NOT part of the 121 layout
// snapshot. Do not merge them into FAB_LAYOUT or change equipment pick identity.
export interface OriginalExplodedLink {
  readonly subId: string;
  readonly hostId: string;
  readonly svgType: string;
  readonly subX: number;
  readonly subZ: number;
  readonly hostX: number;
  readonly hostZ: number;
  readonly color: number;
}

export const ORIGINAL_EXPLODED_LINKS: readonly OriginalExplodedLink[] = [
  { subId: 'subfab.litho.laser.1', hostId: 'fe.litho.euv.1', svgType: 'subfab_laser', subX: -30, subZ: -22, hostX: -30, hostZ: -22, color: 0xf59e0b },
  { subId: 'subfab.litho.plinth.1', hostId: 'fe.litho.euv.1', svgType: 'subfab_plinth', subX: -30, subZ: -22, hostX: -30, hostZ: -22, color: 0x94a3b8 },
  { subId: 'subfab.pump.euv.1', hostId: 'fe.litho.euv.1', svgType: 'subfab_pump', subX: -22, subZ: -22, hostX: -30, hostZ: -22, color: 0x284c7 },
  { subId: 'subfab.pump.euv.2', hostId: 'fe.litho.euv.2', svgType: 'subfab_pump', subX: -22, subZ: -12, hostX: -30, hostZ: -12, color: 0x284c7 },
  { subId: 'subfab.scrubber.etch.1', hostId: 'fe.etch.ccp.1', svgType: 'subfab_scrubber', subX: 2, subZ: -22, hostX: -8, hostZ: -24, color: 0xd97706 },
  { subId: 'subfab.scrubber.etch.2', hostId: 'fe.etch.ccp.2', svgType: 'subfab_scrubber', subX: 2, subZ: -10, hostX: -8, hostZ: -18, color: 0xd97706 },
  { subId: 'subfab.pump.etch.1', hostId: 'fe.etch.ccp.1', svgType: 'subfab_pump', subX: -5, subZ: -22, hostX: -8, hostZ: -24, color: 0x284c7 },
  { subId: 'subfab.pump.etch.2', hostId: 'fe.etch.icp.2', svgType: 'subfab_pump', subX: -5, subZ: -10, hostX: 0, hostZ: -18, color: 0x284c7 },
  { subId: 'subfab.vmb.gas.1', hostId: 'fe.depo.cvd.1', svgType: 'subfab_vmb', subX: 20, subZ: -15, hostX: 16, hostZ: -10, color: 0x10b981 },
  { subId: 'subfab.pump.cvd.1', hostId: 'fe.depo.ald.1', svgType: 'subfab_pump', subX: 20, subZ: -24, hostX: 24, hostZ: -23, color: 0x284c7 },
  { subId: 'subfab.chiller.rf.1', hostId: 'fe.cmp.1', svgType: 'subfab_chiller', subX: -5, subZ: 15, hostX: -8, hostZ: 8, color: 0x8b5cf6 },
  { subId: 'subfab.upw.manifold.1', hostId: 'fe.clean.single.1', svgType: 'subfab_chiller', subX: -22, subZ: 15, hostX: 0, hostZ: 7, color: 0x8b5cf6 },
];

export function explodedLinkFrame(factor: number, nowMs: number, phase: number) {
  const f = Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 0;
  const baseHeight = 7;
  const height = baseHeight + f * 18;
  return {
    visible: f >= 0.01,
    scaleY: height / baseHeight,
    y: -height / 2,
    ringY: Math.sin(nowMs * 0.005 + phase) * (baseHeight * 0.44),
  } as const;
}
