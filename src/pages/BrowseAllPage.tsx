import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CategoryDetailPage from './CategoryDetailPage';
import NyxDropdown from '../components/Common/NyxDropdown';
import type { CategoryItem } from '../components/Lists/CategoryDetailCard';
import type { LightIndexes } from '../types/lightIndex';
import { getIconUrl } from '../types/lightIndex';
import type { NavigateToContent } from '../types/navigation';

interface BrowseAllPageProps {
  type: 'movies' | 'series';
  lightIndexes: LightIndexes;
  onNavigateToContent: NavigateToContent;
  onBack: () => void;
}

type SortKey = 'newest' | 'oldest' | 'az' | 'za';

/** Whole catalogue of movies or TV shows in the virtualized grid of "See all", with sort and category filter */
const BrowseAllPage: React.FC<BrowseAllPageProps> = ({ type, lightIndexes, onNavigateToContent, onBack }) => {
  const { t } = useTranslation('navigation');
  const [sort, setSort] = useState<SortKey>('newest');
  const [category, setCategory] = useState('all');

  const categoryOptions = useMemo(() => {
    const kind = type === 'movies' ? 'movie' : 'series';
    const list = [...lightIndexes.categories.values()]
      .filter((c) => c.type === kind)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
    return [{ value: 'all', label: t('filter_all_categories') }, ...list];
  }, [type, lightIndexes.categories, t]);

  const sortOptions = useMemo(() => [
    { value: 'newest', label: t('sort_newest') },
    { value: 'oldest', label: t('sort_oldest') },
    { value: 'az', label: t('sort_az') },
    { value: 'za', label: t('sort_za') },
  ], [t]);

  const items = useMemo(() => {
    const prefixes = lightIndexes.iconPrefixes;
    const source = type === 'movies' ? [...lightIndexes.movies.values()] : [...lightIndexes.series.values()];
    const filtered = category === 'all' ? source : source.filter((i) => i.categoryId === category);
    filtered.sort((a, b) => {
      switch (sort) {
        case 'oldest': return a.added - b.added;
        case 'az': return a.name.localeCompare(b.name);
        case 'za': return b.name.localeCompare(a.name);
        default: return b.added - a.added;
      }
    });
    return filtered.map((i) =>
      type === 'movies'
        ? { name: i.name, stream_id: i.id, tmdb: i.tmdbId, stream_icon: getIconUrl(i, prefixes), category_id: i.categoryId }
        : { name: i.name, series_id: i.id, tmdb: i.tmdbId, cover: getIconUrl(i, prefixes), category_id: i.categoryId },
    );
  }, [type, lightIndexes, sort, category]);

  return (
    <CategoryDetailPage
      // Back at the top of the grid whenever the list changes
      key={`${type}-${sort}-${category}`}
      categoryName={t(type)}
      items={items as unknown as CategoryItem[]}
      type={type}
      onNavigateToContent={onNavigateToContent}
      onBack={onBack}
      headerExtra={
        <>
          <NyxDropdown
            value={category}
            onChange={setCategory}
            options={categoryOptions}
            id={`browse-category-${type}`}
            testId="browse-filter-category"
          />
          <NyxDropdown
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={sortOptions}
            id={`browse-sort-${type}`}
            testId="browse-filter-sort"
          />
        </>
      }
    />
  );
};

export default BrowseAllPage;
