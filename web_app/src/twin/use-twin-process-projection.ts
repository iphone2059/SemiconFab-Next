import { useMemo } from 'react';
import type { PickedTool } from '@/contracts/scene.port';
import { FAB_LAYOUT, type FabToolState } from '@/domain/fab-layout';
import { buildTelemetry, computeSpc, createMesJob, type MesJob, type SpcResult, type Telemetry } from '@/domain/fab-process-control';

export interface SpcPlot {
  points: string;
  meanY: number;
  uclY: number;
  lclY: number;
}

export interface TwinProcessProjectionParams {
  selected?: PickedTool;
  toolStates: readonly FabToolState[];
  mesJobs: Record<number, MesJob>;
}

export interface TwinProcessProjection {
  selectedTelemetry?: Telemetry;
  selectedSpc?: SpcResult;
  selectedMes?: MesJob;
  spcPlot?: SpcPlot;
}

/**
 * Pure projection cluster for the selected tool: telemetry, SPC control/spec
 * judgement, MES job and the sparkline geometry. These are render-only values
 * derived from the page slice; no store writes or effects belong here.
 */
export function useTwinProcessProjection({ selected, toolStates, mesJobs }: TwinProcessProjectionParams): TwinProcessProjection {
  const selectedTelemetry = useMemo(
    () => selected ? buildTelemetry(FAB_LAYOUT[selected.index], selected.index) : undefined,
    [selected?.index],
  );
  const selectedSpc = useMemo(
    () => selectedTelemetry
      ? computeSpc(selectedTelemetry.history, selectedTelemetry.sensors[0], toolStates[selected?.index ?? 0] === 'down')
      : undefined,
    [selectedTelemetry, toolStates, selected?.index],
  );
  const selectedMes = selected ? mesJobs[selected.index] ?? createMesJob(FAB_LAYOUT[selected.index], selected.index, Date.now()) : undefined;
  const spcPlot = useMemo<SpcPlot | undefined>(() => {
    if (!selectedTelemetry) return undefined;
    const values = selectedTelemetry.history;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = high - low || 1;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)) || 0.001;
    return {
      points: values.map((value, index) => `${(index / (values.length - 1)) * 240},${30 - ((value - low) / range) * 26 - 2}`).join(' '),
      meanY: 30 - ((mean - low) / range) * 26 - 2,
      uclY: 30 - ((mean + 3 * std - low) / range) * 26 - 2,
      lclY: 30 - ((mean - 3 * std - low) / range) * 26 - 2,
    };
  }, [selectedTelemetry]);

  return { selectedTelemetry, selectedSpc, selectedMes, spcPlot };
}
