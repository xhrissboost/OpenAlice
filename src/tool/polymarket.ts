/**
 * Polymarket tools. Reads are public. Orders are posted only when auto trading
 * is enabled and CLOB credentials are already in the environment.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { PolymarketClient } from '@/domain/polymarket/client.js'

const discoverFields = {
  q: z.string().optional().describe('Search text. Omit to list open markets.'),
  slug: z.string().optional().describe('Exact market or event slug.'),
  limit: z.number().int().min(1).max(25).optional().describe('Maximum markets to return.'),
}

const orderFields = {
  side: z.enum(['BUY', 'SELL']),
  size: z.number().positive().describe('Share quantity.'),
  price: z.number().positive().optional().describe('Limit price. Required for GTC and GTD. FOK/FAK can omit it and walk the book.'),
  orderType: z.enum(['GTC', 'GTD', 'FOK', 'FAK']).optional().describe('Default GTC.'),
  postOnly: z.boolean().optional().describe('Reject the plan if it would cross the book.'),
  expiration: z.number().int().optional().describe('GTD expiration, unix seconds. Must be at least three minutes ahead.'),
}

export function createPolymarketTools(client: PolymarketClient) {
  return {
    polymarketSearch: tool({
      description: `Discover Polymarket markets from the public Gamma API.

Returns outcome names and the CLOB asset id needed to read a book. v1 markets
use clob token ids; v2 markets use position ids. This does not place an order.`,
      inputSchema: z.object(discoverFields),
      execute: async (input) => client.discover(input),
    }),

    polymarketSelect: tool({
      description: `Rank Polymarket markets by CLOB liquidity.

Reads each candidate's order book and keeps markets that are two-sided, inside
the spread cap, and deep enough near the touch. A wide or one-sided book is
returned under rejected with the reason. This does not place an order.`,
      inputSchema: z.object({
        ...discoverFields,
        outcome: z.string().optional().describe('Outcome name, such as Yes. Defaults to the first outcome.'),
        maxSpread: z.number().positive().optional().describe('Maximum best-ask minus best-bid. Default 0.05.'),
        minDepthUsd: z.number().nonnegative().optional().describe('Minimum two-sided USDC depth near the touch. Default 100.'),
        depthBand: z.number().nonnegative().optional().describe('Price distance from the touch counted as near. Default 0.03.'),
      }),
      execute: async (input) => client.select(input),
    }),

    polymarketBook: tool({
      description: 'Read one Polymarket CLOB order book. Bids and asks are returned best-first.',
      inputSchema: z.object({
        assetId: z.string().min(1).describe('Outcome asset id from polymarket search.'),
      }),
      execute: async ({ assetId }) => client.book(assetId),
    }),

    polymarketQuote: tool({
      description: 'Quote one Polymarket outcome from the CLOB book: touch, mid, spread, and nearby depth.',
      inputSchema: z.object({
        assetId: z.string().min(1).describe('Outcome asset id from polymarket search.'),
        depthBand: z.number().nonnegative().optional().describe('Price distance from the touch counted as depth. Default 0.03.'),
      }),
      execute: async ({ assetId, depthBand }) => client.quote(assetId, depthBand),
    }),

    polymarketPlanOrder: tool({
      description: `Plan a Polymarket CLOB order against the live book.

Checks tick size, minimum size, post-only crossing, and FOK/FAK depth. Returns
maker and taker amounts in 6-decimal base units. submit defaults to false.
A submit is refused unless POLYMARKET_AUTO_TRADE or agent.polymarketAutoTrade
is on and CLOB credentials are already configured. Do not invent credentials.`,
      inputSchema: z.object({
        assetId: z.string().min(1).describe('Outcome asset id to trade.'),
        ...orderFields,
        submit: z.boolean().optional().describe('Ask to submit. Refused unless auto trading is enabled. Default false.'),
      }),
      execute: async (input) => client.plan(input),
    }),

    polymarketAuto: tool({
      description: `Select the best liquid Polymarket market, plan an order, and submit it.

Search, liquidity filter, quote, and the order planner run in one step. The
order is posted only when auto trading is enabled. When POLYMARKET_AUTO_TRADE
and agent.polymarketAutoTrade are off, or credentials are missing, the plan is
returned and nothing is POSTed. This does not use Trading-as-Git approval.`,
      inputSchema: z.object({
        ...discoverFields,
        outcome: z.string().optional().describe('Outcome name, such as Yes. Defaults to the first outcome.'),
        maxSpread: z.number().positive().optional().describe('Maximum best-ask minus best-bid. Default 0.05.'),
        minDepthUsd: z.number().nonnegative().optional().describe('Minimum two-sided USDC depth near the touch. Default 100.'),
        depthBand: z.number().nonnegative().optional().describe('Price distance from the touch counted as near. Default 0.03.'),
        ...orderFields,
      }),
      execute: async (input) => client.auto(input),
    }),
  }
}
