/**
 * Réglages > Sources, carte « Compte du fournisseur » (lot C de l'audit de couverture) : date
 * d'expiration et sa couleur, statut, connexions, nombre de chaînes, films et séries, taux TMDB.
 * Données factices, aucune date réelle d'abonnement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'fr' },
  }),
}));

import AccountInfoCard from '../AccountInfoCard';

const NOW = new Date('2026-09-30T12:00:00Z');
const inDays = (days: number) => String(Math.floor(NOW.getTime() / 1000) + days * 86400);
const expiration = () => document.querySelector('.status-dot')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('AccountInfoCard — abonnement', () => {
  it('sans informations : « non disponible » et statut inconnu', () => {
    render(<AccountInfoCard accountInfo={null} />);
    expect(screen.getByText('not_available')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toHaveClass('danger');
    expect(screen.queryByText('connections')).toBeNull();
    expect(document.querySelector('.stats-row')).toBeNull();
  });

  it.each([
    [200, 'active', 'success'],
    [30, 'expiring', 'warning'],
    [5, 'expiring', 'warning'],
    [-1, 'expired', 'danger'],
  ])('expiration dans %i jours : état « %s »', (days, state, color) => {
    render(<AccountInfoCard accountInfo={{ exp_date: inDays(days), status: 'Active' }} />);
    expect(expiration()).toHaveClass(state);
    expect(expiration().closest('.info-value')).toHaveClass(color);
  });

  it('date affichée en toutes lettres dans la langue de l\'appli', () => {
    render(<AccountInfoCard accountInfo={{ exp_date: inDays(200) }} />);
    const expected = new Date(Number(inDays(200)) * 1000).toLocaleDateString('fr', { year: 'numeric', month: 'long', day: 'numeric' });
    expect(expiration().parentElement!.textContent).toBe(expected);
  });

  it('état forcé par le panneau de développement : la date reste, la couleur change', () => {
    const { unmount } = render(<AccountInfoCard accountInfo={{ exp_date: inDays(200) }} />);
    const date = expiration().parentElement!.textContent;
    unmount();
    render(<AccountInfoCard accountInfo={{ exp_date: inDays(200) }} forceExpiration="expired" />);
    expect(expiration()).toHaveClass('expired');
    expect(expiration().parentElement!.textContent).toBe(date);
  });

  it('statut « Active » en vert, tout autre en rouge', () => {
    const { unmount } = render(<AccountInfoCard accountInfo={{ status: 'Active' }} />);
    expect(screen.getByText('Active')).toHaveClass('success');
    unmount();
    render(<AccountInfoCard accountInfo={{ status: 'Banned' }} />);
    expect(screen.getByText('Banned')).toHaveClass('danger');
  });

  it('connexions : en vert sous la limite, en orange à la limite', () => {
    const { unmount } = render(<AccountInfoCard accountInfo={{ active_cons: '1', max_connections: '2' }} />);
    expect(screen.getByText('connections_value {"active":"1","max":"2"}')).toHaveClass('success');
    unmount();
    render(<AccountInfoCard accountInfo={{ active_cons: '2', max_connections: '2' }} />);
    expect(screen.getByText('connections_value {"active":"2","max":"2"}')).toHaveClass('warning');
  });

  it('connexions actives inconnues : comptées comme 0', () => {
    render(<AccountInfoCard accountInfo={{ max_connections: '1' }} />);
    expect(screen.getByText('connections_value {"active":"0","max":"1"}')).toHaveClass('success');
  });
});

describe('AccountInfoCard — contenu du catalogue', () => {
  it('chaînes, films et séries uniques quand connus', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 12, movies: 900, series: 80, uniqueMovies: 700, uniqueSeries: 60 }} />);
    const values = [...document.querySelectorAll('.stat-value')].map((e) => e.textContent);
    expect(values).toEqual([(12).toLocaleString(), (700).toLocaleString(), (60).toLocaleString()]);
  });

  it('sans décompte unique : le total est affiché', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 900, series: 80 }} />);
    const values = [...document.querySelectorAll('.stat-value')].map((e) => e.textContent);
    expect(values.slice(1)).toEqual([(900).toLocaleString(), (80).toLocaleString()]);
  });

  it('sans taux TMDB : pas de ligne TMDB', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 1, series: 1 }} />);
    expect(screen.queryByText('tmdb_integration')).toBeNull();
  });

  it('taux TMDB colorés : rouge jusqu\'à 30 %, orange jusqu\'à 70 %, vert au-delà', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 1, series: 1, tmdbMovieRate: 30, tmdbSeriesRate: 71 }} />);
    const [movies, series] = [...document.querySelectorAll<HTMLElement>('.tmdb-rate-value')];
    expect(movies.textContent).toBe('30%');
    expect(movies.style.color).toBe('var(--color-error)');
    expect(series.textContent).toBe('71%');
    expect(series.style.color).toBe('var(--color-success)');
  });

  it('un seul taux connu : l\'autre affiché à 0 %', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 1, series: 1, tmdbSeriesRate: 50 }} />);
    const [movies, series] = [...document.querySelectorAll<HTMLElement>('.tmdb-rate-value')];
    expect(movies.textContent).toBe('0%');
    expect(series.style.color).toBe('var(--color-warning)');
  });

  it('très grand catalogue avec quelques titres reliés : la ligne reste, « moins de 1 % » au lieu de 0 %', () => {
    render(
      <AccountInfoCard
        accountInfo={null}
        contentCounts={{ live: 0, movies: 186407, series: 299, tmdbMovies: 120, tmdbSeries: 0, tmdbMovieRate: 0, tmdbSeriesRate: 0 }}
      />,
    );
    expect(screen.getByText('tmdb_integration')).toBeTruthy();
    const [movies, series] = [...document.querySelectorAll<HTMLElement>('.tmdb-rate-value')];
    expect(movies.textContent).toBe('tmdb_less_than_one');
    expect(series.textContent).toBe('0%');
  });

  it('taux forcé par le panneau de développement : prend le pas sur le vrai', () => {
    render(
      <AccountInfoCard
        accountInfo={null}
        contentCounts={{ live: 1, movies: 1, series: 1, tmdbMovieRate: 90 }}
        forceTmdbMovieRate={10}
      />,
    );
    expect(document.querySelector('.tmdb-rate-value')!.textContent).toBe('10%');
  });
});

describe('AccountInfoCard — liste M3U (sans abonnement)', () => {
  it('ni expiration, ni statut, ni connexions ; les nombres de chaînes, films et séries restent', () => {
    render(
      <AccountInfoCard
        accountInfo={null}
        showSubscription={false}
        contentCounts={{ live: 12, movies: 3, series: 1 }}
      />,
    );
    expect(screen.queryByText('account_title')).toBeNull();
    expect(screen.queryByText('expiration')).toBeNull();
    expect(screen.queryByText('unknown')).toBeNull();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('numéros du fournisseur et numéros trouvés par titre : les deux parts sont affichées, la couleur suit le total', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 1, series: 1, tmdbMovieRate: 80, tmdbMovieTitleRate: 30, tmdbSeriesRate: 10 }} />);
    const [movies, series] = [...document.querySelectorAll<HTMLElement>('.tmdb-rate-value')];
    expect(movies.textContent).toBe('80%');
    expect(movies.style.color).toBe('var(--color-success)');
    expect(series.style.color).toBe('var(--color-error)');
    const details = [...document.querySelectorAll('.tmdb-rate-detail')];
    expect(details).toHaveLength(1);
    expect(details[0].textContent).toContain('tmdb_split');
  });

  it('rien trouvé par titre : pas de détail ajouté', () => {
    render(<AccountInfoCard accountInfo={null} contentCounts={{ live: 1, movies: 1, series: 1, tmdbMovieRate: 80, tmdbSeriesRate: 60 }} />);
    expect(document.querySelector('.tmdb-rate-detail')).toBeNull();
  });
});
