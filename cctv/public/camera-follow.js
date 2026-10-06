/** New servers key suggestions by camera; older responses used a flat list. */
export function followSuggestionsFor(suggestions, camera) {
  const items = Array.isArray(suggestions) ? suggestions.filter((s) => s?.from === camera) : suggestions?.[camera]
  return Array.isArray(items) ? items.filter((s) => s && typeof s.to === 'string') : []
}
