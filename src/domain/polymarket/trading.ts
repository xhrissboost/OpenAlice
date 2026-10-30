/**
 * Polymarket auto trading is off unless the operator turns it on.
 * Credentials are read from the environment and never invented.
 */

export const POLYMARKET_AUTO_TRADE_ENV = 'POLYMARKET_AUTO_TRADE'

const CREDENTIAL_ENV = {
  privateKey: 'POLYMARKET_PRIVATE_KEY',
  apiKey: 'POLYMARKET_API_KEY',
  apiSecret: 'POLYMARKET_API_SECRET',
  apiPassphrase: 'POLYMARKET_API_PASSPHRASE',
} as const

const FUNDER_ENV = 'POLYMARKET_FUNDER'
const SIGNATURE_TYPE_ENV = 'POLYMARKET_SIGNATURE_TYPE'

export type PolymarketSignatureType = 0 | 1 | 2 | 3

export interface PolymarketCredentials {
  privateKey: string
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  funder?: string
  signatureType: PolymarketSignatureType
}

export type PolymarketTradingMode =
  | { enabled: false; reason: 'disabled' }
  | { enabled: false; reason: 'missing-credentials'; missing: string[] }
  | { enabled: true; credentials: PolymarketCredentials }

export interface ResolvePolymarketTradingInput {
  /** `agent.polymarketAutoTrade` from OpenAlice config. */
  autoTrade?: boolean
  env?: Record<string, string | undefined>
}

function envTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function blank(value: string | undefined): boolean {
  return value == null || value.trim().length === 0
}

/**
 * Enabled when `POLYMARKET_AUTO_TRADE` is truthy or `agent.polymarketAutoTrade`
 * is true. Either flag is enough. Missing signing material fails closed.
 */
export function resolvePolymarketTrading(input: ResolvePolymarketTradingInput = {}): PolymarketTradingMode {
  const env = input.env ?? process.env
  const enabled = input.autoTrade === true || envTruthy(env[POLYMARKET_AUTO_TRADE_ENV])
  if (!enabled) return { enabled: false, reason: 'disabled' }

  const missing: string[] = []
  for (const name of Object.values(CREDENTIAL_ENV)) {
    if (blank(env[name])) missing.push(name)
  }
  const funder = env[FUNDER_ENV]?.trim()
  const signatureRaw = env[SIGNATURE_TYPE_ENV]?.trim() ?? ''
  let signatureType: PolymarketSignatureType = 0
  if (!signatureRaw) {
    if (funder) missing.push(SIGNATURE_TYPE_ENV)
  } else if (!['0', '1', '2', '3'].includes(signatureRaw)) {
    missing.push(SIGNATURE_TYPE_ENV)
  } else {
    signatureType = Number(signatureRaw) as PolymarketSignatureType
  }
  if (signatureType !== 0 && !funder) missing.push(FUNDER_ENV)
  if (signatureType === 0 && funder) missing.push(`${FUNDER_ENV} is only valid with ${SIGNATURE_TYPE_ENV} 1, 2, or 3`)
  if (missing.length) return { enabled: false, reason: 'missing-credentials', missing }

  return {
    enabled: true,
    credentials: {
      privateKey: env[CREDENTIAL_ENV.privateKey]!.trim(),
      apiKey: env[CREDENTIAL_ENV.apiKey]!.trim(),
      apiSecret: env[CREDENTIAL_ENV.apiSecret]!.trim(),
      apiPassphrase: env[CREDENTIAL_ENV.apiPassphrase]!.trim(),
      ...(funder ? { funder } : {}),
      signatureType,
    },
  }
}

export function polymarketRefusalReason(mode: PolymarketTradingMode | undefined): string {
  if (mode?.enabled === false && mode.reason === 'missing-credentials') {
    return `Polymarket auto trading is enabled but credentials are missing (${mode.missing.join(', ')}). The order was planned and was not sent to the CLOB.`
  }
  if (mode?.enabled === false && mode.reason === 'disabled') {
    return 'Polymarket auto trading is off. Set POLYMARKET_AUTO_TRADE=1 or agent.polymarketAutoTrade to place orders. The order was planned and was not sent to the CLOB.'
  }
  return 'No Polymarket submitter is configured. The order was planned and was not sent to the CLOB.'
}
