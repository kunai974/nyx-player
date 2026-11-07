/**
 * Liste des sources d'un espace (compte Supabase ou invité) : table `iptv_sources` de la base perso,
 * partie affichable seulement ; la partie secrète est au coffre, une entrée par source
 * (sourceVault.ts). Socle commun aux chantiers multi-sources, M3U et mode invité.
 *
 * Chaque fonction reçoit l'espace et refuse d'écrire si la base ouverte n'est pas la sienne (le
 * compte a pu changer pendant une attente) : jamais une source rangée chez un autre compte.
 *
 * Ordre des écritures :
 * - ajout : coffre d'abord, ligne ensuite. Une source « existe » quand sa ligne existe ; un échec
 *   entre les deux efface l'entrée du coffre écrite ;
 * - suppression : coffre d'abord, puis ligne, puis fichier catalogue (sourceCatalogFile.ts). Un
 *   coffre en panne laisse la source en place (on peut réessayer) plutôt qu'un secret orphelin que
 *   plus rien ne désigne ; un fichier catalogue encore tenu est effacé au lancement suivant.
 *
 * Pas encore branché sur l'appli : la 0.8.0 continue de lire `iptv_credentials_<compte>`. La
 * migration depuis la 0.8.0 appellera `adoptLegacySource`.
 */

import type { SourceSecret, SourceSummary, IptvSource, SourceKind } from '../../types/iptvSource';
import type { XtreamCredentials } from '../../types/iptv';
import { getDatabase, getMeta, setMeta, isDatabaseOf } from '../dbCore';
import { writeSourceSecret, readSourceSecret, deleteSourceSecret, isValidSourceId, isValidSpaceId } from './sourceVault';
import { sourceProviderHash, sourceHostLabel } from './sourceFingerprint';
import { deleteSourceCatalog } from './sourceCatalogFile';
import { sameProviderHost, providerHostSpellings } from '../../utils/providerHost';
import { computeProviderHash } from '../preferencesService';
import { describeVaultError } from '../storage';
import { createLogger } from '../../utils/logger';
import { isM3uListCredentials } from './m3uListCredentials';

const log = createLogger('SourceRegistry');

/** 5 sources au plus par appareil : chaque source a son propre fichier catalogue, et la place disque d'un boîtier TV est comptée */
export const MAX_SOURCES = 5;

/** Longueur maximale d'un nom de source */
export const MAX_SOURCE_NAME_LENGTH = 60;

/** Identifiant de la source reprise de la 0.8.0, noté AVANT d'écrire quoi que ce soit */
const LEGACY_SOURCE_ID_KEY = 'legacy_source_id';
/** Reprise faite : une source reprise puis supprimée par la personne ne revient pas */
const LEGACY_ADOPTED_KEY = 'legacy_source_adopted';

/**
 * Les écritures de la liste passent une à une : deux ajouts lancés ensemble ne peuvent pas
 * dépasser la limite ni se voler une position.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export class SourceRegistryError extends Error {
  constructor(readonly code: 'invalid_space' | 'space_changed' | 'limit' | 'not_found' | 'invalid_order') {
    super(`source_registry_${code}`);
    this.name = 'SourceRegistryError';
  }
}

interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  host_label: string;
  provider_hash: string;
  sort_order: number;
  show_in_catalog: number;
  created_at: number;
  updated_at: number;
}

function toSummary(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hostLabel: row.host_label,
    providerHash: row.provider_hash,
    sortOrder: row.sort_order,
    showInCatalog: row.show_in_catalog !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** La base ouverte doit être celle de l'espace, avant et après chaque attente */
function assertSpace(spaceId: string): void {
  if (!isValidSpaceId(spaceId)) throw new SourceRegistryError('invalid_space');
  if (!isDatabaseOf(spaceId)) throw new SourceRegistryError('space_changed');
}

