export const galleryQueryLimit = 100

const stripPresentationSelectors = (value: string) => value.replace(/[\uFE0E\uFE0F]/g, '')

export function cleanSearchQuery(query: string) {
  return stripPresentationSelectors(query).trim()
}

// Folds beyond final sigma and sharp S (such as ligatures) are out of scope.
const fold = (value: string) =>
  value.normalize('NFC').toLowerCase().replaceAll('ς', 'σ').replaceAll('ß', 'ss').normalize('NFC')

export function gallerySearch(params: URLSearchParams) {
  const query = cleanSearchQuery(params.get('q') ?? '')
    .slice(0, galleryQueryLimit)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
  const needle = fold(query)
  const markAt = /\p{M}/uy
  // A folded match must not consume only part of an accented character.
  const startsWithMark = markAt.test(needle)
  function matchesText(value: string) {
    const text = fold(stripPresentationSelectors(value))
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      markAt.lastIndex = at + needle.length
      if (!markAt.test(text)) return true
    }
    return false
  }
  return {
    query,
    matches: ({ slug, title, tags }: { slug: string; title: string; tags: readonly string[] }) =>
      !needle ||
      (!startsWithMark &&
        (matchesText(slug) || matchesText(title) || tags.some((tag) => tag.includes(needle)))),
  }
}
