/**
 * QR code dessiné en SVG (un rectangle par module sombre), sans HTML injecté.
 * Niveau de correction « M » : lisible à 3 m sur une TV, même avec un reflet.
 */

import React, { useMemo } from 'react';
import qrcode from 'qrcode-generator';

interface TvLinkQrProps {
  value: string;
  label: string;
}

/** Marge blanche autour du code (4 modules, minimum de la norme). */
const QUIET_ZONE = 4;

const TvLinkQr: React.FC<TvLinkQrProps> = ({ value, label }) => {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { size: count + QUIET_ZONE * 2, path: d };
  }, [value]);

  return (
    <svg
      className="tvlink-qr"
      data-testid="tvlink-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
};

export default TvLinkQr;
