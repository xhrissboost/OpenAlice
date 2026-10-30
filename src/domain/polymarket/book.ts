import type { BookLevel, PolymarketBook, PolymarketQuote } from './types.js'

function level(value: unknown): BookLevel | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const price = Number(raw['price'])
  const size = Number(raw['size'])
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || price >= 1 || size < 0) return null
  return { price, size }
}

function levels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = level(entry)
    return parsed ? [parsed] : []
  })
}

/** The public book is not guaranteed best-first. Sort so walks start at the touch. */
export function parseOrderBook(value: unknown, fallbackAssetId?: string): PolymarketBook {
  if (!value || typeof value !== 'object') throw new Error('Polymarket book response was not an object')
  const raw = value as Record<string, unknown>
  const assetId = String(raw['asset_id'] ?? raw['assetId'] ?? fallbackAssetId ?? '')
  if (!assetId) throw new Error('Polymarket book response did not include an asset id')
  const tick = String(raw['tick_size'] ?? raw['tickSize'] ?? '0.01')
  const minOrder = Number(raw['min_order_size'] ?? raw['minOrderSize'] ?? 0)
  const last = raw['last_trade_price'] ?? raw['lastTradePrice']
  const lastTrade = last == null || last === '' ? null : Number(last)
  return {
    assetId,
    conditionId: String(raw['condition_id'] ?? raw['market'] ?? raw['conditionId'] ?? ''),
    bids: levels(raw['bids']).sort((a, b) => b.price - a.price),
    asks: levels(raw['asks']).sort((a, b) => a.price - b.price),
    tickSize: tick,
    minOrderSize: Number.isFinite(minOrder) ? minOrder : 0,
    negRisk: raw['neg_risk'] === true || raw['negRisk'] === true,
    lastTradePrice: lastTrade != null && Number.isFinite(lastTrade) ? lastTrade : null,
  }
}

/** USDC notional of size resting within `band` of the touch. */
export function depthNearTouch(levels: BookLevel[], best: number, band: number, side: 'bid' | 'ask'): number {
  let usd = 0
  for (const entry of levels) {
    const distance = side === 'bid' ? best - entry.price : entry.price - best
    if (distance < -1e-9 || distance - band > 1e-9) continue
    usd += entry.size * entry.price
  }
  return usd
}

export function quoteFromBook(book: PolymarketBook, depthBand: number): PolymarketQuote {
  const bestBid = book.bids[0]?.price ?? null
  const bestAsk = book.asks[0]?.price ?? null
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null
  const bidDepthUsd = bestBid == null ? 0 : depthNearTouch(book.bids, bestBid, depthBand, 'bid')
  const askDepthUsd = bestAsk == null ? 0 : depthNearTouch(book.asks, bestAsk, depthBand, 'ask')
  const twoSidedDepthUsd = bestBid != null && bestAsk != null ? Math.min(bidDepthUsd, askDepthUsd) : 0
  return {
    assetId: book.assetId,
    bestBid,
    bestAsk,
    mid,
    spread,
    bidDepthUsd,
    askDepthUsd,
    twoSidedDepthUsd,
    tickSize: book.tickSize,
    minOrderSize: book.minOrderSize,
    lastTradePrice: book.lastTradePrice,
  }
}

export interface WalkResult {
  filled: number
  notional: number
  worstPrice: number | null
}

/** Consume best-first levels until `shares` is filled or the book runs out. */
export function walkBook(levels: BookLevel[], shares: number): WalkResult {
  let remaining = shares
  let notional = 0
  let worstPrice: number | null = null
  for (const entry of levels) {
    if (remaining <= 1e-12) break
    const take = Math.min(remaining, entry.size)
    notional += take * entry.price
    remaining -= take
    worstPrice = entry.price
  }
  return { filled: shares - Math.max(0, remaining), notional, worstPrice }
}
