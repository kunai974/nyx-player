/**
 * Recherche groupée : les titres sont découpés en appels de 20 au plus, et d'une adresse de taille
 * raisonnable (des titres longs en caractères non latins y prennent beaucoup de place).
 */
import { describe, it, expect } from 'vitest';

import { TITLE_BATCH_MAX, TITLE_BATCH_MAX_URL_CHARS, titleBatchChunks } from '../tmdbApi';

describe('découpage des recherches groupées', () => {
    it('20 titres au plus par appel', () => {
        const items = Array.from({ length: 45 }, (_, i) => ({ query: `Film ${i}` }));
        expect(titleBatchChunks(items).map((c) => c.length)).toEqual([TITLE_BATCH_MAX, TITLE_BATCH_MAX, 5]);
    });

    it('des titres longs non latins : plusieurs appels, chacun sous la taille d\'adresse', () => {
        const items = Array.from({ length: 20 }, (_, i) => ({ query: `${'東京物語'.repeat(40)} ${i}` }));
        const chunks = titleBatchChunks(items);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.flat()).toHaveLength(20);
        for (const chunk of chunks) {
            const chars = chunk.reduce((n, item) => n + encodeURIComponent(item.query).length + 16, 0);
            expect(chars).toBeLessThanOrEqual(TITLE_BATCH_MAX_URL_CHARS);
        }
    });

    it('rien à chercher : aucun appel', () => {
        expect(titleBatchChunks([])).toEqual([]);
    });
});
