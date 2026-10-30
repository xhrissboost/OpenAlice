import Decimal from 'decimal.js'
import type { BookLevel, OrderPlan, OrderSide, OrderTimeInForce, PolymarketBook } from './types.js'
import { quoteFromBook, walkBook } from './book.js'

const COLLATERAL_DECIMALS = 6

export interface RoundConfig {
  price: number
  size: number
  amount: number
}

/** Tick → decimal budget. Matches the CLOB client's published rounding table. */
export const TICK_ROUNDING: Record<string, RoundConfig> = {
  '0.1': { price: 1, size: 2, amount: 3 },
  '0.01': { price: 2, size: 2, amount: 4 },
  '0.001': { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 },
}

function decimalPlaces(value: Decimal): number {
  return Math.max(0, value.decimalPlaces())
}

function roundTo(value: Decimal, places: number, mode: Decimal.Rounding): Decimal {
  return value.toDecimalPlaces(places, mode)
}

/**
 * Share/collateral amounts before the 6-decimal integer conversion.
 * The extra round exists because a product can carry more decimals than the
 * exchange accepts for that tick.
 */
export function limitOrderAmounts(
  side: OrderSide,
  size: number,
  price: number,
  round: RoundConfig,
): { rawMaker: Decimal; rawTaker: Decimal; price: Decimal } {
  const rawPrice = roundTo(new Decimal(price), round.price, Decimal.ROUND_HALF_UP)
  if (side === 'BUY') {
    const rawTaker = roundTo(new Decimal(size), round.size, Decimal.ROUND_DOWN)
    let rawMaker = rawTaker.mul(rawPrice)
    if (decimalPlaces(rawMaker) > round.amount) {
      rawMaker = roundTo(rawMaker, round.amount + 4, Decimal.ROUND_UP)
      if (decimalPlaces(rawMaker) > round.amount) rawMaker = roundTo(rawMaker, round.amount, Decimal.ROUND_DOWN)
    }
    return { rawMaker, rawTaker, price: rawPrice }
  }
  const rawMaker = roundTo(new Decimal(size), round.size, Decimal.ROUND_DOWN)
  let rawTaker = rawMaker.mul(rawPrice)
  if (decimalPlaces(rawTaker) > round.amount) {
    rawTaker = roundTo(rawTaker, round.amount + 4, Decimal.ROUND_UP)
    if (decimalPlaces(rawTaker) > round.amount) rawTaker = roundTo(rawTaker, round.amount, Decimal.ROUND_DOWN)
  }
  return { rawMaker, rawTaker, price: rawPrice }
}

export function toBaseUnits(amount: Decimal): string {
  return amount.mul(new Decimal(10).pow(COLLATERAL_DECIMALS)).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0)
}

export interface PlanOrderInput {
  side: OrderSide
  /** Share quantity. Marketable orders walk the book for this many shares. */
  size: number
  /** Required for GTC and GTD. Omitted FOK/FAK prices come from the book. */
  price?: number
  orderType?: OrderTimeInForce
  postOnly?: boolean
  /** Unix seconds. GTD only. */
  expiration?: number
  nowSeconds?: number
}

function rejected(input: PlanOrderInput, book: PolymarketBook, reason: string): OrderPlan {
  return {
    status: 'rejected',
    reason,
    submitted: false,
    submission: 'not-requested',
    side: input.side,
    orderType: input.orderType ?? 'GTC',
    assetId: book.assetId,
    price: input.price ?? null,
    size: input.size,
    tickSize: book.tickSize,
    makerAmount: null,
    takerAmount: null,
    postOnly: input.postOnly === true,
    crossesBook: false,
    estimatedAvgPrice: null,
    estimatedFilledShares: 0,
    slippageVsMid: null,
  }
}

function alignMarketable(side: OrderSide, price: number, tickSize: string): number {
  const tick = new Decimal(tickSize)
  const steps = new Decimal(price).div(tick)
  const rounded = side === 'BUY'
    ? steps.toDecimalPlaces(0, Decimal.ROUND_UP)
    : steps.toDecimalPlaces(0, Decimal.ROUND_DOWN)
  return rounded.mul(tick).toNumber()
}

