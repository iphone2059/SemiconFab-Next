import { createRoute, Outlet } from '@tanstack/react-router';
import { rootRoute } from './root.route';
import { decodeRouterSearch } from './route-search';

/** Layout for the final /equipment URL namespace (catalog + comparison). */
export const equipmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/equipment',
  validateSearch: decodeRouterSearch,
  component: EquipmentRouteLayout,
});

function EquipmentRouteLayout() {
  return <Outlet />;
}
