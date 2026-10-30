import { describe, expect, it, vi } from 'vitest'
import { createPolymarketTools } from './polymarket.js'
import type { PolymarketClient } from '@/domain/polymarket/client.js'

function run(tool: { execute?: unknown }, args: unknown): Promise<unknown> {
  return (tool.execute as (args: unknown, options: unknown) => Promise<unknown>)(args, {})
}

describe('polymarket tools', () => {
  it('plans through the client and does not describe a live default submission', async () => {
    const plan = vi.fn(async () => ({ status: 'planned', submitted: false, submission: 'not-requested' }))
    const client = { plan } as unknown as PolymarketClient
    const tools = createPolymarketTools(client)
    expect(tools.polymarketPlanOrder.description).toMatch(/does not POST/)
    const result = await run(tools.polymarketPlanOrder, {
      assetId: 'yes-token',
      side: 'BUY',
      size: 10,
      price: 0.44,
    })
    expect(result).toMatchObject({ submitted: false, submission: 'not-requested' })
    expect(plan).toHaveBeenCalledOnce()
    const calls = plan.mock.calls as unknown as Array<[{ submit?: boolean }]>
    expect(calls[0]?.[0].submit).toBeUndefined()
  })
})
