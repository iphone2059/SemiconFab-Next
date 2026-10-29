import { createContext, useContext, type ReactNode } from 'react';
import type { AppRuntime } from '@/app/app-runtime';

const AppRuntimeContext = createContext<AppRuntime<never> | null>(null);

/** Supplies the application-owned runtime; never creates a second runtime/registry. */
export function AppRuntimeProvider({ runtime, children }: { runtime: AppRuntime<never>; children: ReactNode }) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>;
}

export function useAppRuntime(): AppRuntime<never> {
  const runtime = useContext(AppRuntimeContext);
  if (!runtime) throw new Error('useAppRuntime must be used inside AppProviders/AppRuntimeProvider');
  return runtime;
}
