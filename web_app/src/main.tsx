import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { AppProviders } from '@/app/app-providers';
import { router } from '@/routes/router';
import '../assets/styles.css';
import '../assets/twin.css';
import '../assets/original-twin-hud.css';

const container = document.getElementById('root');
if (!container) throw new Error('Application root element is missing.');
// The router owns top-level navigation. Only the canonical V2.1 URLs exist;
// deleted legacy product URLs are an honest not-found page (no redirects).
createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
