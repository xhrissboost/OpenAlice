/**
 * Signs a planned Polymarket order and POSTs it to the CLOB.
 * The caller must already have decided auto trading is enabled.
 */

import { createHmac } from 'node:crypto'
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { POLYMARKET_CLOB_URL, PolymarketError, type PolymarketSubmitAck, type PolymarketSubmitBody, type PolymarketSubmitter } from './client.js'
import type { PolymarketCredentials } from './trading.js'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
const EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B'
const NEG_RISK_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59'
const DOMAIN_NAME = 'Polymarket CTF Exchange'
const DOMAIN_VERSION = '2'
const CHAIN_ID = 137

const ORDER_TYPE_STRING =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)'

const ORDER_TYPES = {
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
} as const

const TYPED_DATA_SIGN_TYPES = {
  TypedDataSign: [
    { name: 'contents', type: 'Order' },
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  Order: ORDER_TYPES.Order,
} as const

export interface PolymarketSubmitterOptions {
  credentials: PolymarketCredentials
  clobUrl?: string
  fetchImpl?: typeof fetch
  nowMs?: () => number
  salt?: () => string
}

interface SignedFields {
  salt: bigint
  maker: Address
  signer: Address
  tokenId: bigint
  makerAmount: bigint
  takerAmount: bigint
  side: 0 | 1
  signatureType: 0 | 1 | 2 | 3
  timestamp: bigint
  metadata: Hex
  builder: Hex
}

function privateKey(value: string): Hex {
  const trimmed = value.trim()
  const hex = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new PolymarketError('POLYMARKET_PRIVATE_KEY is not a 32-byte hex private key')
  }
  return hex
}

function hmacSignature(secret: string, timestamp: number, body: string): string {
  const normalized = secret.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const key = Buffer.from(padded, 'base64')
  return createHmac('sha256', key).update(`${timestamp}POST/order${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

function exchangeFor(negRisk: boolean): Address {
  return getAddress(negRisk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2)
}

function domainSeparator(exchange: Address): Hex {
  const domainType = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [domainType, keccak256(toHex(DOMAIN_NAME)), keccak256(toHex(DOMAIN_VERSION)), BigInt(CHAIN_ID), exchange],
  ))
}

async function signOrder(account: ReturnType<typeof privateKeyToAccount>, fields: SignedFields, exchange: Address): Promise<Hex> {
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: exchange,
  }
  if (fields.signatureType !== 3) {
    return account.signTypedData({
      domain,
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: fields,
    })
  }
  const orderTypeHash = keccak256(toHex(ORDER_TYPE_STRING))
  const contentsHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' },
      { type: 'uint8' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
    ],
    [
      orderTypeHash, fields.salt, fields.maker, fields.signer, fields.tokenId,
      fields.makerAmount, fields.takerAmount, fields.side, fields.signatureType,
      fields.timestamp, fields.metadata, fields.builder,
    ],
  ))
  const inner = await account.signTypedData({
    domain,
    types: TYPED_DATA_SIGN_TYPES,
    primaryType: 'TypedDataSign',
    message: {
      contents: fields,
      name: 'DepositWallet',
      version: '1',
      chainId: BigInt(CHAIN_ID),
      verifyingContract: fields.signer,
      salt: ZERO_BYTES32,
    },
  })
  const lenHex = ORDER_TYPE_STRING.length.toString(16).padStart(4, '0')
  return `0x${inner.slice(2)}${domainSeparator(exchange).slice(2)}${contentsHash.slice(2)}${toHex(ORDER_TYPE_STRING).slice(2)}${lenHex}`
}

export function createPolymarketSubmitter(options: PolymarketSubmitterOptions): PolymarketSubmitter {
  const account = privateKeyToAccount(privateKey(options.credentials.privateKey))
  const clobUrl = (options.clobUrl ?? POLYMARKET_CLOB_URL).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const signatureType = options.credentials.signatureType
  const signer = getAddress(account.address)
  const maker = options.credentials.funder ? getAddress(options.credentials.funder) : signer
  if (signatureType === 3 && maker === signer) {
    throw new PolymarketError('POLYMARKET_FUNDER must be the deposit wallet when POLYMARKET_SIGNATURE_TYPE is 3')
  }

  return {
    async submit(body: PolymarketSubmitBody): Promise<PolymarketSubmitAck> {
      const nowMs = options.nowMs?.() ?? Date.now()
      const salt = BigInt(options.salt?.() ?? `${Math.round(Math.random() * nowMs)}`)
      let tokenId: bigint
      try {
        tokenId = BigInt(body.order.tokenId)
      } catch {
        throw new PolymarketError('Polymarket token id is not an integer')
      }
      const fields: SignedFields = {
        salt,
        maker,
        signer: signatureType === 3 ? maker : signer,
        tokenId,
        makerAmount: BigInt(body.order.makerAmount),
        takerAmount: BigInt(body.order.takerAmount),
        side: body.order.side === 'BUY' ? 0 : 1,
        signatureType,
        timestamp: BigInt(nowMs),
        metadata: ZERO_BYTES32,
        builder: ZERO_BYTES32,
      }
      const exchange = exchangeFor(body.order.negRisk === true)
      const signature = await signOrder(account, fields, exchange)
      const payload = {
        deferExec: false as const,
        postOnly: body.postOnly,
        order: {
          salt: Number(salt),
          maker: fields.maker,
          signer: fields.signer,
          tokenId: body.order.tokenId,
          makerAmount: body.order.makerAmount,
          takerAmount: body.order.takerAmount,
          side: body.order.side,
          signatureType,
          timestamp: String(nowMs),
          expiration: body.order.expiration,
          metadata: ZERO_BYTES32,
          builder: ZERO_BYTES32,
          signature,
        },
        owner: options.credentials.apiKey,
        orderType: body.orderType,
      }
      const serialized = JSON.stringify(payload)
      const timestamp = Math.floor(nowMs / 1000)
      let response: Response
      try {
        response = await fetchImpl(`${clobUrl}/order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            POLY_ADDRESS: signer,
            POLY_SIGNATURE: hmacSignature(options.credentials.apiSecret, timestamp, serialized),
            POLY_TIMESTAMP: String(timestamp),
            POLY_API_KEY: options.credentials.apiKey,
            POLY_PASSPHRASE: options.credentials.apiPassphrase,
          },
          body: serialized,
        })
      } catch (err) {
        throw new PolymarketError(`Polymarket order post failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      const text = await response.text()
      let parsed: Record<string, unknown> = {}
      try {
        const value: unknown = text ? JSON.parse(text) : {}
        if (value && typeof value === 'object') parsed = value as Record<string, unknown>
      } catch {
        parsed = {}
      }
      const success = response.ok && parsed['success'] !== false && parsed['errorMsg'] == null && parsed['error'] == null
      const errorMsg = typeof parsed['errorMsg'] === 'string'
        ? parsed['errorMsg']
        : (typeof parsed['error'] === 'string' ? parsed['error'] : (response.ok ? undefined : `Polymarket ${response.status}`))
      return {
        success,
        ...(typeof parsed['orderID'] === 'string' ? { orderID: parsed['orderID'] } : {}),
        ...(typeof parsed['status'] === 'string' ? { status: parsed['status'] } : {}),
        ...(errorMsg ? { errorMsg } : {}),
      }
    },
  }
}
