/**
 * Catégorie sans nom (Xtream : category_name absent ou vide ; M3U : groupe absent, écrit « — ») :
 * affichée « Sans catégorie » au lieu d'un titre de rangée vide ou d'un tiret.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '../../i18n/config';
import { buildLightIndexesFromCatalog, buildLightIndexesFromSQLite, type LightCatalog } from '../lightIndexBuilder';
import type { CategoryRow } from '../../types/repositories';

const empty = { id: [], name: [], iconPrefixId: [], iconSuffix: [], tmdbId: [], categoryId: [], added: [] };
const catalog = (categories: LightCatalog['categories']): LightCatalog => ({
  iconPrefixes: [],
  movies: { ...empty, containerExtension: [] },
  series: { ...empty },
  live: { id: [], name: [], iconPrefixId: [], iconSuffix: [], categoryId: [], epgChannelId: [], matchedEpgId: [], matchMethod: [] },
  categories,
});

describe('catégorie sans nom', () => {
  const unnamed = () => i18n.t('common:unnamed_category');
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('le texte existe en français et en anglais', async () => {
    await i18n.changeLanguage('fr');
    expect(unnamed()).toBe('Sans catégorie');
    await i18n.changeLanguage('en');
    expect(unnamed()).toBe('Uncategorized');
  });

  it('catalogue compact : nom vide, espaces ou « — » remplacés, les autres gardés', () => {
    const idx = buildLightIndexesFromCatalog(catalog([['1', '', 'movie'], ['2', '  ', 'series'], ['3', '—', 'live'], ['4', 'Sport', 'live']]));
    expect(idx.categories.get('movie:1')?.name).toBe('Uncategorized');
    expect(idx.categories.get('series:2')?.name).toBe('Uncategorized');
    expect(idx.categories.get('live:3')?.name).toBe('Uncategorized');
    expect(idx.categories.get('live:4')?.name).toBe('Sport');
  });

  it('lecture SQLite : même règle', () => {
    const rows = [{ id: '5', name: '', type: 'movie' }, { id: '6', name: 'Films', type: 'movie' }] as unknown as CategoryRow[];
    const idx = buildLightIndexesFromSQLite([], [], [], rows);
    expect(idx.categories.get('movie:5')?.name).toBe('Uncategorized');
    expect(idx.categories.get('movie:6')?.name).toBe('Films');
  });
});
