/**
 * LocalM3uFileButton — « Ouvrir un fichier M3U de l'appareil » : choix d'un fichier .m3u posé sur
 * l'ordinateur ou le téléphone, recopié dans l'app (services/sources/m3uLocalFile.ts), puis rendu
 * comme une source de session. Rien sur la TV : pas d'explorateur de fichiers à la télécommande.
 */

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { XtreamCredentials } from '../../types/iptv';
import { importLocalM3uFile, LocalM3uFileError } from '../../services/sources/m3uLocalFile';
import { isAndroid, isTv } from '../../utils/platform';
import NyxButton from './NyxButton';

interface LocalM3uFileButtonProps {
    /** Repère du banc du bouton ; le champ de fichier caché prend `<testId>-input` */
    testId: string;
    /** Source prête : la page l'enregistre comme une liste collée */
    onImported: (creds: XtreamCredentials) => void | Promise<void>;
    /** Message déjà traduit (null : effacer le précédent) */
    onError: (message: string | null) => void;
    disabled?: boolean;
}

const LocalM3uFileButton: React.FC<LocalM3uFileButtonProps> = ({ testId, onImported, onError, disabled = false }) => {
    const { t } = useTranslation('auth');
    const input = useRef<HTMLInputElement>(null);
    const [copied, setCopied] = useState<number | null>(null);

    if (isTv()) return null;

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        onError(null);
        setCopied(0);
        try {
            const creds = await importLocalM3uFile(file, setCopied);
            await onImported(creds);
        } catch (e) {
            const code = e instanceof LocalM3uFileError ? e.code : 'copy_failed';
            onError(t(`error_m3u_file_${code}`));
        } finally {
            setCopied(null);
            // Le même fichier choisi de nouveau doit relancer la copie
            if (input.current) input.current.value = '';
        }
    };

    return (
        <>
            <input
                ref={input}
                type="file"
                hidden
                // Android ne reconnaît pas toujours le type d'un .m3u : tous les fichiers y sont proposés
                {...(isAndroid() ? {} : { accept: '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl' })}
                data-testid={`${testId}-input`}
                onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <NyxButton
                type="button"
                variant="secondary"
                size="sm"
                color="blue"
                data-testid={testId}
                disabled={disabled || copied !== null}
                onClick={() => input.current?.click()}
            >
                {copied === null ? t('btn_m3u_file') : t('m3u_file_copying', { progress: Math.round(copied * 100) })}
            </NyxButton>
        </>
    );
};

export default LocalM3uFileButton;
