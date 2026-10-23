import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CatalogPage } from './catalog-page';
import { readCatalogRoute } from './catalog-data';
import { ErrorBoundary } from './error-boundary';
import WorkbenchApp from './workbench';
import '../assets/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Application root element is missing.');
const route = readCatalogRoute(new URL(location.href));
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {route.view === 'workbench' ? <WorkbenchApp /> : <CatalogPage view={route.view} />}
    </ErrorBoundary>
  </StrictMode>,
);
