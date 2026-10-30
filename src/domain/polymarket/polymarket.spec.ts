import { describe, expect, it, vi } from 'vitest'
import { parseEventMarkets, parseGammaMarket, parseSearchEvents } from './parse.js'
import { parseOrderBook, quoteFromBook } from './book.js'
import { judgeLiquidity, rankMarkets } from './select.js'
import { limitOrderAmounts, planOrder, toBaseUnits } from './order.js'
import { createPolymarketClient, PolymarketError, type PolymarketTransport } from './client.js'
import type { PolymarketBook, PolymarketMarket, RankedMarket } from './types.js'

const V1 = {
  id: '703257',
  version: 'v1',
  slug: 'aliens-before-2027',
  question: 'Will the US confirm that aliens exist before 2027?',
  conditionId: '0xabc',
  clobTokenIds: '["yes-token","no-token"]',
  positionIds: null,
  outcomes: '["Yes","No"]',
  acceptingOrders: true,
  liquidityNum: 25000,
  volume24hr: 4000,
}

const V2 = {
  id: '1',
  version: 'v2',
  slug: 'v2-market',
  question: 'V2 question',
  conditionId: '0xdef',
  clobTokenIds: null,
  positionIds: ['pos-yes', 'pos-no'],
  outcomes: ['Yes', 'No'],
}

function book(over: Partial<PolymarketBook> = {}): PolymarketBook {
  return {
    assetId: 'yes-token',
    conditionId: '0xabc',
    bids: [{ price: 0.45, size: 500 }, { price: 0.44, size: 500 }],
    asks: [{ price: 0.47, size: 400 }, { price: 0.48, size: 400 }],
    tickSize: '0.01',
    minOrderSize: 5,
    negRisk: false,
    lastTradePrice: 0.46,
    ...over,
  }
}

function market(over: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id: '1',
    slug: 'liquid',
    question: 'Liquid market',
    conditionId: '0x1',
    version: 'v1',
    outcomes: [{ name: 'Yes', assetId: 'yes-token', index: 0 }],
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    liquidityUsd: 1000,
    volume24hrUsd: 100,
    ...over,
  }
}

describe('Gamma parsing', () => {
  it('reads v1 clob token ids and v2 position ids', () => {
    const v1 = parseGammaMarket(V1)
    const v2 = parseGammaMarket(V2)
    expect(v1?.outcomes.map((outcome) => outcome.assetId)).toEqual(['yes-token', 'no-token'])
    expect(v1?.version).toBe('v1')
    expect(v2?.outcomes.map((outcome) => outcome.assetId)).toEqual(['pos-yes', 'pos-no'])
    expect(v2?.version).toBe('v2')
  })

  it('drops markets that have no trading id and flattens event payloads', () => {
    expect(parseGammaMarket({ id: 'thin', question: 'no ids' })).toBeNull()
    const markets = parseEventMarkets({ id: '90177', markets: [V1, { id: 'empty' }] })
    expect(markets.map((item) => item.id)).toEqual(['703257'])
  })

  it('reads public-search event refs', () => {
    expect(parseSearchEvents({ events: [{ id: 90177, slug: 'aliens', title: 'Aliens' }, { slug: 'no-id' }] }))
      .toEqual([{ id: '90177', slug: 'aliens', title: 'Aliens' }])
  })
})

describe('CLOB book', () => {
  it('sorts a worst-first book so the touch is first', () => {
    const parsed = parseOrderBook({
      asset_id: 'yes-token',
      market: '0xabc',
      bids: [{ price: '0.40', size: '10' }, { price: '0.45', size: '50' }],
      asks: [{ price: '0.55', size: '40' }, { price: '0.47', size: '80' }],
      min_order_size: '5',
      tick_size: '0.01',
      last_trade_price: '0.46',
    })
    expect(parsed.bids[0]).toEqual({ price: 0.45, size: 50 })
    expect(parsed.asks[0]).toEqual({ price: 0.47, size: 80 })
    const quote = quoteFromBook(parsed, 0.03)
    expect(quote.spread).toBeCloseTo(0.02)
    expect(quote.mid).toBeCloseTo(0.46)
    expect(quote.bidDepthUsd).toBeCloseTo(22.5)
    expect(quote.askDepthUsd).toBeCloseTo(37.6)
  })
})

