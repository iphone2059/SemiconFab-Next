import { createActor } from 'xstate';
import { expect, it } from 'vitest';
import { twinTourMachine } from '@/twin/twin-tour.machine';
it('owns the active lifecycle and retains the last waypoint after stopping', () => {
  const actor = createActor(twinTourMachine);
  actor.start();
  expect(actor.getSnapshot().matches('idle')).toBe(true);
  actor.send({ type: 'WAYPOINT', waypoint: 4 });
  expect(actor.getSnapshot().context.waypoint).toBe(0);
  actor.send({ type: 'START' });
  expect(actor.getSnapshot().matches('running')).toBe(true);
  actor.send({ type: 'WAYPOINT', waypoint: 3 });
  expect(actor.getSnapshot().context.waypoint).toBe(3);
  actor.send({ type: 'STOP' });
  expect(actor.getSnapshot().matches('idle')).toBe(true);
  expect(actor.getSnapshot().context.waypoint).toBe(3);
  actor.stop();
});
