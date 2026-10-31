import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { HoveredTool } from '@/contracts/scene.port';
import type { FabToolState } from '@/domain/fab-layout';
import type { WaferHud } from '@/domain/wafer-timeline';
import { viewerActions, viewerHoverAtom, viewerSelectionSyncAtom, viewerSessionAtom } from '@/state/viewer.atom';
import { twinAmhsActions, twinAmhsAtom } from '@/twin/twin-amhs.atom';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';
import { twinPageUiActions, twinPageUiAtom } from '@/twin/twin-page-ui.atom';
import { twinWaferActions, twinWaferAtom } from '@/twin/twin-wafer.atom';
import { twinYmsActions, twinYmsAtom } from '@/twin/twin-yms.atom';

/**
 * G13 / INV-11 behavioural proof that the atom split actually narrowed the
 * notification surface.
 *
 * UI components subscribe to a source atom (directly or through a selector), so a
 * source atom that does not change cannot notify them. Subscribing every source
 * atom directly is therefore the conservative proof: if owner A's update leaves
 * owner B's atom identity untouched, no B subscriber of any granularity fires.
 * Direct atom listeners are delivered synchronously by the registry.
 */
const registry = AtomRegistry.make();
beforeEach(() => registry.reset());
afterAll(() => registry.dispose());

const hud = (): WaferHud => ({ step: 'Step 1/120', width: '0.8%', toolGroup: 'TG01_LITHO', recipe: 'REC', bay: 'Bay', status: 'Navigating...', badge: 'Product A · 120 Steps' });
const hovered: HoveredTool = {
  tool: { index: 3, x: 1, z: 2, width: 1, depth: 1, height: 1, category: 'litho', vendor: 'V', model: 'M', state: 'running' },
  x: 10,
  y: 20,
};

