/**
 * SourceForm — Formulaire d'édition des credentials IPTV (Xtream Codes / Lien Xtream).
 *
 * L'état d'édition est piloté par le parent via `isEditing`.
 * Gère les useState du formulaire, les handlers save/cancel,
 * et l'affichage lecture seule des credentials quand pas en édition.
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { XtreamCredentials } from '../../types/iptv';
import NyxButton from '../Common/NyxButton';
import { readM3uParam, splitPastedXtreamAddress } from '../../utils/xtreamCredentials';
import { normalizeProviderHost } from '../../utils/providerHost';
import { isProviderCertificateError, isProviderServerError } from '../../services/networkService';
import { isCredentialsRejectedError, isProviderAccountInactiveError, isProviderHtmlResponseError } from '../../services/xtreamApi';

// ============================================================================
// TYPES
// ============================================================================
interface SourceFormProps {
    credentials: XtreamCredentials;
    isEditing: boolean;
    onEditingChange: (editing: boolean) => void;
    onCredentialsChange?: (creds: XtreamCredentials) => void | Promise<void>;
}

// ============================================================================
// COMPONENT
// ============================================================================
const SourceForm: React.FC<SourceFormProps> = ({
    credentials,
    isEditing,
    onEditingChange,
    onCredentialsChange,
}) => {
    const { t } = useTranslation(['settings', 'auth']);

    // Form state (internal)
    const [sourceMode, setSourceMode] = useState<'xtream' | 'm3u'>('xtream');
    const [editHost, setEditHost] = useState(credentials.host);
    const [editUsername, setEditUsername] = useState(credentials.username);
    const [editPassword, setEditPassword] = useState(credentials.password);
    const [editM3uLink, setEditM3uLink] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    // Sync form fields when credentials change externally
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- formulaire recopié quand les identifiants enregistrés changent (après une modification réussie)
        setEditHost(credentials.host);
        setEditUsername(credentials.username);
        setEditPassword(credentials.password);
    }, [credentials]);

    // =========== HANDLERS ===========
    const handleSaveCredentials = async () => {
        if (!onCredentialsChange) return;
        setFormError(null);

        let newCreds: XtreamCredentials;

        if (sourceMode === 'm3u') {
            try {
                const url = new URL(editM3uLink);
                const host = normalizeProviderHost(`${url.protocol}//${url.host}`);
                // « + » gardé tel quel dans les identifiants
                const username = readM3uParam(url, 'username');
                const password = readM3uParam(url, 'password');

                if (!host || !username || !password) {
                    setFormError(t('error_missing_fields') + ' (username/password)');
                    return;
                }
                newCreds = { host, username, password };
            } catch {
                setFormError(t('error_invalid_m3u'));
                return;
            }
        } else {
            // Adresse complète collée (`…/player_api.php?username=…`) : le serveur seul, et les
            // identifiants qu'elle contient pour les champs laissés vides
            const pasted = splitPastedXtreamAddress(editHost);
            const user = editUsername || pasted.username;
            const pass = editPassword || pasted.password;
            if (!pasted.host.trim() || !user || !pass) {
                setFormError(t('error_missing_fields'));
                return;
            }
            // Adresse nettoyée : le même serveur écrit autrement n'est pas un autre fournisseur
            newCreds = { host: normalizeProviderHost(pasted.host), username: user, password: pass };
        }

        setIsSaving(true);
        try {
            await onCredentialsChange(newCreds);
            onEditingChange(false);
        } catch (error) {
            // Identifiants refusés, serveur du fournisseur en panne ou injoignable, autre échec
            if (isCredentialsRejectedError(error)) setFormError(t('error_credentials_rejected'));
            else if (isProviderServerError(error)) setFormError(t('auth:error_provider_unavailable'));
            else if (isProviderCertificateError(error)) setFormError(t('auth:error_provider_certificate'));
            else if (isProviderHtmlResponseError(error)) setFormError(t('auth:error_provider_html'));
            else if (isProviderAccountInactiveError(error)) setFormError(t('auth:error_provider_account_inactive'));
            else setFormError(t('error_credentials'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancelEdit = () => {
        onEditingChange(false);
        setFormError(null);
        setEditHost(credentials.host);
        setEditUsername(credentials.username);
        setEditPassword(credentials.password);
        setEditM3uLink('');
        setSourceMode('xtream');
    };

    // =========== RENDER ===========
    if (!isEditing) {
        return (
            <div className="info-grid">
                <div className="info-item">
                    <div className="info-label">{t('host')}</div>
                    <div className="info-value">{credentials.host}</div>
                </div>
                <div className="info-item">
                    <div className="info-label">{t('username')}</div>
                    <div className="info-value">{credentials.username}</div>
                </div>
                <div className="info-item">
                    <div className="info-label">{t('password')}</div>
                    {/* eslint-disable-next-line i18next/no-literal-string -- mot de passe masqué (points), sans texte */}
                    <div className="info-value masked">••••••••</div>
                </div>
            </div>
        );
    }

    return (
        <div className="edit-source-form" data-testid="settings-provider-form">
            <div className="source-tabs">
                <button
                    className={`source-tab ${sourceMode === 'xtream' ? 'active' : ''}`}
                    data-testid="settings-provider-tab-xtream"
                    onClick={() => setSourceMode('xtream')}
                // eslint-disable-next-line i18next/no-literal-string -- nom de produit (protocole Xtream Codes), identique dans toutes les langues
                >
                    Xtream Codes
                </button>
                <button
                    className={`source-tab ${sourceMode === 'm3u' ? 'active' : ''}`}
                    data-testid="settings-provider-tab-m3u"
                    onClick={() => setSourceMode('m3u')}
                >
                    {t('tab_m3u')}
                </button>
            </div>

            {sourceMode === 'xtream' ? (
                <div className="edit-fields">
                    <div className="edit-field">
                        <label>{t('host')}</label>
                        <input
                            type="text"
                            value={editHost}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            data-testid="settings-provider-url"
                            onChange={(e) => setEditHost(e.target.value)}
                            placeholder="http://example.com:8080"
                        />
                    </div>
                    <div className="edit-field">
                        <label>{t('username')}</label>
                        <input
                            type="text"
                            value={editUsername}
                            data-testid="settings-provider-username"
                            onChange={(e) => setEditUsername(e.target.value)}
                        />
                    </div>
                    <div className="edit-field">
                        <label>{t('password')}</label>
                        <input
                            type="password"
                            value={editPassword}
                            data-testid="settings-provider-password"
                            onChange={(e) => setEditPassword(e.target.value)}
                        />
                    </div>
                </div>
            ) : (
                <div className="edit-fields">
                    <div className="edit-field">
                        <label>{t('m3u_link')}</label>
                        <textarea
                            value={editM3uLink}
                            data-testid="settings-provider-m3u-link"
                            onChange={(e) => setEditM3uLink(e.target.value)}
                            placeholder="http://.../get.php?username=...&password=..."
                            rows={3}
                        />
                        <p className="field-hint">{t('m3u_hint')}</p>
                    </div>
                </div>
            )}

            {formError && <div className="settings-inline-error" data-testid="settings-provider-error">{formError}</div>}

            <div className="edit-actions">
                <NyxButton
                    variant="primary"
                    size="sm"
                    color="blue"
                    onClick={() => void handleSaveCredentials()}
                    data-testid="settings-provider-save"
                    disabled={isSaving}
                >
                    {isSaving ? t('saving') : t('save')}
                </NyxButton>
                <NyxButton
                    variant="primary"
                    size="sm"
                    color="red"
                    onClick={handleCancelEdit}
                    data-testid="settings-provider-cancel"
                    disabled={isSaving}
                >
                    {t('cancel')}
                </NyxButton>
            </div>
        </div>
    );
};

export default SourceForm;
