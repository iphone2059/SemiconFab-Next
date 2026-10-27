import { useTwinPageStore } from '../../state/twinPageStore';
import { useTwinUiStore } from '../../state/twinUiStore';

/**
 * AMHS statistics are pushed from the scene frame loop to the page store at
 * ~10 Hz. These readouts subscribe to exactly that slice, so the AMHS cadence
 * updates only the two small display nodes instead of the whole TwinContent
 * tree (and its FabViewport child).
 */
export function AmhsOhtReadout() {
  const research = useTwinUiStore((state) => state.entryMode === 'research');
  const active = useTwinPageStore((state) => state.amhs?.active ?? 0);
  const total = useTwinPageStore((state) => state.amhs?.total ?? 24);
  return <span>{research ? 'JSONL display only' : `AMHS OHT ${String(active).padStart(2, '0')}/${total}`}</span>;
}

/** Research replay variant of the same AMHS slice. */
export function AmhsResearchBadge() {
  const completed = useTwinPageStore((state) => state.amhs?.completed ?? 0);
  const averageDelivery = useTwinPageStore((state) => state.amhs?.avgDelivery);
  const active = useTwinPageStore((state) => state.amhs?.active ?? 0);
  return (
    <div id="research-amhs-badge" className="twin-research-amhs">AMHS SIMULATED · jobs {completed} · avg {averageDelivery?.toFixed(1) ?? '—'} s · active {active}/24</div>
  );
}