function surface() {
  const counts = { fab: 0, pageUi: 0, wafer: 0, yms: 0, amhs: 0, viewer: 0, hover: 0, selectionSync: 0 };
  const unsubscribe = [
    registry.subscribe(twinPageAtom, () => { counts.fab += 1; }),
    registry.subscribe(twinPageUiAtom, () => { counts.pageUi += 1; }),
    registry.subscribe(twinWaferAtom, () => { counts.wafer += 1; }),
    registry.subscribe(twinYmsAtom, () => { counts.yms += 1; }),
    registry.subscribe(twinAmhsAtom, () => { counts.amhs += 1; }),
    registry.subscribe(viewerSessionAtom, () => { counts.viewer += 1; }),
    registry.subscribe(viewerHoverAtom, () => { counts.hover += 1; }),
    registry.subscribe(viewerSelectionSyncAtom, () => { counts.selectionSync += 1; }),
  ];
  return {
    counts,
    snapshot: () => ({ ...counts }),
    /** Subscribing an unbuilt lazy atom defers its first announce; force-build then clear. */
    reset: () => {
      // Build every observed atom once so later updates notify exactly once.
      registry.get(twinPageAtom);
      registry.get(twinPageUiAtom);
      registry.get(twinWaferAtom);
      registry.get(twinYmsAtom);
      registry.get(twinAmhsAtom);
      registry.get(viewerSessionAtom);
      registry.get(viewerHoverAtom);
      registry.get(viewerSelectionSyncAtom);
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
    dispose: () => unsubscribe.forEach((fn) => fn()),
  };
}

const OTHERS = ['pageUi', 'wafer', 'yms', 'amhs', 'viewer', 'hover', 'selectionSync'] as const;

/** Subscribing mounts an unbuilt atom, which emits one initial announce; flush it before counting updates. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

it('keeps FAB projection updates out of page-UI, wafer, YMS, AMHS and viewer atoms', async () => {
  const s = surface();
  await settle();
  s.reset();
  try {
    const scope = { siteId: 'site-a', fabId: 'fab-a' };
    const beforeScope = s.snapshot();
    twinPageActions.liveScopeActivated(registry, scope);
    let after = s.snapshot();
    expect(after.fab).toBe(beforeScope.fab + 1);
    for (const key of OTHERS) expect(after[key], key).toBe(beforeScope[key]);

    const beforeSnapshot = s.snapshot();
    twinPageActions.liveSnapshotReceived(registry, { scope, states: ['down' as FabToolState], updatedAt: '2026-10-29T00:00:00Z' });
    after = s.snapshot();
    expect(after.fab).toBe(beforeSnapshot.fab + 1);
    for (const key of OTHERS) expect(after[key], key).toBe(beforeSnapshot[key]);

    // A frame from a replaced FAB scope is rejected in the reducer and must not notify anyone.
    const rejected = s.snapshot();
    twinPageActions.liveSnapshotReceived(registry, { scope: { siteId: 'site-b', fabId: 'fab-b' }, states: ['maint' as FabToolState], updatedAt: 'late' });
    expect(s.snapshot()).toEqual(rejected);
  } finally { s.dispose(); }
});

it('keeps Wafer HUD projection notifications inside the Wafer atom', async () => {
  const s = surface();
  await settle();
  s.reset();
  try {
    const base = s.snapshot();
    for (let index = 0; index < 20; index += 1) {
      twinWaferActions.hudSet(registry, { ...hud(), step: `Step ${index + 1}/120` });
    }
    const after = s.snapshot();
    expect(after.wafer).toBe(base.wafer + 20);
    for (const key of ['fab', 'pageUi', 'yms', 'amhs', 'viewer', 'hover', 'selectionSync'] as const) {
      expect(after[key], key).toBe(base[key]);
    }
  } finally { s.dispose(); }
});

it('keeps AMHS scene cadence inside the AMHS atom', async () => {
  const s = surface();
  await settle();
  s.reset();
  try {
    const base = s.snapshot();
    for (let active = 0; active < 10; active += 1) {
      twinAmhsActions.amhsSet(registry, { active, total: 24, queued: 0, completed: active, avgDelivery: 1 });
    }
    const after = s.snapshot();
    expect(after.amhs).toBe(base.amhs + 10);
    for (const key of ['fab', 'pageUi', 'wafer', 'yms', 'viewer', 'hover', 'selectionSync'] as const) {
      expect(after[key], key).toBe(base[key]);
    }
  } finally { s.dispose(); }
});

it('keeps YMS and page-UI edits out of the FAB and wafer atoms', async () => {
  const s = surface();
  await settle();
  s.reset();
  try {
    const base = s.snapshot();
    twinYmsActions.ymsRandomize(registry, 'ring');
    twinYmsActions.ymsHoverDieSet(registry, { r: 1, c: 2, bin: 3 });
    twinPageUiActions.sidebarQuerySet(registry, 'ASML');
    twinPageUiActions.selectedSet(registry, hovered.tool);
    twinPageUiActions.layerToggled(registry, 'roof');
    const after = s.snapshot();
    expect(after.yms).toBe(base.yms + 2);
    expect(after.pageUi).toBe(base.pageUi + 3);
    for (const key of ['fab', 'wafer', 'amhs', 'viewer', 'hover', 'selectionSync'] as const) {
      expect(after[key], key).toBe(base[key]);
    }
  } finally { s.dispose(); }
});

it('keeps viewer hover and selection-sync in their own atoms', async () => {
  const s = surface();
  await settle();
  s.reset();
  try {
    viewerActions.viewerMounted(registry, 'epoch-a');
    expect(s.snapshot().viewer).toBe(1);

    const beforeHover = s.snapshot();
    viewerActions.viewerHoverReceived(registry, { epoch: 'epoch-a', hover: hovered });
    let after = s.snapshot();
    expect(after.hover).toBe(beforeHover.hover + 1);
    expect(after.viewer).toBe(beforeHover.viewer);
    expect(after.fab).toBe(beforeHover.fab);

    // Stale-epoch hover callbacks are ignored without a notification.
    const stale = s.snapshot();
    viewerActions.viewerHoverReceived(registry, { epoch: 'replaced', hover: hovered });
    expect(s.snapshot()).toEqual(stale);

    viewerActions.viewerSelectionSyncStarted(registry, 'token');
    expect(s.snapshot().selectionSync).toBe(beforeHover.selectionSync + 1);
    viewerActions.viewerSelectionSyncFinished(registry, 'stale-token');
    expect(s.snapshot().selectionSync).toBe(beforeHover.selectionSync + 1);
    viewerActions.viewerSelectionSyncFinished(registry, 'token');
    expect(s.snapshot().selectionSync).toBe(beforeHover.selectionSync + 2);

    // A reload resets the session display copy and clears the transient hover atom.
    const beforeReload = s.snapshot();
    viewerActions.viewerReloadRequested(registry);
    after = s.snapshot();
    expect(after.viewer).toBe(beforeReload.viewer + 1);
    expect(after.hover).toBe(beforeReload.hover + 1);
    expect(registry.get(viewerSessionAtom).epoch).toBeUndefined();
  } finally { s.dispose(); }
});
