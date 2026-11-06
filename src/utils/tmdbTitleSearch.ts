/**
 * Title -> TMDB search query, for providers that send no TMDB id.
 * "EN - Reminiscence (2021) [4K]" -> { query: "Reminiscence", year: "2021" }
 */
export function parseTitleForSearch(raw: string): { query: string; year?: string } {
  let text = raw.trim();
  const yearMatch = text.match(/[([]((?:19|20)\d{2})[)\]]/) ?? text.match(/\b((?:19|20)\d{2})\s*$/);
  const year = yearMatch?.[1];
  text = text
    .replace(/\[[^\]]*\]/g, ' ') // [4K], [MULTI]
    .replace(/\([^)]*\)/g, ' ') // (2021)
    .replace(/^[A-Za-z]{2,3}\s*[-:|]\s+/, '') // language prefix "EN - "
    .replace(/\s+(?:19|20)\d{2}\s*$/, '') // trailing year
    .replace(/\s+/g, ' ')
    .trim();
  return { query: text, year };
}
