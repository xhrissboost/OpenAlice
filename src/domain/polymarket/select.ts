import type { LiquidityCriteria, PolymarketMarket, PolymarketOutcome, PolymarketQuote, RankedMarket } from './types.js'

export const DEFAULT_LIQUIDITY_CRITERIA: LiquidityCriteria = {
  maxSpread: 0.05,
  minDepthUsd: 100,
  depthBand: 0.03,
  limit: 5,
}

export function pickOutcome(market: PolymarketMarket, name?: string): PolymarketOutcome | null {
  if (!market.outcomes.length) return null
  if (!name) return market.outcomes[0]
  const wanted = name.trim().toLowerCase()
  return market.outcomes.find((outcome) => outcome.name.toLowerCase() === wanted) ?? null
}

export function judgeLiquidity(market: PolymarketMarket, quote: PolymarketQuote, criteria: LiquidityCriteria): {
  accepted: boolean
  score: number | null
  reason?: string
} {
  if (!market.acceptingOrders) return { accepted: false, score: null, reason: 'market is not accepting orders' }
  if (!market.enableOrderBook) return { accepted: false, score: null, reason: 'order book is disabled' }
  if (market.closed) return { accepted: false, score: null, reason: 'market is closed' }
  if (quote.bestBid == null || quote.bestAsk == null || quote.spread == null) {
    return { accepted: false, score: null, reason: 'book is not two-sided' }
  }
  if (quote.spread - criteria.maxSpread > 1e-9) {
    return { accepted: false, score: null, reason: `spread ${quote.spread.toFixed(4)} exceeds ${criteria.maxSpread}` }
  }
  if (quote.twoSidedDepthUsd + 1e-9 < criteria.minDepthUsd) {
    return {
      accepted: false,
      score: null,
      reason: `two-sided depth ${quote.twoSidedDepthUsd.toFixed(2)} USDC is below ${criteria.minDepthUsd}`,
    }
  }
  // Depth dominates. Spread is a penalty so a tighter book wins a tie on size.
  const score = Math.log1p(quote.twoSidedDepthUsd) * 100 - quote.spread * 1_000
  return { accepted: true, score }
}

export function rankMarkets(rows: RankedMarket[], limit: number): { selected: RankedMarket[]; rejected: RankedMarket[] } {
  const selected = rows
    .filter((row) => row.accepted)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.market.question.localeCompare(b.market.question))
    .slice(0, Math.max(1, limit))
  const selectedIds = new Set(selected.map((row) => `${row.market.id}:${row.outcome?.assetId ?? ''}`))
  const rejected = rows.filter((row) => !selectedIds.has(`${row.market.id}:${row.outcome?.assetId ?? ''}`))
  return { selected, rejected }
}
