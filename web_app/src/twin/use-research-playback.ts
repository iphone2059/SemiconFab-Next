import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { researchEventsDefinition } from '@/api/research.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import type { FabToolState } from '@/domain/fab-layout';
import type { ResearchSnapshot } from '@/domain/simulation-research-replay';
import type { projectReplayStates } from '@/domain/simulation-twin-equipment';
import { initialTwinResearchProjection, twinResearchAtom, type TwinResearchSpeed } from '@/twin/twin-research.atom';
import { browserTwinResearchScheduler, registerTwinResearchRuntime, TwinResearchRuntime, type TwinResearchScheduler } from '@/twin/twin-research-runtime';
import type { EntryMode } from '@/twin/twin-state';
export interface TwinResearchPlaybackParams {
  readonly mode: EntryMode;
  readonly replayBase: readonly FabToolState[];
  readonly scopeKey: string;
  readonly scheduler?: TwinResearchScheduler;
  readonly t: (text: string, parameters?: readonly unknown[]) => string;
}
export interface TwinResearchPlayback {
  readonly initialized: boolean;
  readonly research?: { readonly durationSec: number; readonly eventCount: number };
  readonly researchTime: number;
  readonly researchPlaying: boolean;
  readonly researchSpeed: TwinResearchSpeed;
  readonly loading: boolean;
  readonly error: string;
  readonly parseError: string;
  readonly snapshot?: ResearchSnapshot;
  readonly replayProjection?: ReturnType<typeof projectReplayStates>;
  setResearchPlaying(playing: boolean): void;
  setResearchTime(timeSec: number): void;
  setResearchSpeed(speed: TwinResearchSpeed): void;
}
export function useResearchPlayback({
  mode,
  replayBase,
  scopeKey,
  scheduler = browserTwinResearchScheduler,
  t,
}: TwinResearchPlaybackParams): TwinResearchPlayback {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const runtimeRef = useRef<TwinResearchRuntime | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const eventsView = useResource(appRuntime, researchEventsDefinition, { enabled: mode === 'research' });
  const stored = useAtomValue(twinResearchAtom);
  const projection = stored.scopeKey === scopeKey ? stored : initialTwinResearchProjection;
  useEffect(() => {
    const runtime = new TwinResearchRuntime({ appRuntime, registry, scheduler, replayBase, scopeKey });
    runtimeRef.current = runtime;
    const unregister = registerTwinResearchRuntime(registry, runtime);
    setInitialized(true);
    setRuntimeGeneration(generation => generation + 1);
    return () => {
      runtimeRef.current = null;
      unregister();
      runtime.dispose();
    };
  }, [appRuntime, registry, scheduler, scopeKey]);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (mode === 'research') runtime.enter();
    else runtime.exit();
  }, [mode, runtimeGeneration]);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (mode === 'research' && eventsView.data !== undefined && runtime) runtime.setEvents(eventsView.data);
  }, [mode, eventsView.data, runtimeGeneration]);
  useEffect(() => {
    runtimeRef.current?.setReplayBase(replayBase);
  }, [replayBase, runtimeGeneration]);
  function currentRuntime(): TwinResearchRuntime {
    const runtime = runtimeRef.current;
    if (runtime === null) throw new Error('TwinResearchRuntime is not mounted');
    return runtime;
  }
  return {
    initialized,
    research: projection.snapshot ? { eventCount: projection.eventCount, durationSec: projection.durationSec } : undefined,
    researchTime: projection.timeSec,
    researchPlaying: projection.status === 'playing',
    researchSpeed: projection.speed,
    loading: mode === 'research' && (eventsView.isInitial || projection.status === 'loading'),
    error: mode === 'research' && eventsView.isError && projection.snapshot === undefined ? t('回放数据加载失败') : '',
    parseError: projection.parseError,
    snapshot: projection.snapshot,
    replayProjection: projection.replayProjection,
    setResearchPlaying: playing => {
      if (playing) currentRuntime().play();
      else currentRuntime().pause();
    },
    setResearchTime: timeSec => currentRuntime().seek(timeSec),
    setResearchSpeed: speed => currentRuntime().setSpeed(speed),
  };
}