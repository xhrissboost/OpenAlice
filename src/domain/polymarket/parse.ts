import type { PolymarketMarket, PolymarketOutcome, PolymarketProtocol } from './types.js'

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => item != null).map((item) => String(item))
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => item != null).map((item) => String(item)) : []
  } catch {
    return []
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function firstNumber(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(raw[key])
    if (value != null) return value
  }
  return null
}

function protocolOf(raw: Record<string, unknown>, clobIds: string[], positionIds: string[]): PolymarketProtocol {
  const version = String(raw['version'] ?? '').toLowerCase()
  if (version === 'v2') return 'v2'
  if (version === 'v1') return 'v1'
  if (!clobIds.length && positionIds.length) return 'v2'
  if (clobIds.length) return 'v1'
  return 'unknown'
}

/**
 * Gamma lists v1 trading ids in `clobTokenIds` and v2 ids in `positionIds`.
 * A market with neither id cannot be quoted, so it is dropped.
 */
export function parseGammaMarket(value: unknown): PolymarketMarket | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = raw['id']
  if (id == null || String(id).length === 0) return null
  const clobIds = parseStringList(raw['clobTokenIds'])
  const positionIds = parseStringList(raw['positionIds'])
  const version = protocolOf(raw, clobIds, positionIds)
  const assetIds = version === 'v2' ? positionIds : (clobIds.length ? clobIds : positionIds)
  if (!assetIds.length) return null
  const names = parseStringList(raw['outcomes'])
  const outcomes: PolymarketOutcome[] = assetIds.map((assetId, index) => ({
    name: names[index]?.trim() || (index === 0 ? 'Yes' : index === 1 ? 'No' : `Outcome ${index + 1}`),
    assetId,
    index,
  }))
  return {
    id: String(id),
    slug: typeof raw['slug'] === 'string' ? raw['slug'] : '',
    question: typeof raw['question'] === 'string' && raw['question'].trim()
      ? raw['question']
      : (typeof raw['title'] === 'string' ? raw['title'] : String(id)),
    conditionId: typeof raw['conditionId'] === 'string'
      ? raw['conditionId']
      : (typeof raw['condition_id'] === 'string' ? raw['condition_id'] : ''),
    version,
    outcomes,
    closed: raw['closed'] === true,
    acceptingOrders: raw['acceptingOrders'] !== false,
    enableOrderBook: raw['enableOrderBook'] !== false,
    liquidityUsd: firstNumber(raw, ['liquidityNum', 'liquidityClob', 'liquidity']),
    volume24hrUsd: firstNumber(raw, ['volume24hrClob', 'volume24hr', 'volumeNum']),
  }
}

export function parseEventMarkets(value: unknown): PolymarketMarket[] {
  if (!value || typeof value !== 'object') return []
  const markets = (value as Record<string, unknown>)['markets']
  if (!Array.isArray(markets)) {
    const one = parseGammaMarket(value)
    return one ? [one] : []
  }
  return markets.flatMap((market) => {
    const parsed = parseGammaMarket(market)
    return parsed ? [parsed] : []
  })
}

export interface SearchEventRef {
  id: string
  slug: string
  title: string
}

export function parseSearchEvents(value: unknown): SearchEventRef[] {
  if (!value || typeof value !== 'object') return []
  const events = (value as Record<string, unknown>)['events']
  if (!Array.isArray(events)) return []
  const refs: SearchEventRef[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const raw = event as Record<string, unknown>
    if (raw['id'] == null) continue
    refs.push({
      id: String(raw['id']),
      slug: typeof raw['slug'] === 'string' ? raw['slug'] : '',
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
    })
  }
  return refs
}

export function parseKeysetIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const markets = (value as Record<string, unknown>)['markets']
  if (!Array.isArray(markets)) return []
  return markets.flatMap((market) => {
    if (!market || typeof market !== 'object' || (market as Record<string, unknown>)['id'] == null) return []
    return [String((market as Record<string, unknown>)['id'])]
  })
}
