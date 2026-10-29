import type { ReactNode } from 'react';
import { safeExternalUrl } from '@/catalog/catalog-data';

/**
 * The only way catalog provenance becomes a link. Unsafe schemes (javascript:,
 * data:, file:, credentials, malformed URLs) render their fallback text instead
 * of an anchor, so raw imported strings can never execute.
 */
export function ExternalLink({
  href,
  children,
  fallback,
}: {
  href: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const safe = safeExternalUrl(href);
  if (!safe) return <>{fallback ?? children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
