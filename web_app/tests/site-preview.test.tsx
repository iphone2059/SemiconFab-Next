import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SiteDto } from '../src/contracts';
import { SitePreview } from '../src/site-preview';

const site: SiteDto = {
  siteId: 'site-demo',
  code: 'DEMO-SITE',
  templateHash: 'template-demo',
  fabs: [{ fabId: 'fab-1', code: 'FAB-01' }],
};

it('renders the preview chrome with a new-tab preview control', () => {
  const html = renderToStaticMarkup(<SitePreview site={site} />);
  expect(html).toContain('基地空间概览');
  expect(html).toContain('class="panel site-preview"');
  expect(html).toContain('aria-label="在新标签页打开 FAB 预览"');
  expect(html).toContain('aria-label="等轴视图"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="俯视视图"');
  expect(html).toContain('aria-label="重置视角"');
  expect(html).toContain('SITE DIGITAL VIEW');
  expect(html).toContain('DEMO-SITE / FAB-01');
  expect(html).toContain('单 FAB 视图');
  expect(html).toContain('aria-label="场景工具栏"');
  expect(html).not.toContain('aria-label="选择当前 FAB"');
  expect(html).not.toContain('FAB-02');
  expect(html).toContain('<canvas');
  expect(html).toContain('FAB 基地估算占位几何');
  expect(html).not.toContain('<iframe');
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain('scene-rail');
  expect(html).not.toContain('preview-backdrop');
});