function reachable(side: OrderSide, levels: BookLevel[], limit?: number): BookLevel[] {
  if (limit == null) return levels
  return side === 'BUY'
    ? levels.filter((level) => level.price <= limit + 1e-12)
    : levels.filter((level) => level.price + 1e-12 >= limit)
}

/**
 * Build a limit that the book can actually carry.
 * FOK fails closed when depth is short. FAK shrinks to the resting size.
 * GTC/GTD keep the caller's price and only take the portion that crosses.
 */
export function planOrder(book: PolymarketBook, input: PlanOrderInput): OrderPlan {
  const orderType = input.orderType ?? 'GTC'
  const round = TICK_ROUNDING[book.tickSize]
  if (!round) return rejected(input, book, `unsupported tick size ${book.tickSize}`)
  if (!Number.isFinite(input.size) || input.size <= 0) return rejected(input, book, 'size must be a positive share quantity')

  const marketable = orderType === 'FOK' || orderType === 'FAK'
  const opposing = input.side === 'BUY' ? book.asks : book.bids

  let price = input.price
  let size = input.size
  if (marketable) {
    const available = reachable(input.side, opposing, price)
    const walk = walkBook(available, size)
    if (walk.worstPrice == null || walk.filled <= 0) {
      return rejected(input, book, 'no resting liquidity on the opposing side')
    }
    if (orderType === 'FOK' && walk.filled + 1e-9 < size) {
      return rejected(input, book, `FOK needs ${size} shares and the book only offers ${walk.filled}`)
    }
    if (orderType === 'FAK') size = walk.filled
    if (price == null) price = alignMarketable(input.side, walk.worstPrice, book.tickSize)
  }
  if (price == null) return rejected(input, book, 'GTC and GTD orders require a limit price')
  if (orderType === 'GTD') {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (input.expiration == null) return rejected(input, book, 'GTD orders require an expiration unix timestamp')
    if (input.expiration < now + 180) return rejected(input, book, 'GTD expiration must be at least three minutes in the future')
  }

  const amounts = limitOrderAmounts(input.side, size, price, round)
  const snappedPrice = amounts.price.toNumber()
  const snappedSize = (input.side === 'BUY' ? amounts.rawTaker : amounts.rawMaker).toNumber()
  if (snappedPrice <= 0 || snappedPrice >= 1) return rejected(input, book, `price ${snappedPrice} is outside (0, 1)`)
  if (snappedSize + 1e-12 < book.minOrderSize) {
    return rejected(input, book, `size ${snappedSize} is below the minimum order size ${book.minOrderSize}`)
  }

  const bestAsk = book.asks[0]?.price ?? null
  const bestBid = book.bids[0]?.price ?? null
  const crossesBook = input.side === 'BUY'
    ? bestAsk != null && snappedPrice + 1e-12 >= bestAsk
    : bestBid != null && snappedPrice - 1e-12 <= bestBid
  if (input.postOnly && crossesBook) {
    return rejected(input, book, 'post-only order would cross the book')
  }

  const takingWalk = crossesBook
    ? walkBook(reachable(input.side, opposing, snappedPrice), snappedSize)
    : { filled: 0, notional: 0, worstPrice: null }
  const estimatedFilledShares = crossesBook ? Math.min(snappedSize, takingWalk.filled) : 0
  const estimatedAvgPrice = estimatedFilledShares > 0 ? takingWalk.notional / estimatedFilledShares : null
  const mid = quoteFromBook(book, 0).mid
  const slippageVsMid = estimatedAvgPrice != null && mid != null && mid > 0
    ? (input.side === 'BUY' ? estimatedAvgPrice - mid : mid - estimatedAvgPrice) / mid
    : null

  return {
    status: 'planned',
    submitted: false,
    submission: 'not-requested',
    side: input.side,
    orderType,
    assetId: book.assetId,
    price: snappedPrice,
    size: snappedSize,
    tickSize: book.tickSize,
    makerAmount: toBaseUnits(amounts.rawMaker),
    takerAmount: toBaseUnits(amounts.rawTaker),
    postOnly: input.postOnly === true,
    crossesBook,
    estimatedAvgPrice,
    estimatedFilledShares,
    slippageVsMid,
  }
}
