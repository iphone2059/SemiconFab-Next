import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { AppProviders } from './app/providers/AppProviders';
import { router } from './app/router/router';
import '../assets/styles.css';
import '../assets/twin.css';
import '../assets/original-twin-hud.css';

const container = document.getElementById('root');
if (!container) throw new Error('Application root element is missing.');
// The router owns top-level navigation, including the permanent legacy aliases
// (/twin, /preview, /catalog, /compare, /workbench) implemented by the catch-all
// route; /preview therefore follows the same alias path as every other legacy URL.
createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