describe('liquidity selection', () => {
  it('rejects a wide or thin book and ranks the deeper book first', () => {
    const wide = quoteFromBook(book({
      bids: [{ price: 0.2, size: 10_000 }],
      asks: [{ price: 0.4, size: 10_000 }],
    }), 0.03)
    const thin = quoteFromBook(book({
      bids: [{ price: 0.45, size: 10 }],
      asks: [{ price: 0.47, size: 10 }],
    }), 0.03)
    const deep = quoteFromBook(book(), 0.03)
    expect(judgeLiquidity(market(), wide, { maxSpread: 0.05, minDepthUsd: 100, depthBand: 0.03, limit: 5 }).reason)
      .toMatch(/spread/)
    expect(judgeLiquidity(market(), thin, { maxSpread: 0.05, minDepthUsd: 100, depthBand: 0.03, limit: 5 }).reason)
      .toMatch(/depth/)
    const deepJudgment = judgeLiquidity(market({ id: 'deep', question: 'Deep' }), deep, {
      maxSpread: 0.05, minDepthUsd: 100, depthBand: 0.03, limit: 5,
    })
    const tighter = quoteFromBook(book({
      bids: [{ price: 0.46, size: 500 }],
      asks: [{ price: 0.47, size: 400 }],
    }), 0.03)
    const tightJudgment = judgeLiquidity(market({ id: 'tight', question: 'Tight' }), tighter, {
      maxSpread: 0.05, minDepthUsd: 100, depthBand: 0.03, limit: 5,
    })
    const rows: RankedMarket[] = [
      { market: market({ id: 'deep', question: 'Deep' }), outcome: market().outcomes[0], quote: deep, ...deepJudgment },
      { market: market({ id: 'tight', question: 'Tight' }), outcome: market().outcomes[0], quote: tighter, ...tightJudgment },
      { market: market({ id: 'wide' }), outcome: null, quote: null, score: null, accepted: false, reason: 'spread' },
    ]
    const ranked = rankMarkets(rows, 1)
    expect(ranked.selected.map((row) => row.market.id)).toEqual(['deep'])
    expect(ranked.rejected.map((row) => row.market.id).sort()).toEqual(['tight', 'wide'])
    expect((tightJudgment.score ?? 0)).toBeGreaterThan(0)
  })
})

describe('order planning', () => {
  it('converts a 10-share buy at 0.52 into 6-decimal collateral and share amounts', () => {
    const amounts = limitOrderAmounts('BUY', 10, 0.52, { price: 2, size: 2, amount: 4 })
    expect(toBaseUnits(amounts.rawMaker)).toBe('5200000')
    expect(toBaseUnits(amounts.rawTaker)).toBe('10000000')
    const sell = limitOrderAmounts('SELL', 10, 0.52, { price: 2, size: 2, amount: 4 })
    expect(toBaseUnits(sell.rawMaker)).toBe('10000000')
    expect(toBaseUnits(sell.rawTaker)).toBe('5200000')
  })

  it('rounds a collateral product that has more decimals than the tick allows', () => {
    const amounts = limitOrderAmounts('BUY', 1.11, 0.3, { price: 1, size: 2, amount: 2 })
    expect(amounts.rawMaker.toNumber()).toBeCloseTo(0.33)
    expect(toBaseUnits(amounts.rawMaker)).toBe('330000')
  })

  it('rejects a FOK that the book cannot fill and caps a FAK to resting size', () => {
    const thin = book({ asks: [{ price: 0.47, size: 8 }] })
    expect(planOrder(thin, { side: 'BUY', size: 20, orderType: 'FOK' }).reason).toMatch(/FOK/)
    const fak = planOrder(thin, { side: 'BUY', size: 20, orderType: 'FAK' })
    expect(fak.status).toBe('planned')
    expect(fak.size).toBe(8)
    expect(fak.price).toBeCloseTo(0.47)
    expect(fak.submitted).toBe(false)
    expect(fak.submission).toBe('not-requested')
  })

  it('rejects a post-only order that would take and a GTD that expires too soon', () => {
    expect(planOrder(book(), { side: 'BUY', size: 10, price: 0.5, postOnly: true }).reason).toMatch(/post-only/)
    const resting = planOrder(book(), { side: 'BUY', size: 10, price: 0.44, postOnly: true })
    expect(resting.status).toBe('planned')
    expect(resting.crossesBook).toBe(false)
    expect(planOrder(book(), { side: 'BUY', size: 10, price: 0.44, orderType: 'GTD', expiration: 1_000, nowSeconds: 900 }).reason)
      .toMatch(/three minutes/)
  })

  it('does not take asks above a buy limit, and FOK fails when that price is short', () => {
    const planned = planOrder(book(), { side: 'BUY', size: 500, price: 0.47, orderType: 'GTC' })
    expect(planned.status).toBe('planned')
    expect(planned.estimatedFilledShares).toBe(400)
    expect(planned.estimatedAvgPrice).toBeCloseTo(0.47)
    expect(planOrder(book(), { side: 'BUY', size: 500, price: 0.47, orderType: 'FOK' }).reason).toMatch(/FOK/)
  })

  it('plans a crossing GTC without submitting', () => {
    const planned = planOrder(book(), { side: 'BUY', size: 10, price: 0.52, orderType: 'GTC' })
    expect(planned.makerAmount).toBe('5200000')
    expect(planned.takerAmount).toBe('10000000')
    expect(planned.crossesBook).toBe(true)
    expect(planned.estimatedFilledShares).toBe(10)
    expect(planned.submitted).toBe(false)
  })
})