/** Nom propre : espaces superflus retirés, longueur bornée ; à défaut, le nom d'hôte ou « Source n » */
export function cleanSourceName(name: string | undefined, secret: SourceSecret, position: number): string {
  const cleaned = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_NAME_LENGTH).trim();
  return cleaned || sourceHostLabel(secret) || `Source ${position}`;
}

const SELECT_COLUMNS = 'id, name, kind, host_label, provider_hash, sort_order, show_in_catalog, created_at, updated_at';

/** Sources de l'espace, dans l'ordre de priorité */
export async function listSources(spaceId: string): Promise<SourceSummary[]> {
  assertSpace(spaceId);
  const db = await getDatabase();
  const rows = await db.select<SourceRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM iptv_sources ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return rows.map(toSummary);
}

async function findRow(sourceId: string): Promise<SourceRow | null> {
  const db = await getDatabase();
  const rows = await db.select<SourceRow[]>(`SELECT ${SELECT_COLUMNS} FROM iptv_sources WHERE id = ?`, [sourceId]);
  return rows[0] ?? null;
}

/** Source complète (avec sa partie secrète) ; null si elle n'existe pas ou si son secret est illisible */
export async function getSource(spaceId: string, sourceId: string): Promise<IptvSource | null> {
  assertSpace(spaceId);
  if (!isValidSourceId(sourceId)) return null;
  const row = await findRow(sourceId);
  if (!row) return null;
  const secret = await readSourceSecret(spaceId, sourceId);
  if (!secret || secret.kind !== row.kind) return null;
  return { ...toSummary(row), secret };
}

export interface NewSource {
  name?: string;
  secret: SourceSecret;
  showInCatalog?: boolean;
  /** Xtream : écriture de l'adresse déjà connue du compte, pour garder son empreinte (sourceFingerprint.ts) */
  knownSpelling?: string | null;
}

