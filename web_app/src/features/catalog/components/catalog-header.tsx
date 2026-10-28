import type { MouseEvent } from 'react';
import type { Preferences } from '../../../state/preferences';
import { text, type Language } from '../labels';
import type { CatalogView } from '../types';

export interface CatalogHeaderProps {
  view: CatalogView;
  language: Language;
  theme: Preferences['theme'];
  hrefFor: (next: CatalogView) => string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, next: CatalogView) => void;
  onToggleLanguage: () => void;
  onToggleTheme: () => void;
}

/** Catalog shell header: brand, canonical view links and locale controls. */
export function CatalogHeader({
  view,
  language,
  theme,
  hrefFor,
  onNavigate,
  onToggleLanguage,
  onToggleTheme,
}: CatalogHeaderProps) {
  return (
    <header className="catalog-header">
      <a className="catalog-brand" href="/">
        SEMICON<span>FAB</span>
        <small>NEXT</small>
      </a>
      <nav aria-label={text(language, '主导航', 'Main navigation')}>
        <a href="/">{text(language, '基地工作台', 'Workbench')}</a>
        <a
          className={view === 'catalog' ? 'active' : ''}
          href={hrefFor('catalog')}
          onClick={(event) => onNavigate(event, 'catalog')}
        >
          {text(language, '设备目录', 'Catalog')}
        </a>
        <a
          className={view === 'compare' ? 'active' : ''}
          href={hrefFor('compare')}
          onClick={(event) => onNavigate(event, 'compare')}
        >
          {text(language, '设备对比', 'Compare')}
        </a>
      </nav>
      <div className="catalog-preferences">
        <button onClick={onToggleLanguage}>
          {language === 'zh' ? 'EN' : '中文'}
        </button>
        <button
          aria-label={text(language, '切换主题', 'Toggle theme')}
          onClick={onToggleTheme}
        >
          {theme === 'light' ? '◐' : '☀'}
        </button>
      </div>
    </header>
  );
}
