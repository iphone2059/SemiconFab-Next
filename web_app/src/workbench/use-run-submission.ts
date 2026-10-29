import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CreateRunRequest, SiteDto } from '@/contracts/app-contracts';
import { ScopeGate, type ScopeToken } from '@/runtime/scope-gate';
import { validateScenario } from '@/domain/simulation-scenario';
import { createRun } from '@/api/runs.mutation';
import { refreshResource } from '@/api/resource';
import { runsResource } from '@/api/runs.resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { workbenchAtom, workbenchActions } from '@/workbench/workbench.atom';
import type { WorkbenchFormState } from '@/workbench/workbench.atom';
import { errorMessage } from '@/workbench/error-message';

export interface RunSubmission {
  submit(event: FormEvent<HTMLFormElement>): Promise<void>;
  submitting: boolean;
}

interface PendingSubmission {
  readonly json: string;
  readonly key: string;
}

/**
 * Run-submission controller: a UI command lifecycle, never a Query cache.
 *
 * TanStack Query stays the single owner of the server snapshots (list, detail,
 * results). This controller only owns the transient submission state:
 *  - the idempotency key is reused while retrying the exact same scenario JSON,
 *  - a completion/failure is applied only when the component is still mounted and
 *    the store still selects the site that submitted it (no cross-site writes).
 * The created run is recorded as the selected run id; the response payload is
 * never copied into the store.
 */
export function useRunSubmission(site: SiteDto, form: WorkbenchFormState): RunSubmission {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const [submitting, setSubmitting] = useState(false);
  const submissionScope = useMemo(() => new ScopeGate(), [registry]);
  const pending = useRef<PendingSubmission | undefined>(undefined);
  useEffect(() => () => submissionScope.dispose(), [submissionScope, registry]);

  function accepts(token: ScopeToken): boolean {
    return submissionScope.accepts(token) && registry.get(workbenchAtom).siteId === site.siteId;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    workbenchActions.submitErrorSet(registry, '');
    if (site.fabs.length === 0) {
      workbenchActions.submitErrorSet(registry, '当前站点没有可用的 FAB');
      return;
    }
    const validationError = validateScenario(form);
    if (validationError) {
      workbenchActions.submitErrorSet(registry, validationError);
      return;
    }
    const request: CreateRunRequest = {
      scenario: {
        contractVersion: 1,
        siteId: site.siteId,
        mode: 'INDEPENDENT',
        masterSeed: form.masterSeed,
        durationUs: form.durationUs,
        warmupUs: form.warmupUs,
        // One execution per site FAB; the catalog is data-driven, never a fixed count.
        fabs: site.fabs.map((member) => ({
          fabId: member.fabId,
          code: member.code,
          lotCount: Number(form.lotCount),
          processTimeUs: form.processTimeUs,
        })),
      },
    };
    const json = JSON.stringify(request);
    const key = pending.current?.json === json ? pending.current.key : crypto.randomUUID();
    pending.current = { json, key };
    const token = submissionScope.begin(site.siteId);
    setSubmitting(true);
    try {
      const created = await appRuntime.runPromise(createRun({ request, idempotencyKey: key }));
      if (accepts(token)) {
        pending.current = undefined;
        workbenchActions.runIdSet(registry, created.runId);
        // Resource invalidation is precise: only the runs list is refreshed.
        void refreshResource(appRuntime, runsResource).catch(() => {});
      }
    } catch (error: unknown) {
      if (accepts(token)) workbenchActions.submitErrorSet(registry, errorMessage(error));
    } finally {
      if (accepts(token)) setSubmitting(false);
    }
  }

  return { submit, submitting };
}
