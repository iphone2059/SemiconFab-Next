import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import WorkbenchApp from '../src/workbench';
import { readCatalogRoute } from '../src/catalog-data';

it('has a single standalone 3D route; old preview links resolve to Twin', () => {
  for (const path of ['/twin', '/twin.html', '/preview', '/preview.html']) {
    expect(readCatalogRoute(new URL(`https://example.test${path}`)).view).toBe('twin');
  }
});

it('keeps the website entrance free of 3D preview rendering', () => {
  const html = renderToStaticMarkup(<WorkbenchApp />);
  expect(html).toContain('href="/twin"');
  expect(html).not.toContain('<canvas');
  expect(html).not.toContain('SITE DIGITAL VIEW');
  expect(html).not.toContain('预览');
  expect(html).not.toContain('/preview');
});
