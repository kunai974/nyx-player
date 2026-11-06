/**
 * MacosChangelogModal — everything the macOS version does differently from the other versions.
 * Same window as the open source licences (same look, same back/close behaviour).
 */

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useBackHandler } from '../../hooks/useBackHandler';
import { isTv } from '../../utils/platform';
import './ThirdPartyLicensesModal.css';

interface MacosChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ChangelogGroup {
  title: string;
  items: string[];
}

const MacosChangelogModal: React.FC<MacosChangelogModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('settings');
  useBackHandler(isOpen, onClose);

  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen || !isTv()) return;
    const opener = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const groups = t('macos_changelog_groups', { returnObjects: true }) as unknown as ChangelogGroup[];

  return createPortal(
    <div className="licenses-modal" data-testid="macos-changelog-modal" data-nav-layer="modal" role="dialog" aria-modal="true" aria-label={t('macos_changelog_title')} onClick={onClose}>
      <div className="licenses-modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="licenses-modal__header">
          <h3>{t('macos_changelog_title')}</h3>
          <button ref={closeRef} type="button" className="licenses-modal__close" data-testid="macos-changelog-close" onClick={onClose} aria-label={t('licenses_close')}>
            ✕
          </button>
        </header>

        <p className="licenses-modal__intro">{t('macos_changelog_intro')}</p>

        <ul className="licenses-modal__list">
          {Array.isArray(groups) && groups.map((group) => (
            <li key={group.title} className="licenses-modal__item">
              <div className="licenses-modal__name">{group.title}</div>
              <ul className="macos-changelog__items">
                {group.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
};

export default MacosChangelogModal;
