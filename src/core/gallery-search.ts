export const galleryQueryLimit = 100

const stripPresentationSelectors = (value: string) => value.replace(/[\uFE0E\uFE0F]/g, '')

export function literalSearch(query: string) {
  const literal = stripPresentationSelectors(query)
  const like = `%${literal.replace(/[!%_]/g, '!$&')}%`
  // D1 caps LIKE patterns at 50 bytes; fall back to a literal substring search.
  return { literal, pattern: new TextEncoder().encode(like).length <= 50 ? like : null }
}

// Folds beyond final sigma and sharp S (such as ligatures) are out of scope.
const fold = (value: string) =>
  stripPresentationSelectors(value)
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .replaceAll('ß', 'ss')
    .normalize('NFC')

export function gallerySearch(params: URLSearchParams) {
  const query = (params.get('q') ?? '')
    .trim()
    .slice(0, galleryQueryLimit)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
  const needle = fold(query).trim()
  const markAt = /\p{M}/uy
  // A folded match must not consume only part of an accented character.
  const startsWithMark = markAt.test(needle)
  function matchesText(value: string) {
    const text = fold(value)
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      markAt.lastIndex = at + needle.length
      if (!markAt.test(text)) return true
    }
    return false
  }
  return {
    query,
    matches: ({ slug, title }: { slug: string; title: string }) =>
      !needle || (!startsWithMark && (matchesText(slug) || matchesText(title))),
  }
}
