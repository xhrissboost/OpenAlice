/**
 * Public Polymarket shapes used by discovery, the CLOB book, and order plans.
 * Amounts that cross the wire stay strings; scores and quotes are numbers.
 */

export type PolymarketProtocol = 'v1' | 'v2' | 'unknown'

export interface PolymarketOutcome {
  name: string
  /** CLOB token id (v1) or protocol position id (v2). The book key. */
  assetId: string
  index: number
}

export interface PolymarketMarket {
  id: string
  slug: string
  question: string
  conditionId: string
  version: PolymarketProtocol
  outcomes: PolymarketOutcome[]
  closed: boolean
  /** False only when Gamma explicitly says the market is not taking orders. */
  acceptingOrders: boolean
  enableOrderBook: boolean
  liquidityUsd: number | null
  volume24hrUsd: number | null
}

export interface BookLevel {
  price: number
  size: number
}

/** Bids are best-first (highest price). Asks are best-first (lowest price). */
export interface PolymarketBook {
  assetId: string
  conditionId: string
  bids: BookLevel[]
  asks: BookLevel[]
  tickSize: string
  minOrderSize: number
  negRisk: boolean
  lastTradePrice: number | null
}

export interface PolymarketQuote {
  assetId: string
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  /** USDC notional resting within the depth band of the touch. */
  bidDepthUsd: number
  askDepthUsd: number
  twoSidedDepthUsd: number
  tickSize: string
  minOrderSize: number
  lastTradePrice: number | null
}

export interface LiquidityCriteria {
  maxSpread: number
  minDepthUsd: number
  depthBand: number
  limit: number
}

export interface RankedMarket {
  market: PolymarketMarket
  outcome: PolymarketOutcome | null
  quote: PolymarketQuote | null
  score: number | null
  accepted: boolean
  reason?: string
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderTimeInForce = 'GTC' | 'GTD' | 'FOK' | 'FAK'

export interface OrderPlan {
  status: 'planned' | 'rejected'
  reason?: string
  submitted: boolean
  /** `refused` means a submit was asked for and this process declined to POST. */
  submission: 'not-requested' | 'refused' | 'submitted'
  side: OrderSide
  orderType: OrderTimeInForce
  assetId: string
  price: number | null
  size: number | null
  tickSize: string | null
  makerAmount: string | null
  takerAmount: string | null
  postOnly: boolean
  crossesBook: boolean
  estimatedAvgPrice: number | null
  estimatedFilledShares: number
  slippageVsMid: number | null
}
