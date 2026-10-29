import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { twinWaferActions } from '@/twin/twin-wafer.atom';

/**
 * Application-level wafer session close.
 *
 * The wafer playback controller owns the scene handles (trail/point/camera), but
 * closing the session is one coordinated use case across two stores: the Twin UI
 * store stops playback and closes the HUD, and the page store drops the wafer
 * projection that the HUD renders. Keeping the coordination here means neither
 * store imports or mutates the other.
 *
 * Callers still own the scene cleanup (setWaferPoint/setWaferTrail/setView):
 * renderer handles belong to the page controller, never to a store.
 */
export function closeWaferSession(registry: AtomRegistry.AtomRegistry): void {
  twinUiActions.waferClose(registry);
  twinUiActions.waferPlay(registry, false);
  twinWaferActions.waferFrameCleared(registry);
}
