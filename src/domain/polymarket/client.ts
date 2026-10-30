import type { LiquidityCriteria, OrderPlan, PolymarketBook, PolymarketMarket, PolymarketQuote, RankedMarket } from './types.js'
import { parseEventMarkets, parseGammaMarket, parseKeysetIds, parseSearchEvents } from './parse.js'
import { parseOrderBook, quoteFromBook } from './book.js'
import { DEFAULT_LIQUIDITY_CRITERIA, judgeLiquidity, pickOutcome, rankMarkets } from './select.js'
import { planOrder, type PlanOrderInput } from './order.js'
import { polymarketRefusalReason, type PolymarketTradingMode } from './trading.js'

export const POLYMARKET_GAMMA_URL = 'https://gamma-api.polymarket.com'
export const POLYMARKET_CLOB_URL = 'https://clob.polymarket.com'

export class PolymarketError extends Error {
  readonly code = 'POLYMARKET_HTTP'

  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'PolymarketError'
  }
}

export interface PolymarketTransport {
  getJson(url: string): Promise<unknown>
}

export interface PolymarketSubmitBody {
  deferExec: false
  orderType: OrderPlan['orderType']
  postOnly: boolean
  order: {
    tokenId: string
    side: OrderPlan['side']
    price: number
    size: number
    makerAmount: string
    takerAmount: string
    expiration: string
    /** Selects the neg-risk exchange when signing. */
    negRisk?: boolean
  }
}

export interface PolymarketSubmitAck {
  success: boolean
  orderID?: string
  status?: string
  errorMsg?: string
}

/**
 * The only way a plan becomes a POST. OpenAlice does not construct one.
 * Callers that inject a submitter still have to pass signing material.
 */
export interface PolymarketSubmitter {
  submit(body: PolymarketSubmitBody): Promise<PolymarketSubmitAck>
}

export interface DiscoverQuery {
  q?: string
  slug?: string
  limit?: number
}

export interface SelectQuery extends DiscoverQuery {
  outcome?: string
  maxSpread?: number
  minDepthUsd?: number
  depthBand?: number
  markets?: PolymarketMarket[]
}

export interface PlanQuery extends PlanOrderInput {
  assetId: string
  book?: PolymarketBook
  /** Ask to submit. Refused unless auto trading is enabled and a submitter exists. */
  submit?: boolean
  expiration?: number
}

export interface AutoQuery extends SelectQuery, PlanOrderInput {}

export interface AutoResult {
  status: 'planned' | 'rejected'
  submitted: boolean
  submission: OrderPlan['submission']
  reason?: string
  market: PolymarketMarket | null
  assetId: string | null
  plan: OrderPlan | null
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(25, Math.floor(value)))
}

