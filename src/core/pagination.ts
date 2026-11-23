export function trimLookahead<T>(rows: T[], limit: number): T | undefined {
  if (rows.length <= limit) return undefined
  rows.pop()
  return rows[limit - 1]
}
