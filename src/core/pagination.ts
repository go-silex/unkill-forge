export const adminCountLimit = 100
export const adminPageSize = 50

// Accepts at most one extra row; returns the last retained row if there was an extra.
export function trimLookahead<T>(rows: T[], limit: number): T | undefined {
  if (rows.length <= limit) return undefined
  rows.pop()
  return rows[limit - 1]
}
