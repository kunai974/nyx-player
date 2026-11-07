/**
 * ChannelCardDebug - Pastille « i » de diagnostic d'une carte de chaîne (correspondance au guide TV)
 *
 * Outil de développement : affichée seulement par une version de développement.
 * Ses textes restent donc en dur, sans traduction, et sans repère du banc (dossier src/dev).
 */

import React, { useEffect, useRef, useState } from 'react';

import type { ChannelCardDebugInfo } from '../services/outilsTest';

const ChannelCardDebug: React.FC<{ debugInfo: ChannelCardDebugInfo }> = ({ debugInfo }) => {
    const [isPinned, setIsPinned] = useState(false);
    const debugRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isPinned) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (debugRef.current && !debugRef.current.contains(e.target as Node)) {
                setIsPinned(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isPinned]);

    return (
        <div 
            ref={debugRef}
            className={`channel-card__debug-container ${isPinned ? 'channel-card__debug-container--pinned' : ''}`}
            onClick={(e) => {
                e.stopPropagation();
                setIsPinned(v => !v);
            }}
        >
            <div className="channel-card__debug-icon" title="Infos EPG">i</div>
            <div className="channel-card__debug-popup" onClick={(e) => e.stopPropagation()}>
                <div style={{fontWeight: 'bold', borderBottom: '1px solid #444', marginBottom: 4, paddingBottom: 4, display: 'flex', alignItems: 'center', gap: '0.25rem'}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                    EPG MATCHING
                </div>
                <div style={{marginTop: 4}}><span style={{color:'#888', marginRight: 4}}>Live M3U:</span> {debugInfo.name}</div>
                <div style={{marginTop: 2}}><span style={{color:'#888', marginRight: 4}}>ID M3U:</span> {debugInfo.m3uId || <i>Vide</i>}</div>
                <div style={{marginTop: 2}}><span style={{color:'#888', marginRight: 4}}>Match:</span> {debugInfo.matchedEpgId ? <span style={{color: '#4ade80'}}>{debugInfo.matchedEpgId}</span> : <span style={{color: '#f87171'}}>❌ Aucun Match</span>}</div>
                {debugInfo.matchMethod && <div style={{marginTop: 2}}><span style={{color:'#888', marginRight: 4}}>Type Match:</span> <span style={{color: '#60a5fa'}}>{debugInfo.matchMethod}</span></div>}
            </div>
        </div>
    );
};

export default ChannelCardDebug;
