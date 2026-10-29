import { useAtomValue } from '@effect/atom-react';
import { twinAmhsAtom } from '@/twin/twin-amhs.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';

/**
 * AMHS statistics are pushed from the scene frame loop to the page store at
 * ~10 Hz. These readouts subscribe to exactly that slice, so the AMHS cadence
 * updates only the two small display nodes instead of the whole TwinContent
 * tree (and its FabViewport child).
 */
export function AmhsOhtReadout() {

  const research = useAtomValue(twinUiAtom, (state) => state.entryMode === 'research');
  const active = useAtomValue(twinAmhsAtom, (state) => state?.active ?? 0);
  const total = useAtomValue(twinAmhsAtom, (state) => state?.total ?? 24);
  return <span>{research ? 'JSONL display only' : `AMHS OHT ${String(active).padStart(2, '0')}/${total}`}</span>;
}

/** Research replay variant of the same AMHS slice. */
export function AmhsResearchBadge() {

  const completed = useAtomValue(twinAmhsAtom, (state) => state?.completed ?? 0);
  const averageDelivery = useAtomValue(twinAmhsAtom, (state) => state?.avgDelivery);
  const active = useAtomValue(twinAmhsAtom, (state) => state?.active ?? 0);
  return (
    <div id="research-amhs-badge" className="twin-research-amhs">AMHS SIMULATED · jobs {completed} · avg {averageDelivery?.toFixed(1) ?? '—'} s · active {active}/24</div>
  );
}
