import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { Effect } from 'effect';
import { useEffect, useMemo, useRef, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateRunRequest, SiteDto } from '@/contracts/app-contracts';
import { ScopeGate, type ScopeToken } from '@/runtime/scope-gate';
import { validateScenario } from '@/domain/simulation-scenario';
import { createRun, invalidateRuns } from '@/api/runs.mutation';
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
  const queryClient = useQueryClient();
  const submissionScope = useMemo(() => new ScopeGate(), [registry]);
  const pending = useRef<PendingSubmission | undefined>(undefined);
  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof createRun>[0]) => Effect.runPromise(createRun(input)),
    // The server list/detail/results refresh after acceptance.
    onSuccess: () => {
      void invalidateRuns(queryClient);
    },
  });
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
    try {
      const created = await mutation.mutateAsync({ request, idempotencyKey: key });
      if (accepts(token)) {
        pending.current = undefined;
        workbenchActions.runIdSet(registry, created.runId);
      }
    } catch (error: unknown) {
      if (accepts(token)) workbenchActions.submitErrorSet(registry, errorMessage(error));
    }
  }

  return { submit, submitting: mutation.isPending };
}
