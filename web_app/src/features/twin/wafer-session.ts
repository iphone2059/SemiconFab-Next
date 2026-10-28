import { twinUiActions } from './state/twinUiStore';
import { twinPageActions } from './state/twinPageStore';

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
export function closeWaferSession(): void {
  twinUiActions.waferClose();
  twinUiActions.waferPlay(false);
  twinPageActions.waferFrameCleared();
}
