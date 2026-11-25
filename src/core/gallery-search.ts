export const galleryQueryLimit = 100

// Folds beyond final sigma and sharp S (such as ligatures) are out of scope.
const fold = (value: string) =>
  value.normalize('NFC').toLowerCase().replaceAll('ς', 'σ').replaceAll('ß', 'ss').normalize('NFC')

export function gallerySearch(rawQuery: string) {
  const query = rawQuery
    .trim()
    .slice(0, galleryQueryLimit)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
  const needle = fold(query)
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
      !query || (!startsWithMark && (matchesText(slug) || matchesText(title))),
  }
}
