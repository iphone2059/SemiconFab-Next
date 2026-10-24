import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CatalogPage } from './catalog-page';
import { readCatalogRoute } from './catalog-data';
import { PreviewPage } from './preview-page';
import { TwinPage } from './twin-page';
import { ErrorBoundary } from './error-boundary';
import WorkbenchApp from './workbench';
import '../assets/styles.css';
import '../assets/twin.css';

const container = document.getElementById('root');
if (!container) throw new Error('Application root element is missing.');
const route = readCatalogRoute(new URL(location.href));
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {route.view === 'workbench' ? (
        <WorkbenchApp />
      ) : route.view === 'twin' ? (
        <TwinPage />
      ) : route.view === 'preview' ? (
        <PreviewPage />
      ) : (
        <CatalogPage view={route.view === 'compare' ? 'compare' : 'catalog'} />
      )}
    </ErrorBoundary>
  </StrictMode>,
);
