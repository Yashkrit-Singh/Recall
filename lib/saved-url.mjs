const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com'])
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{1,128}$/

/** @typedef {{url: string, isInstagram: boolean, shortcode?: string, kind?: 'reel' | 'p'}} NormalizedSavedUrl */

export class SavedUrlError extends Error {
  /** @param {string} message @param {'invalid_url'|'unsupported_instagram_url'} code */
  constructor(message, code) {
    super(message)
    this.name = 'SavedUrlError'
    this.code = code
  }
}

/**
 * Validate an HTTP(S) URL and canonicalize known Instagram permalinks only.
 * Other video platforms are returned as entered, without Instagram query rules.
 * @param {unknown} value
 * @returns {NormalizedSavedUrl}
 */
export function normalizeSavedUrl(value) {
  const input = String(value ?? '').trim()
  if (!input) throw new SavedUrlError('Paste a video link.', 'invalid_url')

  let parsed
  try { parsed = new URL(input) } catch { throw new SavedUrlError('Paste a valid URL, such as https://www.instagram.com/reel/…/', 'invalid_url') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new SavedUrlError('Use a valid HTTP or HTTPS video link without embedded credentials.', 'invalid_url')
  }

  const hostname = parsed.hostname.toLowerCase()
  const looksLikeInstagramHost = hostname.includes('instagram.com')
  if (!looksLikeInstagramHost) return { url: input, isInstagram: false }
  if (!INSTAGRAM_HOSTS.has(hostname) || (parsed.port && !['80', '443'].includes(parsed.port))) {
    throw new SavedUrlError('Instagram links must use instagram.com, www.instagram.com, or m.instagram.com.', 'unsupported_instagram_url')
  }

  const match = parsed.pathname.match(/^\/(reel|reels|p)\/([^/]+)\/?$/i)
  if (!match || !INSTAGRAM_SHORTCODE.test(match[2])) {
    throw new SavedUrlError('Use a supported Instagram Reel or post permalink with its content identifier.', 'unsupported_instagram_url')
  }

  const kind = match[1].toLowerCase() === 'p' ? 'p' : 'reel'
  const shortcode = match[2]
  return {
    url: `https://www.instagram.com/${kind}/${shortcode}/`,
    isInstagram: true,
    shortcode,
    kind,
  }
}

/**
 * Return equivalent old Instagram permalink query patterns. The final match is
 * always checked by canonical URL equality, so SQL LIKE wildcards in a shortcode
 * can only widen candidate lookup, never create a false duplicate.
 * @param {NormalizedSavedUrl} normalized
 * @returns {string[]}
 */
export function instagramDuplicateFilters(normalized) {
  if (!normalized.isInstagram || !normalized.kind || !normalized.shortcode) return []
  const forms = normalized.kind === 'reel' ? ['reel', 'reels'] : ['p']
  return forms.map(kind => `source_url.ilike.%instagram.com/${kind}/${normalized.shortcode}%`)
}

/** @param {Array<{id: string, source_url: string}>} items @param {string} canonicalUrl @param {string} [excludeId] */
export function findEquivalentSavedItemId(items, canonicalUrl, excludeId = '') {
  for (const item of items) {
    if (item.id === excludeId) continue
    try {
      if (normalizeSavedUrl(item.source_url).url === canonicalUrl) return item.id
    } catch {
      // Legacy malformed rows should not prevent saving a valid new URL.
    }
  }
  return null
}
