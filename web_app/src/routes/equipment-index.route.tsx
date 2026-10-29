
import { createRoute } from '@tanstack/react-router';
import { CatalogPage } from '@/catalog/catalog-page';
import type { RouterSearch } from './route-search';
import { decodeRouterSearch } from './route-search';
import { equipmentRoute } from './equipment.route';

/** Canonical equipment catalog URL. The router owns URL/search state. */
export const equipmentIndexRoute = createRoute({
  getParentRoute: () => equipmentRoute,
  path: '/',
  validateSearch: decodeRouterSearch,
  component: EquipmentCatalogRoute,
});

function EquipmentCatalogRoute() {
  const search = equipmentIndexRoute.useSearch();
  const navigate = equipmentIndexRoute.useNavigate();
  const updateSearch = (patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  };
  const changeView = (next: 'catalog' | 'compare', patch: Partial<RouterSearch>) => {
    void navigate({
      to: next === 'compare' ? '/equipment/compare' : '/equipment',
      search: (prev: RouterSearch) => ({ ...prev, ...patch }),
    });
  };
  return <CatalogPage view="catalog" search={search} onSearchChange={updateSearch} onViewChange={changeView} />;
}
