import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../../../features/catalog/catalog-page';
import type { RouterSearch } from '../../search';

/** Canonical equipment catalog URL. The router owns URL/search state. */
export const Route = createFileRoute('/equipment/')({
  component: EquipmentCatalogRoute,
});

function EquipmentCatalogRoute() {
  const search = Route.useSearch() as RouterSearch;
  const navigate = Route.useNavigate();
  const updateSearch = useCallback((patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  }, [navigate]);
  const changeView = useCallback((next: 'catalog' | 'compare', patch: Partial<RouterSearch>) => {
    void navigate({
      to: next === 'compare' ? '/equipment/compare' : '/equipment',
      search: (prev: RouterSearch) => ({ ...prev, ...patch }),
    });
  }, [navigate]);
  return <CatalogPage view="catalog" search={search} onSearchChange={updateSearch} onViewChange={changeView} />;
}
