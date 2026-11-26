export function TagChips({ tags }: { tags: readonly string[] }) {
  if (!tags.length) return null
  return (
    <span class="forge-tags">
      {tags.map((tag) => (
        <span class="forge-tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  )
}
