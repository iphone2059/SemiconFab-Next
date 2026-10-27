import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../../../catalog-page';
import type { RouterSearch } from '../../search';

/** Canonical equipment comparison URL. The router owns URL/search state. */
export const Route = createFileRoute('/equipment/compare')({
  component: EquipmentCompareRoute,
});

function EquipmentCompareRoute() {
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
  return <CatalogPage view="compare" search={search} onSearchChange={updateSearch} onViewChange={changeView} />;
}
