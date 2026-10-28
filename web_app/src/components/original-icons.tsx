// SVG paths captured from the original twin.html controls (2026-10-24).
// Original page uses Lucide icons. Provenance: docs/attribution.md.
//
// Render entry only; the frozen geometry lives in original-icons-data.ts.
import { createElement, type ReactNode } from 'react';
import { ORIGINAL_ICONS, type IconShape } from './original-icons-data';

const attrs = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
function shapeNode(shape: IconShape, key: number): ReactNode {
  return createElement(shape.tag, { ...attrs(shape.attrs), key }, ...shape.children.map(shapeNode));
}
export function OriginalIcon({ name, size = 12 }: { name: keyof typeof ORIGINAL_ICONS; size?: number }) {
  const icon = ORIGINAL_ICONS[name];
  if (!icon) return null;
  return createElement('svg', { ...attrs(icon.attrs), width: size, height: size, 'aria-hidden': true, focusable: false, style: { flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' } }, ...icon.children.map(shapeNode));
}
