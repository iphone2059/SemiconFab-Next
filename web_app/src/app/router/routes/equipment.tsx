import { createFileRoute, Outlet } from '@tanstack/react-router';

/** Layout for the final /equipment URL namespace (catalog + comparison). */
export const Route = createFileRoute('/equipment')({
  component: EquipmentRouteLayout,
});

function EquipmentRouteLayout() {
  return <Outlet />;
}
