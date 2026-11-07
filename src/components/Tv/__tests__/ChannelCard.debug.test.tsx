/**
 * Tests pour ChannelCard.tsx — pastille « i » de diagnostic du guide TV
 *
 * Régression : sous Windows, survoler une carte de chaîne du Guide TV montrait une icône « i » ; un clic
 * ouvrait un panneau de développement non traduit (« EPG MATCHING », « Aucun Match »).
 * Choix retenu : la pastille ne s'affiche que dans une version de développement.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChannelCard from '../ChannelCard';
import { brancherOutilsTest } from '../../../services/outilsTest';
import ChannelCardDebug from '../../../dev/ChannelCardDebug';

// Pastille branchée comme le fait src/dev/prises.ts ; la condition DEV de ChannelCard décide seule si elle s'affiche.
brancherOutilsTest({ pastilleChaine: ChannelCardDebug });

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const debugInfo = {
  name: 'FR | Info',
  m3uId: 'info.fr',
  matchedEpgId: null,
  matchMethod: null,
  epgName: undefined,
};

describe('ChannelCard — pastille de diagnostic du guide', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("n'affiche pas la pastille ni son panneau dans la version publiée", () => {
    vi.stubEnv('DEV', false);
    const { container } = render(<ChannelCard channelName="FR | Info" onClick={() => {}} debugInfo={debugInfo} />);
    expect(container.querySelector('.channel-card__debug-container')).toBeNull();
    expect(screen.queryByText('EPG MATCHING')).toBeNull();
  });

  it('garde la pastille dans une version de développement', () => {
    vi.stubEnv('DEV', true);
    const { container } = render(<ChannelCard channelName="FR | Info" onClick={() => {}} debugInfo={debugInfo} />);
    expect(container.querySelector('.channel-card__debug-container')).not.toBeNull();
    expect(screen.getByText('EPG MATCHING')).toBeTruthy();
  });
});
