import { describe, expect, it } from 'vitest'
import { recoverTypedDataAddress } from 'viem'
import { createPolymarketSubmitter } from './submit.js'
import { resolvePolymarketTrading } from './trading.js'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const CREDS = {
  POLYMARKET_PRIVATE_KEY: KEY,
  POLYMARKET_API_KEY: 'key-1',
  POLYMARKET_API_SECRET: 'dGVzdC1zZWNyZXQ=',
  POLYMARKET_API_PASSPHRASE: 'pass-1',
}

describe('resolvePolymarketTrading', () => {
  it('stays disabled when the flag is off, even if credentials are present', () => {
    expect(resolvePolymarketTrading({ autoTrade: false, env: CREDS })).toEqual({ enabled: false, reason: 'disabled' })
    expect(resolvePolymarketTrading({ env: { ...CREDS, POLYMARKET_AUTO_TRADE: '0' } }).enabled).toBe(false)
  })

  it('enables from the env flag or the config flag and lists missing credentials', () => {
    expect(resolvePolymarketTrading({ autoTrade: true, env: {} })).toMatchObject({
      enabled: false,
      reason: 'missing-credentials',
    })
    const fromEnv = resolvePolymarketTrading({ env: { ...CREDS, POLYMARKET_AUTO_TRADE: '1' } })
    const fromConfig = resolvePolymarketTrading({ autoTrade: true, env: CREDS })
    expect(fromEnv.enabled && fromConfig.enabled).toBe(true)
    if (fromEnv.enabled && fromConfig.enabled) {
      expect(fromEnv.credentials.signatureType).toBe(0)
      expect(fromConfig.credentials.apiKey).toBe('key-1')
    }
  })

  it('requires a signature type when a funder is set', () => {
    const mode = resolvePolymarketTrading({
      autoTrade: true,
      env: { ...CREDS, POLYMARKET_FUNDER: '0x0000000000000000000000000000000000000001' },
    })
    expect(mode).toMatchObject({ enabled: false, reason: 'missing-credentials' })
  })
})

describe('createPolymarketSubmitter', () => {
  it('signs an EOA order and posts it once', async () => {
    let captured = ''
    let header = ''
    const submitter = createPolymarketSubmitter({
      credentials: {
        privateKey: KEY,
        apiKey: 'key-1',
        apiSecret: 'dGVzdC1zZWNyZXQ=',
        apiPassphrase: 'pass-1',
        signatureType: 0,
      },
      nowMs: () => 1_700_000_000_000,
      salt: () => '123456789',
      fetchImpl: async (_url, init) => {
        captured = String(init?.body)
        header = String(new Headers(init?.headers).get('POLY_API_KEY'))
        return new Response(JSON.stringify({ success: true, orderID: 'ord-1', status: 'live' }), { status: 200 })
      },
    })
    const ack = await submitter.submit({
      deferExec: false,
      orderType: 'GTC',
      postOnly: false,
      order: {
        tokenId: '12345',
        side: 'BUY',
        price: 0.44,
        size: 10,
        makerAmount: '4400000',
        takerAmount: '10000000',
        expiration: '0',
        negRisk: false,
      },
    })
    expect(ack).toMatchObject({ success: true, orderID: 'ord-1' })
    expect(header).toBe('key-1')
    const body = JSON.parse(captured) as {
      order: { signature: `0x${string}`; maker: `0x${string}`; salt: number; signatureType: number }
    }
    expect(body.order.salt).toBe(123456789)
    expect(body.order.signatureType).toBe(0)
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Polymarket CTF Exchange',
        version: '2',
        chainId: 137,
        verifyingContract: '0xE111180000d2663C0091e4f400237545B87B996B',
      },
      types: {
        Order: [
          { name: 'salt', type: 'uint256' },
          { name: 'maker', type: 'address' },
          { name: 'signer', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'makerAmount', type: 'uint256' },
          { name: 'takerAmount', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'signatureType', type: 'uint8' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'metadata', type: 'bytes32' },
          { name: 'builder', type: 'bytes32' },
        ],
      },
      primaryType: 'Order',
      message: {
        salt: 123456789n,
        maker: body.order.maker,
        signer: body.order.maker,
        tokenId: 12345n,
        makerAmount: 4400000n,
        takerAmount: 10000000n,
        side: 0,
        signatureType: 0,
        timestamp: 1_700_000_000_000n,
        metadata: `0x${'00'.repeat(32)}`,
        builder: `0x${'00'.repeat(32)}`,
      },
      signature: body.order.signature,
    })
    expect(recovered.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  })
})