export function createFetchTransport(fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): PolymarketTransport {
  return {
    async getJson(url: string): Promise<unknown> {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw new PolymarketError(`Polymarket request failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!response.ok) {
        throw new PolymarketError(`Polymarket ${response.status} for ${url}`, response.status)
      }
      return response.json() as Promise<unknown>
    },
  }
}

export interface PolymarketClientOptions {
  gammaUrl?: string
  clobUrl?: string
  transport?: PolymarketTransport
  submitter?: PolymarketSubmitter
  /** Why a submit was refused. Does not itself enable posting. */
  trading?: PolymarketTradingMode
}

export interface PolymarketClient {
  discover(query?: DiscoverQuery): Promise<PolymarketMarket[]>
  book(assetId: string): Promise<PolymarketBook>
  quote(assetId: string, depthBand?: number): Promise<PolymarketQuote>
  select(query?: SelectQuery): Promise<{ selected: RankedMarket[]; rejected: RankedMarket[] }>
  plan(query: PlanQuery): Promise<OrderPlan>
  /** Select the best liquid market, plan, and submit only when a submitter is configured. */
  auto(query: AutoQuery): Promise<AutoResult>
}

export function createPolymarketClient(options: PolymarketClientOptions = {}): PolymarketClient {
  const gammaUrl = (options.gammaUrl ?? POLYMARKET_GAMMA_URL).replace(/\/$/, '')
  const clobUrl = (options.clobUrl ?? POLYMARKET_CLOB_URL).replace(/\/$/, '')
  const transport = options.transport ?? createFetchTransport()
  const submitter = options.submitter
  const trading = options.trading

  async function getOptional(url: string): Promise<unknown | undefined> {
    try {
      return await transport.getJson(url)
    } catch (err) {
      if (err instanceof PolymarketError && err.status === 404) return undefined
      throw err
    }
  }

  async function discover(query: DiscoverQuery = {}): Promise<PolymarketMarket[]> {
    const limit = clampLimit(query.limit, 10)
    if (query.slug) {
      const bySlug = await getOptional(`${gammaUrl}/markets/slug/${encodeURIComponent(query.slug)}`)
      const direct = bySlug ? parseGammaMarket(bySlug) : null
      if (direct) return [direct]
      const event = await getOptional(`${gammaUrl}/events/slug/${encodeURIComponent(query.slug)}`)
      return event ? parseEventMarkets(event).slice(0, limit) : []
    }
    if (query.q?.trim()) {
      const search = await transport.getJson(`${gammaUrl}/public-search?q=${encodeURIComponent(query.q.trim())}`)
      const events = parseSearchEvents(search).slice(0, limit)
      const markets: PolymarketMarket[] = []
      for (const event of events) {
        const full = await transport.getJson(`${gammaUrl}/events/${encodeURIComponent(event.id)}`)
        markets.push(...parseEventMarkets(full))
        if (markets.length >= limit) break
      }
      return markets.slice(0, limit)
    }
    const page = await transport.getJson(`${gammaUrl}/markets/keyset?closed=false&limit=${limit}`)
    const ids = parseKeysetIds(page).slice(0, limit)
    const markets: PolymarketMarket[] = []
    for (const id of ids) {
      const full = await transport.getJson(`${gammaUrl}/markets/${encodeURIComponent(id)}`)
      const parsed = parseGammaMarket(full)
      if (parsed) markets.push(parsed)
    }
    return markets
  }

  async function book(assetId: string): Promise<PolymarketBook> {
    const payload = await transport.getJson(`${clobUrl}/book?token_id=${encodeURIComponent(assetId)}`)
    return parseOrderBook(payload, assetId)
  }

  async function quote(assetId: string, depthBand = DEFAULT_LIQUIDITY_CRITERIA.depthBand): Promise<PolymarketQuote> {
    return quoteFromBook(await book(assetId), depthBand)
  }

  async function select(query: SelectQuery = {}): Promise<{ selected: RankedMarket[]; rejected: RankedMarket[] }> {
    const criteria: LiquidityCriteria = {
      maxSpread: query.maxSpread ?? DEFAULT_LIQUIDITY_CRITERIA.maxSpread,
      minDepthUsd: query.minDepthUsd ?? DEFAULT_LIQUIDITY_CRITERIA.minDepthUsd,
      depthBand: query.depthBand ?? DEFAULT_LIQUIDITY_CRITERIA.depthBand,
      limit: clampLimit(query.limit, DEFAULT_LIQUIDITY_CRITERIA.limit),
    }
    const scan = Math.min(25, Math.max(criteria.limit, 12))
    const markets = query.markets ?? await discover({
      q: query.q,
      slug: query.slug,
      limit: scan,
    })
    const ranked = await Promise.all(markets.map(async (market): Promise<RankedMarket> => {
      const outcome = pickOutcome(market, query.outcome)
      if (!outcome) {
        return { market, outcome: null, quote: null, score: null, accepted: false, reason: 'no tradable outcome id' }
      }
      try {
        const nextBook = await book(outcome.assetId)
        const nextQuote = quoteFromBook(nextBook, criteria.depthBand)
        const judgment = judgeLiquidity(market, nextQuote, criteria)
        return { market, outcome, quote: nextQuote, ...judgment }
      } catch (err) {
        return {
          market,
          outcome,
          quote: null,
          score: null,
          accepted: false,
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }))
    return rankMarkets(ranked, criteria.limit)
  }

  async function plan(query: PlanQuery): Promise<OrderPlan> {
    const nextBook = query.book ?? await book(query.assetId)
    const planned = planOrder(nextBook, query)
    if (!query.submit) return planned
    if (planned.status !== 'planned' || planned.makerAmount == null || planned.takerAmount == null || planned.price == null || planned.size == null) {
      return { ...planned, submitted: false, submission: 'refused' }
    }
    if (!submitter) {
      return {
        ...planned,
        submitted: false,
        submission: 'refused',
        reason: polymarketRefusalReason(trading),
      }
    }
    const ack = await submitter.submit({
      deferExec: false,
      orderType: planned.orderType,
      postOnly: planned.postOnly,
      order: {
        tokenId: planned.assetId,
        side: planned.side,
        price: planned.price,
        size: planned.size,
        makerAmount: planned.makerAmount,
        takerAmount: planned.takerAmount,
        expiration: query.orderType === 'GTD' && query.expiration != null ? String(query.expiration) : '0',
        negRisk: nextBook.negRisk,
      },
    })
    return {
      ...planned,
      submitted: ack.success === true,
      submission: 'submitted',
      reason: ack.success ? planned.reason : (ack.errorMsg || 'CLOB rejected the order'),
    }
  }

  async function auto(query: AutoQuery): Promise<AutoResult> {
    const ranked = await select({
      q: query.q,
      slug: query.slug,
      outcome: query.outcome,
      maxSpread: query.maxSpread,
      minDepthUsd: query.minDepthUsd,
      depthBand: query.depthBand,
      limit: 1,
      markets: query.markets,
    })
    const pick = ranked.selected[0]
    if (!pick?.outcome) {
      const rejected = ranked.rejected[0]
      return {
        status: 'rejected',
        submitted: false,
        submission: 'refused',
        reason: rejected?.reason ?? 'no liquid market',
        market: rejected?.market ?? null,
        assetId: null,
        plan: null,
      }
    }
    const planned = await plan({ ...query, assetId: pick.outcome.assetId, submit: true })
    return {
      status: planned.status,
      submitted: planned.submitted,
      submission: planned.submission,
      ...(planned.reason ? { reason: planned.reason } : {}),
      market: pick.market,
      assetId: pick.outcome.assetId,
      plan: planned,
    }
  }

  return { discover, book, quote, select, plan, auto }
}
