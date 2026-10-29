import { rootRoute } from './root.route';
import { homeRoute } from './home.route';
import { equipmentRoute } from './equipment.route';
import { equipmentIndexRoute } from './equipment-index.route';
import { equipmentCompareRoute } from './equipment-compare.route';
import { fab3dRoute } from './fab-3d.route';

/** Explicit code-based route tree; no file generation plugin or routeTree.gen.ts. */
export const routeTree = rootRoute.addChildren([
  homeRoute,
  equipmentRoute.addChildren([equipmentIndexRoute, equipmentCompareRoute]),
  fab3dRoute,
]);