describe('Polymarket client', () => {
  function routes(map: Record<string, unknown>): PolymarketTransport & { gets: string[] } {
    const gets: string[] = []
    return {
      gets,
      async getJson(url: string) {
        gets.push(url)
        const hit = Object.entries(map).find(([key]) => url.includes(key))
        if (!hit) throw new PolymarketError(`not found ${url}`, 404)
        return hit[1]
      },
    }
  }

  it('hydrates search hits into markets that have trading ids', async () => {
    const http = routes({
      '/public-search': { events: [{ id: '90177', slug: 'aliens', title: 'Aliens' }] },
      '/events/90177': { id: '90177', markets: [V1] },
    })
    const client = createPolymarketClient({ transport: http })
    const found = await client.discover({ q: 'aliens', limit: 5 })
    expect(found.map((item) => item.slug)).toEqual(['aliens-before-2027'])
    expect(http.gets.some((url) => url.includes('/order'))).toBe(false)
  })

  it('selects the liquid outcome and skips a wide one after reading both books', async () => {
    const liquid = {
      ...V1,
      id: 'liquid',
      question: 'Liquid',
      clobTokenIds: '["liquid-yes","liquid-no"]',
    }
    const wide = {
      ...V1,
      id: 'wide',
      question: 'Wide',
      clobTokenIds: '["wide-yes","wide-no"]',
    }
    const http = routes({
      '/markets/keyset': { markets: [{ id: 'liquid' }, { id: 'wide' }] },
      '/markets/liquid': liquid,
      '/markets/wide': wide,
      'token_id=liquid-yes': {
        asset_id: 'liquid-yes',
        bids: [{ price: '0.45', size: '1000' }],
        asks: [{ price: '0.47', size: '1000' }],
        tick_size: '0.01',
        min_order_size: '5',
      },
      'token_id=wide-yes': {
        asset_id: 'wide-yes',
        bids: [{ price: '0.10', size: '1000' }],
        asks: [{ price: '0.40', size: '1000' }],
        tick_size: '0.01',
        min_order_size: '5',
      },
    })
    const client = createPolymarketClient({ transport: http })
    const ranked = await client.select({ maxSpread: 0.05, minDepthUsd: 100, limit: 5 })
    expect(ranked.selected.map((row) => row.market.id)).toEqual(['liquid'])
    expect(ranked.rejected.map((row) => row.market.id)).toEqual(['wide'])
  })

  it('refuses to submit when no submitter is configured and posts once when one is', async () => {
    const http = routes({})
    const offline = createPolymarketClient({ transport: http })
    const refused = await offline.plan({
      assetId: 'yes-token',
      book: book(),
      side: 'BUY',
      size: 10,
      price: 0.44,
      submit: true,
    })
    expect(refused.submission).toBe('refused')
    expect(refused.submitted).toBe(false)
    expect(http.gets).toEqual([])

    const submit = vi.fn(async () => ({ success: true, orderID: 'ord-1', status: 'live' }))
    const live = createPolymarketClient({ transport: http, submitter: { submit } })
    const sent = await live.plan({
      assetId: 'yes-token',
      book: book(),
      side: 'BUY',
      size: 10,
      price: 0.44,
      submit: true,
    })
    expect(sent.submitted).toBe(true)
    expect(sent.submission).toBe('submitted')
    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        makerAmount: '4400000',
        takerAmount: '10000000',
        tokenId: 'yes-token',
      }),
    }))
    expect(http.gets).toEqual([])
  })
})
