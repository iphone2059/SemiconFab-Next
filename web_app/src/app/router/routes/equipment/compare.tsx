import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../../../catalog-page';

/** Canonical equipment comparison URL (was /compare, /compare.html). */
export const Route = createFileRoute('/equipment/compare')({
  component: EquipmentCompareRoute,
});

function EquipmentCompareRoute() {
  return <CatalogPage view="compare" />;
}