async function insertSource(spaceId: string, sourceId: string, source: NewSource): Promise<SourceSummary> {
  const db = await getDatabase();
  const [{ count, next }] = await db.select<{ count: number; next: number }[]>(
    'SELECT COUNT(*) AS count, COALESCE(MAX(sort_order) + 1, 0) AS next FROM iptv_sources',
  );
  if (count >= MAX_SOURCES) throw new SourceRegistryError('limit');
  const providerHash = await sourceProviderHash(source.secret, source.knownSpelling);
  await writeSourceSecret(spaceId, sourceId, source.secret);
  try {
    // Le compte a pu changer pendant les attentes : rien n'est rangé dans la base d'un autre
    assertSpace(spaceId);
    const now = Date.now();
    const row: SourceRow = {
      id: sourceId,
      name: cleanSourceName(source.name, source.secret, count + 1),
      kind: source.secret.kind,
      host_label: sourceHostLabel(source.secret),
      provider_hash: providerHash,
      sort_order: next,
      show_in_catalog: source.showInCatalog === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await db.execute(
      `INSERT INTO iptv_sources (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.kind, row.host_label, row.provider_hash, row.sort_order, row.show_in_catalog, row.created_at, row.updated_at],
    );
    return toSummary(row);
  } catch (e) {
    await deleteSourceSecret(spaceId, sourceId).catch(() => { /* entrée orpheline : sans ligne, rien ne la désigne */ });
    throw e;
  }
}

/** Ajoute une source (5 au plus) et range sa partie secrète au coffre */
export function addSource(spaceId: string, source: NewSource): Promise<SourceSummary> {
  return serialized(async () => {
    assertSpace(spaceId);
    return insertSource(spaceId, crypto.randomUUID(), source);
  });
}

/**
 * Le nouveau secret Xtream désigne-t-il le même serveur que la source ? D'après l'ancien secret,
 * ou, s'il est illisible (le coffre Windows répond « rien » sur une erreur), d'après l'empreinte
 * enregistrée : une des écritures plausibles de la nouvelle adresse doit la redonner.
 */
async function isSameXtreamServer(row: SourceRow, previous: SourceSecret | null, next: SourceSecret): Promise<boolean> {
  if (next.kind !== 'xtream' || row.kind !== 'xtream') return false;
  if (previous) return previous.kind === 'xtream' && sameProviderHost(previous.host, next.host);
  for (const spelling of providerHostSpellings(next.host)) {
    if ((await computeProviderHash(spelling)) === row.provider_hash) return true;
  }
  return false;
}

export interface SourceChanges {
  name?: string;
  secret?: SourceSecret;
  showInCatalog?: boolean;
  knownSpelling?: string | null;
}

/**
 * Modifie une source. Retourne la source modifiée et l'empreinte d'avant : si elle change (nouvelle
 * adresse), l'appelant décide de ce que deviennent les données rangées sous l'ancienne.
 */
export function updateSource(
  spaceId: string,
  sourceId: string,
  changes: SourceChanges,
): Promise<{ source: SourceSummary; previousProviderHash: string }> {
  return serialized(() => applyUpdate(spaceId, sourceId, changes));
}

async function applyUpdate(
  spaceId: string,
  sourceId: string,
  changes: SourceChanges,
): Promise<{ source: SourceSummary; previousProviderHash: string }> {
  assertSpace(spaceId);
  if (!isValidSourceId(sourceId)) throw new SourceRegistryError('not_found');
  const row = await findRow(sourceId);
  if (!row) throw new SourceRegistryError('not_found');
  const previousSecret = await readSourceSecret(spaceId, sourceId);
  const next: SourceRow = { ...row, updated_at: Date.now() };
  if (changes.secret) {
    next.kind = changes.secret.kind;
    next.host_label = sourceHostLabel(changes.secret);
    // Même serveur (nouveau mot de passe, autre écriture de l'adresse) : même empreinte, sinon
    // l'appelant croirait à un changement de fournisseur
    next.provider_hash = (await isSameXtreamServer(row, previousSecret, changes.secret))
      ? row.provider_hash
      : await sourceProviderHash(changes.secret, changes.knownSpelling);
  }
  if (changes.name !== undefined) {
    const secret = changes.secret ?? previousSecret;
    next.name = secret
      ? cleanSourceName(changes.name, secret, row.sort_order + 1)
      : (changes.name.replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_NAME_LENGTH).trim() || row.name);
  }
  if (changes.showInCatalog !== undefined) next.show_in_catalog = changes.showInCatalog ? 1 : 0;
  assertSpace(spaceId);
  if (changes.secret) await writeSourceSecret(spaceId, sourceId, changes.secret);
  try {
    assertSpace(spaceId);
    const db = await getDatabase();
    await db.execute(
      'UPDATE iptv_sources SET name = ?, kind = ?, host_label = ?, provider_hash = ?, show_in_catalog = ?, updated_at = ? WHERE id = ?',
      [next.name, next.kind, next.host_label, next.provider_hash, next.show_in_catalog, next.updated_at, sourceId],
    );
  } catch (e) {
    // Ligne inchangée : le coffre reprend l'ancien secret, pour que les deux restent d'accord
    if (changes.secret && previousSecret) {
      await writeSourceSecret(spaceId, sourceId, previousSecret).catch(() => { /* getSource le signalera (type différent) */ });
    }
    throw e;
  }
  return { source: toSummary(next), previousProviderHash: row.provider_hash };
}

/** Supprime une source : son entrée du coffre, puis sa ligne, puis son fichier catalogue */
export function removeSource(spaceId: string, sourceId: string): Promise<void> {
  return serialized(async () => {
    assertSpace(spaceId);
    if (!isValidSourceId(sourceId)) throw new SourceRegistryError('not_found');
    await deleteSourceSecret(spaceId, sourceId);
    assertSpace(spaceId);
    const db = await getDatabase();
    await db.execute('DELETE FROM iptv_sources WHERE id = ?', [sourceId]);
    // Catalogue de la source, une fois la ligne partie (une ligne restée en place garde son
    // catalogue). Un fichier encore tenu est effacé au lancement suivant, sans retenir la
    // suppression : il ne peut plus être rempli d'ici là.
    try {
      await deleteSourceCatalog(spaceId, sourceId);
    } catch (e) {
      log.warn('removeSource: catalogue effacé au prochain lancement', describeVaultError(e));
    }
  });
}

/** Nouvel ordre de priorité : la liste complète des sources de l'espace, la première d'abord */
export function reorderSources(spaceId: string, orderedIds: readonly string[]): Promise<void> {
  return serialized(() => applyOrder(spaceId, orderedIds));
}

async function applyOrder(spaceId: string, orderedIds: readonly string[]): Promise<void> {
  assertSpace(spaceId);
  const db = await getDatabase();
  const rows = await db.select<{ id: string }[]>('SELECT id FROM iptv_sources');
  const known = new Set(rows.map((r) => r.id));
  if (orderedIds.length !== known.size || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !known.has(id))) {
    throw new SourceRegistryError('invalid_order');
  }
  assertSpace(spaceId);
  const now = Date.now();
  for (const [index, id] of orderedIds.entries()) {
    await db.execute('UPDATE iptv_sources SET sort_order = ?, updated_at = ? WHERE id = ?', [index, now, id]);
  }
}

/**
 * Reprend les identifiants de la 0.8.0 comme première source de l'espace. Rejouable sans dégât :
 * l'identifiant de la source est noté en base avant toute écriture, et la même source est
 * retrouvée au lancement suivant si une coupure est survenue au milieu. L'entrée de la 0.8.0 n'est
 * jamais modifiée. null si l'espace a déjà d'autres sources, ou si la reprise est déjà faite et
 * que la personne a supprimé cette source depuis (elle ne revient pas).
 */
export function adoptLegacySource(
  spaceId: string,
  legacy: XtreamCredentials,
  options: { name?: string; knownSpelling?: string | null } = {},
): Promise<SourceSummary | null> {
  return serialized(() => adopt(spaceId, legacy, options));
}

async function adopt(
  spaceId: string,
  legacy: XtreamCredentials,
  options: { name?: string; knownSpelling?: string | null },
): Promise<SourceSummary | null> {
  assertSpace(spaceId);
  if ((await getMeta(LEGACY_ADOPTED_KEY)) === '1') {
    const noted = await getMeta(LEGACY_SOURCE_ID_KEY);
    const row = noted && isValidSourceId(noted) ? await findRow(noted) : null;
    return row ? toSummary(row) : null;
  }
  const noted = await getMeta(LEGACY_SOURCE_ID_KEY);
  const sourceId = noted && isValidSourceId(noted) ? noted : crypto.randomUUID();
  if (sourceId !== noted) {
    assertSpace(spaceId);
    await setMeta(LEGACY_SOURCE_ID_KEY, sourceId);
  }
  const existing = await findRow(sourceId);
  let adopted: SourceSummary | null;
  if (existing) {
    adopted = toSummary(existing);
  } else {
    const db = await getDatabase();
    const [{ count }] = await db.select<{ count: number }[]>('SELECT COUNT(*) AS count FROM iptv_sources');
    if (count > 0) {
      // L'espace a déjà ses sources : la reprise est close, elle ne reviendra pas s'il les supprime
      assertSpace(spaceId);
      await setMeta(LEGACY_ADOPTED_KEY, '1');
      return null;
    }
    // L'entrée de la session peut aussi contenir une liste M3U (onglet « Lien M3U »)
    const secret: SourceSecret = isM3uListCredentials(legacy)
      ? { kind: 'm3u', url: legacy.m3u.url, ...(legacy.m3u.epgUrl ? { epgUrl: legacy.m3u.epgUrl } : {}) }
      : { kind: 'xtream', host: legacy.host, username: legacy.username, password: legacy.password };
    adopted = await insertSource(spaceId, sourceId, { name: options.name, secret, knownSpelling: options.knownSpelling });
  }
  // Noté après la ligne : une coupure entre les deux retrouve la ligne au lancement suivant
  assertSpace(spaceId);
  await setMeta(LEGACY_ADOPTED_KEY, '1');
  return adopted;
}
