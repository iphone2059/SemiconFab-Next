import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Layout for the final /fabs/$fabId URL namespace. The overview entry
 * (routes/fabs/$fabId/index.tsx) redirects to /3d in M1; the URL itself is final
 * and must not be renamed when the overview page arrives in a later milestone.
 */
export const Route = createFileRoute('/fabs/$fabId')({
  component: FabRouteLayout,
});

function FabRouteLayout() {
  return <Outlet />;
}
