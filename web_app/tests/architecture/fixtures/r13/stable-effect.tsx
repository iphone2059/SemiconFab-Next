// R13 positive fixture: useEffectEvent + ref indirection are the documented stable primitives.
import { useEffect, useEffectEvent, useRef } from 'react';

export interface StableReportProps {
  readonly label: string;
  readonly onReport: (text: string) => void;
}

export function StableReport({ label, onReport }: StableReportProps) {
  const latest = useRef({ label, onReport });
  latest.current = { label, onReport };
  const report = useEffectEvent(() => {
    latest.current.onReport(latest.current.label);
  });
  useEffect(() => {
    report();
  }, []);
  return null;
}
