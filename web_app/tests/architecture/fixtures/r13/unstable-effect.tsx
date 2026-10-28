// R13 negative fixture: an empty-dependency effect capturing changing props/state.
import { useEffect, useState } from 'react';

export interface UnstableReportProps {
  readonly label: string;
  readonly onReport: (text: string) => void;
}

export function UnstableReport({ label, onReport }: UnstableReportProps) {
  const [count] = useState(0);
  useEffect(() => {
    onReport(label + String(count));
  }, []);
  return null;
}
