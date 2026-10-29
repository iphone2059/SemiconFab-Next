import { categoryText, text, type Language } from '@/catalog/catalog-labels';

export interface CatalogFiltersProps {
  language: Language;
  query: string;
  category: string;
  categories: readonly string[];
  hideDrafts: boolean;
  selectedCount: number;
  onQueryChange: (query: string) => void;
  onCategoryChange: (category: string) => void;
  onHideDraftsChange: (hideDrafts: boolean) => void;
  onCompare: () => void;
}

/** Search, category and draft filters plus the compare entry button. */
export function CatalogFilters({
  language,
  query,
  category,
  categories,
  hideDrafts,
  selectedCount,
  onQueryChange,
  onCategoryChange,
  onHideDraftsChange,
  onCompare,
}: CatalogFiltersProps) {
  return (
    <div className="catalog-filters">
      <label>
        {text(language, '搜索设备', 'Search equipment')}
        <input
          type="search"
          value={query}
          maxLength={200}
          placeholder={text(language, '厂商、型号或分类…', 'Vendor, model or category…')}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <label>
        {text(language, '设备分类', 'Category')}
        <select value={category} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="">{text(language, '所有分类', 'All categories')}</option>
          {category && !categories.includes(category) && <option value={category}>{category}</option>}
          {categories.map((value) => (
            <option key={value} value={value}>
              {categoryText(value, language)}
            </option>
          ))}
        </select>
      </label>
      <label className="catalog-hide-drafts">
        <input
          type="checkbox"
          checked={hideDrafts}
          onChange={(event) => onHideDraftsChange(event.target.checked)}
        />
        {text(language, '隐藏 draft 记录', 'Hide draft records')}
      </label>
      <button disabled={selectedCount === 0} onClick={onCompare}>
        {text(
          language,
          `对比已选 ${selectedCount} / 4`,
          `Compare ${selectedCount} / 4`,
        )}
      </button>
    </div>
  );
}
