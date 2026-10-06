export function matchesMapSearch(query, text) {
  const terms = String(query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const value = String(text ?? '').toLocaleLowerCase()
  return terms.every((term) => value.includes(term))
}

export const mapIssue = (state) => state === 'offline' || state === 'alert' || state === 'idle'
