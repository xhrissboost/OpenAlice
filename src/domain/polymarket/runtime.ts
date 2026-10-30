import { createPolymarketClient, type PolymarketClient, type PolymarketClientOptions } from './client.js'
import { createPolymarketSubmitter } from './submit.js'
import { resolvePolymarketTrading, type PolymarketTradingMode } from './trading.js'

export interface PolymarketRuntimeOptions {
  /** `agent.polymarketAutoTrade`. Combined with `POLYMARKET_AUTO_TRADE`. */
  autoTrade?: boolean
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  clobUrl?: string
  gammaUrl?: string
  transport?: PolymarketClientOptions['transport']
}

/**
 * Default client. Auto trading stays off until the flag is set and
 * credentials are present. A bad key refuses orders instead of crashing boot.
 */
export function createPolymarketRuntime(options: PolymarketRuntimeOptions = {}): {
  client: PolymarketClient
  mode: PolymarketTradingMode
} {
  const resolved = resolvePolymarketTrading({ autoTrade: options.autoTrade, env: options.env })
  const shared = {
    ...(options.gammaUrl ? { gammaUrl: options.gammaUrl } : {}),
    ...(options.clobUrl ? { clobUrl: options.clobUrl } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  }
  if (!resolved.enabled) {
    return { mode: resolved, client: createPolymarketClient({ ...shared, trading: resolved }) }
  }
  try {
    const submitter = createPolymarketSubmitter({
      credentials: resolved.credentials,
      ...(options.clobUrl ? { clobUrl: options.clobUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    return {
      mode: resolved,
      client: createPolymarketClient({ ...shared, submitter, trading: resolved }),
    }
  } catch (err) {
    const mode: PolymarketTradingMode = {
      enabled: false,
      reason: 'missing-credentials',
      missing: [err instanceof Error ? err.message : 'invalid Polymarket credentials'],
    }
    return { mode, client: createPolymarketClient({ ...shared, trading: mode }) }
  }
}
