import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useMemo } from 'react';
import { researchEventsResource } from '@/api/research.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import type { FabToolState } from '@/domain/fab-layout';
import { ResearchReplay, type ResearchSnapshot } from '@/domain/simulation-research-replay';
import { projectReplayStates } from '@/domain/simulation-twin-equipment';
import { twinUiActions } from '@/twin/twin-ui.atom';
import type { EntryMode } from '@/twin/twin-state';

export interface TwinResearchPlaybackParams {
  mode: EntryMode;
  researchTime: number;
  researchPlaying: boolean;
  researchSpeed: 1 | 10 | 100 | 500;
  replayBase: readonly FabToolState[];
  t: (text: string, parameters?: readonly unknown[]) => string;
}

export interface TwinResearchPlayback {
  research?: ResearchReplay;
  loading: boolean;
  /** Localised query failure message ('' when there is none). */
  error: string;
  /** A16: parse failure is a distinct visible state, never folded into the network error. */
  parseError: string;
  snapshot?: ResearchSnapshot;
  replayProjection?: ReturnType<typeof projectReplayStates>;
  setResearchPlaying(playing: boolean): void;
  setResearchTime(timeSec: number): void;
  setResearchSpeed(speed: 1 | 10 | 100 | 500): void;
}

/**
 * Research replay projection. Owns the JSONL query, the parse/error split, the
 * per-time snapshot projection and the 100 ms advance clock; the page keeps only
 * the subscribed UI values it renders.
 */
export function useResearchPlayback({
  mode,
  researchTime,
  researchPlaying,
  researchSpeed,
  replayBase,
  t,
}: TwinResearchPlaybackParams): TwinResearchPlayback {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const researchView = useResource(appRuntime, researchEventsResource, { enabled: mode === 'research' });

  // A16: a parse failure is a distinct, visible state; it must not silently become
  // undefined and only reuse the network error owned by the Query.
  const researchParse = useMemo<{ replay?: ResearchReplay; error: string }>(() => {
    if (!researchView.data) return { replay: undefined, error: '' };
    try {
      return { replay: ResearchReplay.parse(researchView.data), error: '' };
    } catch (error) {
      return { replay: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }, [researchView.data]);
  const research = researchParse.replay;
  const researchParseError = researchParse.error;
  const researchLoading = mode === 'research' && researchView.isInitial;
  const researchError = researchView.isError ? t('回放数据加载失败') : '';

  useEffect(() => {
    if (!research) return;
    twinUiActions.researchSeek(registry, Math.min(3600, research.durationSec));
  }, [research, registry]);

  useEffect(() => {
    if (!researchPlaying || !research) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = ((now - last) / 1000) * researchSpeed;
      last = now;
      twinUiActions.researchAdvance(registry, { deltaSec: elapsed, durationSec: research.durationSec });
    }, 100);
    return () => window.clearInterval(timer);
  }, [researchPlaying, research, researchSpeed, registry]);

  const researchSnapshot = (research?.snapshot(researchTime));
  const replayProjection = (researchSnapshot ? projectReplayStates(researchSnapshot, replayBase) : undefined);

  function setResearchPlaying(playing: boolean): void {
    twinUiActions.researchPlay(registry, playing);
  }

  function setResearchTime(timeSec: number): void {
    twinUiActions.researchSeek(registry, timeSec);
  }

  function setResearchSpeed(speed: 1 | 10 | 100 | 500): void {
    twinUiActions.researchSpeedSet(registry, speed);
  }

  return {
    research,
    loading: researchLoading,
    error: researchError,
    parseError: researchParseError,
    snapshot: researchSnapshot,
    replayProjection,
    setResearchPlaying,
    setResearchTime,
    setResearchSpeed,
  };
}
