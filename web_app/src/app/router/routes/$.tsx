import { createFileRoute, redirect, useLocation } from '@tanstack/react-router';
import { firstFabId } from '../../../api/queries/sites.queries';
import { legacyAliasTarget, staticRedirectPath } from '../url-mapping';
import { loadSitesOrRedirect } from '../route-data';

/**
 * Permanent legacy aliases and the honest unknown-path fallback.
 *
 *   /twin, /twin.html, /preview, /preview.html -> /fabs/{firstFabId}/3d
 *   /catalog, /catalog-demo, /catalog-demo.html -> /equipment
 *   /compare, /compare.html                     -> /equipment/compare
 *   /workbench                                  -> /
 *
 * Search params are forwarded unchanged. Unknown paths render a minimal
 * not-found page at the current URL instead of a silent blank screen. Reserved
 * future URLs (/equipment/$equipmentId, /amhs, /alarms) therefore land here
 * until their milestone creates real routes.
 */
export const Route = createFileRoute('/$')({
  beforeLoad: async ({ location, context }) => {
    const alias = legacyAliasTarget(location.pathname);
    if (alias === undefined) return;
    if (alias !== 'twin') throw redirect({ to: staticRedirectPath(alias), search: true, replace: true });
    // Alias resolution uses the sites endpoint from the Query cache; a failed
    // request redirects to the workbench, which owns the error UI.
    const sites = await loadSitesOrRedirect(context.queryClient);
    const fabId = firstFabId(sites);
    if (!fabId) throw redirect({ to: '/', search: true, replace: true });
    throw redirect({ to: '/fabs/$fabId/3d', params: { fabId }, search: true, replace: true });
  },
  component: NotFoundPage,
});

function NotFoundPage() {
  const location = useLocation();
  return (
    <main className="fatal" role="alert">
      <h1>页面不存在 / Page not found</h1>
      <p className="technical">{location.pathname}</p>
      <p>
        <a href="/">返回工作台 / Workbench</a> · <a href="/equipment">设备目录 / Equipment</a>
      </p>
    </main>
  );
}
