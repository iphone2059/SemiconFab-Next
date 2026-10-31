import { RegistryContext } from '@effect/atom-react';
import { useContext, useEffect, useRef } from 'react';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { browserTwinDemoScheduler, TwinDemoClockRuntime } from '@/twin/twin-demo-clock-runtime';
import type { StatusSource } from '@/twin/twin-state';
export function useTwinDemoClock(statusSource: StatusSource, demoPlaying: boolean): void {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const runtimeRef = useRef<TwinDemoClockRuntime | null>(null);
  useEffect(() => {
    const runtime = new TwinDemoClockRuntime({ appRuntime, registry, scheduler: browserTwinDemoScheduler });
    runtimeRef.current = runtime;
    runtime.configure(statusSource, demoPlaying);
    return () => {
      runtimeRef.current = null;
      runtime.dispose();
    };
  }, [appRuntime, registry]);
  useEffect(() => {
    runtimeRef.current?.configure(statusSource, demoPlaying);
  }, [appRuntime, registry, statusSource, demoPlaying]);
}
