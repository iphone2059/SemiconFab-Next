import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ORIGINAL_ICONS } from '../../src/components/original-icons-data';
import { OriginalIcon } from '../../src/components/original-icons';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The icon inventory is captured from the original twin.html. Splitting pure
 * data from the render entry is only allowed while the exact SVG geometry and
 * the rendered markup stay byte-identical, so both are pinned by golden hashes.
 */
describe('original icon inventory', () => {
  it('keeps the captured frozen geometry byte-identical', () => {
    expect(Object.keys(ORIGINAL_ICONS)).toHaveLength(69);
    expect(sha256(JSON.stringify(ORIGINAL_ICONS))).toBe(
      'f2d8f14092752daf70884d08f103db40a8581b221ce863069b6df1c778ca3200',
    );
    expect(ORIGINAL_ICONS.airflow.children[0].attrs.d).toBe('M12.8 19.6A2 2 0 1 0 14 16H2');
    expect(ORIGINAL_ICONS.pause.children.map((shape) => shape.tag)).toEqual(['rect', 'rect']);
  });

  it('renders every icon to its exact frozen SVG markup', () => {
    const markup = Object.keys(ORIGINAL_ICONS)
      .map((name) => renderToStaticMarkup(createElement(OriginalIcon, { name, size: 12 })))
      .join('\n');
    expect(sha256(markup)).toBe(
      '603d85f10050c61c994481ff94bf5f16d20c74ad3b809e739dc25d0ea310abfc',
    );
    expect(renderToStaticMarkup(createElement(OriginalIcon, { name: 'pause' }))).toContain(
      '<rect x="6" y="4" width="4" height="16" rx="1"></rect>',
    );
    expect(renderToStaticMarkup(createElement(OriginalIcon, { name: 'airflow' }))).toContain(
      'd="M12.8 19.6A2 2 0 1 0 14 16H2"',
    );
  });

  it('keeps the captured data module free of rendering/React imports', () => {
    const data = readFileSync(new URL('../../src/components/original-icons-data.ts', import.meta.url), 'utf8');
    expect(data).not.toMatch(/from 'react'|from "react"/);
    expect(data).not.toMatch(/createElement|ReactDOM/);
  });
});
