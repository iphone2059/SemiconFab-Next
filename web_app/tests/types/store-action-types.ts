/**
 * Compile-time contract tests for the typed Zustand slice-store actions.
 *
 * Vitest never executes this file (it is not a *.test.* module); it exists so
 * `tsc --noEmit` proves the inference-based action surface is not just "valid
 * code compiles", but that invalid payloads, fields and arities are rejected.
 * If any @ts-expect-error line starts compiling, TypeScript reports the unused
 * directive and fails the typecheck.
 */
import { runtimeActions } from '../../src/state/runtimeStore';
import { twinPageActions } from '../../src/features/twin/state/twinPageStore';
import { workbenchActions } from '../../src/features/workbench/state/workbenchStore';

// Positive controls: the intended shape keeps compiling.
workbenchActions.formFieldSet({ field: 'lotCount', value: '12' });
twinPageActions.siteIdSet('site-1');
twinPageActions.statusFeedStale();
runtimeActions.viewerMounted('epoch-1');
runtimeActions.viewerLifecycleReceived({ epoch: 'epoch-1', event: { type: 'ready', message: 'WebGPU · ready' } });

// @ts-expect-error the viewer lifecycle is a discriminated event, not an arbitrary string
runtimeActions.viewerLifecycleReceived({ epoch: 'epoch-1', event: { type: 'bogus', message: 'x' } });
// @ts-expect-error a recovering event must declare its loss cause
runtimeActions.viewerLifecycleReceived({ epoch: 'epoch-1', event: { type: 'recovering', message: 'x' } });
// @ts-expect-error the string-status action was replaced by the lifecycle action
runtimeActions.viewerStatusReceived({ epoch: 'epoch-1', status: 'WebGPU · ready' });
// @ts-expect-error an unknown form field must not compile
workbenchActions.formFieldSet({ field: 'notExisting', value: '12' });
// @ts-expect-error the payload is required
workbenchActions.formFieldSet();
// @ts-expect-error the value must stay a string
workbenchActions.formFieldSet({ field: 'lotCount', value: 12 });
// @ts-expect-error a required action argument cannot be omitted
runtimeActions.viewerMounted();
// @ts-expect-error a required nested payload field cannot be omitted
twinPageActions.mesJobSet({ index: 1 });
// @ts-expect-error optional union values are still narrowed
twinPageActions.sidebarTabSet('not-a-tab');
