import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
declare const registry: AtomRegistry.AtomRegistry;
/**
 * Compile-time contract tests for the typed Effect Atom slice-store actions.
 *
 * Vitest never executes this file (it is not a *.test.* module); it exists so
 * `tsc --noEmit` proves the inference-based action surface is not just "valid
 * code compiles", but that invalid payloads, fields and arities are rejected.
 * If any @ts-expect-error line starts compiling, TypeScript reports the unused
 * directive and fails the typecheck.
 */
import { runtimeActions } from '@/state/runtime.atom';
import { viewerActions } from '@/state/viewer.atom';
import { twinPageActions } from '@/twin/twin-page.atom';
import { twinPageUiActions } from '@/twin/twin-page-ui.atom';
import { workbenchActions } from '@/workbench/workbench.atom';

// Positive controls: the intended shape keeps compiling.
runtimeActions.fatalErrorSet(registry, 'fatal');
workbenchActions.formFieldSet(registry, { field: 'lotCount', value: '12' });
twinPageActions.siteIdSet(registry, 'site-1');
twinPageActions.statusFeedStale(registry);
viewerActions.viewerMounted(registry, 'epoch-1');
viewerActions.viewerLifecycleReceived(registry, { epoch: 'epoch-1', event: { type: 'ready', message: 'WebGPU · ready' } });

// @ts-expect-error the viewer lifecycle is a discriminated event, not an arbitrary string
viewerActions.viewerLifecycleReceived(registry, { epoch: 'epoch-1', event: { type: 'bogus', message: 'x' } });
// @ts-expect-error a recovering event must declare its loss cause
viewerActions.viewerLifecycleReceived(registry, { epoch: 'epoch-1', event: { type: 'recovering', message: 'x' } });
// @ts-expect-error the string-status action was replaced by the lifecycle action
viewerActions.viewerStatusReceived(registry, { epoch: 'epoch-1', status: 'WebGPU · ready' });
// @ts-expect-error an unknown form field must not compile
workbenchActions.formFieldSet(registry, { field: 'notExisting', value: '12' });
// @ts-expect-error the payload is required
workbenchActions.formFieldSet(registry);
// @ts-expect-error the value must stay a string
workbenchActions.formFieldSet(registry, { field: 'lotCount', value: 12 });
// @ts-expect-error a required action argument cannot be omitted
viewerActions.viewerMounted(registry);
// @ts-expect-error a required nested payload field cannot be omitted
twinPageActions.mesJobSet(registry, { index: 1 });
// @ts-expect-error optional union values are still narrowed
twinPageUiActions.sidebarTabSet(registry, 'not-a-tab');
