import { describe, it, expect } from 'vitest';
import { parseTitleForSearch } from '../tmdbTitleSearch';

describe('parseTitleForSearch', () => {
  it('splits title and year', () => {
    expect(parseTitleForSearch('Reminiscence (2021)')).toEqual({ query: 'Reminiscence', year: '2021' });
  });
  it('drops language prefix and tags', () => {
    expect(parseTitleForSearch('EN - Stillwater (2021) [4K]')).toEqual({ query: 'Stillwater', year: '2021' });
  });
  it('keeps a title without year', () => {
    expect(parseTitleForSearch('The Office')).toEqual({ query: 'The Office', year: undefined });
  });
  it('reads a trailing year', () => {
    expect(parseTitleForSearch('Dune 2021')).toEqual({ query: 'Dune', year: '2021' });
  });
});
