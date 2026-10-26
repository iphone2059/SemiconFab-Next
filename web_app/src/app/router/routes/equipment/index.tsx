import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../../../catalog-page';

/** Canonical equipment catalog URL (was /catalog, /catalog-demo). */
export const Route = createFileRoute('/equipment/')({
  component: EquipmentCatalogRoute,
});

function EquipmentCatalogRoute() {
  return <CatalogPage view="catalog" />;
}
