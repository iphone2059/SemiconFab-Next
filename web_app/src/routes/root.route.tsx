import { createRootRouteWithContext, Outlet, type ErrorComponentProps } from '@tanstack/react-router';
import type { AppRuntime } from '@/app/app-runtime';
import { ErrorBoundary } from '@/components/error-boundary';
import { decodeRouterSearch } from './route-search';

export interface RouterContext {
  /** The single application-owned runtime/registry shared with the React tree. */
  appRuntime: AppRuntime<never>;
}

function RootComponent() {
  return (
    <ErrorBoundary>
      <Outlet />
    </ErrorBoundary>
  );
}

function RootError({ error }: ErrorComponentProps) {
  return (
    <div className="fatal" role="alert">
      <h1>页面无法显示 / Page failed to render</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <a href="/">返回工作台 / Back to workbench</a>
    </div>
  );
}

const RootNotFound = () => (
  <div className="fatal" role="alert">
    <h1>页面不存在 / Page not found</h1>
    <a href="/">返回工作台 / Back to workbench</a>
  </div>
);

/**
 * Code-based root route: one global search schema keeps lang/theme/... parsed on
 * every canonical path; there are no legacy aliases or redirects.
 */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: decodeRouterSearch,
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
});
