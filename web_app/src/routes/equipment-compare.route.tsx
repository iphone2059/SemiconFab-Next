import { useCallback } from 'react';
import { createRoute } from '@tanstack/react-router';
import { CatalogPage } from '@/catalog/catalog-page';
import type { RouterSearch } from './route-search';
import { decodeRouterSearch } from './route-search';
import { equipmentRoute } from './equipment.route';

/** Canonical equipment comparison URL. The router owns URL/search state. */
export const equipmentCompareRoute = createRoute({
  getParentRoute: () => equipmentRoute,
  path: '/compare',
  validateSearch: decodeRouterSearch,
  component: EquipmentCompareRoute,
});

function EquipmentCompareRoute() {
  const search = equipmentCompareRoute.useSearch();
  const navigate = equipmentCompareRoute.useNavigate();
  const updateSearch = useCallback((patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  }, [navigate]);
  const changeView = useCallback((next: 'catalog' | 'compare', patch: Partial<RouterSearch>) => {
    void navigate({
      to: next === 'compare' ? '/equipment/compare' : '/equipment',
      search: (prev: RouterSearch) => ({ ...prev, ...patch }),
    });
  }, [navigate]);
  return <CatalogPage view="compare" search={search} onSearchChange={updateSearch} onViewChange={changeView} />;
}
