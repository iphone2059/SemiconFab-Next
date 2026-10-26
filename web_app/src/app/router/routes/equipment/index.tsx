import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../../../catalog-page';

/** Canonical equipment catalog URL. */
export const Route = createFileRoute('/equipment/')({
  component: EquipmentCatalogRoute,
});

function EquipmentCatalogRoute() {
  return <CatalogPage view="catalog" />;
}
