/**
 * Клиент Rabby API (api.rabby.io) — получение списка апрувов кошелька.
 *
 * Схема подписи запросов идентична DeBank (см. github.com/privatekey7/DeBankChecker),
 * но с префиксом "rabby-api" — проверено воспроизведением подписи из HAR-записи
 * веб-версии Rabby байт-в-байт:
 *   K    = sha256("rabby-api\n{nonce}\n{ts}")
 *   M    = sha256("{METHOD}\n{path}\n{query-параметры, отсортированные по ключу}")
 *   sign = HMAC-SHA256(key=K, msg=M)
 *
 * Транспорт — undici ProxyAgent + fetch (паттерн startale-gm): случайный прокси
 * из ProxyManager на каждую попытку, ретраи с ротацией, backoff на 429/5xx.
 */

import { createHash, createHmac } from 'node:crypto'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from './logger.js'
import { ProxyManager, type ProxyConfig } from './proxy-manager.js'

// ============================================================
// CONSTANTS
// ============================================================

const RABBY_API_BASE = 'https://api.rabby.io'

/** Начальный x-api-key из HAR веб-версии Rabby; сервер может ротировать через x-set-api-key. */
const RABBY_API_KEY_INIT = '7e59d142-6b67-4ba5-a81d-d2e206045679'

/** Версия клиента Rabby, под которую записан HAR. */
const RABBY_CLIENT_VERSION = '0.93.80'

const SIGN_PREFIX = 'rabby-api\n'

/** Алфавит nonce как в клиенте Rabby/DeBank (sic: без Y и j). */
const NONCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz'
const NONCE_LENGTH = 40

const HTTP_TIMEOUT_MS = 30_000
const HTTP_MAX_ATTEMPTS = 6

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
]

// ============================================================
// ПОДПИСЬ
// ============================================================

export interface RabbySignature {
  signature: string
  nonce: string
  ts: number
}

function sha256Hex (text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hmacSha256Hex (key: string, msg: string): string {
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex')
}

export function generateRabbyNonce (): string {
  let out = ''
  for (let i = 0; i < NONCE_LENGTH; i++) {
    out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)]
  }
  return `n_${out}`
}

function sortParams (params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/**
 * Подпись запроса к Rabby API. nonce/ts передаются явно только в тестах.
 */
export function signRabbyRequest (
  method: string,
  path: string,
  params: Record<string, string>,
  nonce?: string,
  ts?: number
): RabbySignature {
  const actualTs = ts ?? Math.floor(Date.now() / 1000)
  const actualNonce = nonce ?? generateRabbyNonce()
  const key = sha256Hex(`${SIGN_PREFIX}${actualNonce}\n${actualTs}`)
  const msg = sha256Hex(`${method.toUpperCase()}\n${path}\n${sortParams(params)}`)
  return {
    signature: hmacSha256Hex(key, msg),
    nonce: actualNonce,
    ts: actualTs
  }
}

// ============================================================
// HTTP
// ============================================================

/** Текущий x-api-key (сервер может выдать новый через x-set-api-key). */
let currentApiKey = RABBY_API_KEY_INIT

/** x-api-time — момент "инициализации клиента", одинаков для всех запросов процесса. */
const clientInitTs = Math.floor(Date.now() / 1000)

function pickRandomUserAgent (): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pickProxy (): ProxyConfig | null {
  const pm = ProxyManager.getInstance()
  if (!pm.hasProxies()) return null
  return pm.getRandomProxyFast()
}

function buildHeaders (method: string, path: string, params: Record<string, string>): Record<string, string> {
  const sign = signRabbyRequest(method, path, params)
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': pickRandomUserAgent(),
    'x-api-key': currentApiKey,
    'x-api-nonce': sign.nonce,
    'x-api-sign': sign.signature,
    'x-api-time': String(clientInitTs),
    'x-api-ts': String(sign.ts),
    'x-api-ver': 'v2',
    'x-client': 'Rabby',
    'x-version': RABBY_CLIENT_VERSION
  }
}

function backoffMs (status: number, attempt: number): number {
  if (status === 429) return Math.min(60_000, 5_000 * Math.pow(2, Math.min(attempt, 3)))
  return Math.min(15_000, 1_000 * Math.pow(2, attempt))
}

/**
 * GET к Rabby API с подписью, прокси-ротацией и ретраями.
 * Бросает Error, если все попытки исчерпаны.
 */
async function rabbyGet<T> (path: string, params: Record<string, string>): Promise<T> {
  let lastError = ''

  for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
    const proxy = pickProxy()
    const dispatcher = proxy
      ? new ProxyAgent({ uri: `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}` })
      : undefined

    const url = `${RABBY_API_BASE}${path}?${sortParams(params)}`
    const init: Parameters<typeof undiciFetch>[1] = {
      method: 'GET',
      headers: buildHeaders('GET', path, params),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    }
    if (dispatcher) init.dispatcher = dispatcher

    let resp: Awaited<ReturnType<typeof undiciFetch>>
    try {
      resp = await undiciFetch(url, init)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (proxy) ProxyManager.getInstance().markProxyAsUnhealthy(proxy)
      logger.debug(`rabby-api: сетевая ошибка ${path} (попытка ${attempt + 1}/${HTTP_MAX_ATTEMPTS}): ${lastError}`)
      if (attempt < HTTP_MAX_ATTEMPTS - 1) await sleep(backoffMs(0, attempt))
      continue
    }

    const newKey = resp.headers.get('x-set-api-key')
    if (newKey) currentApiKey = newKey

    if (resp.ok) {
      return await resp.json() as T
    }

    lastError = `HTTP ${resp.status}`
    logger.debug(`rabby-api: ${lastError} ${path} (попытка ${attempt + 1}/${HTTP_MAX_ATTEMPTS})`)
    if (attempt < HTTP_MAX_ATTEMPTS - 1) await sleep(backoffMs(resp.status, attempt))
  }

  throw new Error(`Rabby API недоступен (${path}): ${lastError}`)
}

// ============================================================
// ЭНДПОИНТЫ
// ============================================================

const RABBY_CHAIN_ID = 'soneium'

export interface RabbyTokenSpender {
  id: string
  /** Allowance как float (unlimited ≈ 1.16e71); точное значение читаем он-чейн. */
  value: number | null
}

export interface RabbyAuthorizedToken {
  id: string
  symbol: string | null
  optimized_symbol: string | null
  decimals: number | null
  spenders: RabbyTokenSpender[] | null
}

export interface RabbyNftContractApproval {
  contract_id: string
  contract_name: string | null
  is_erc1155: boolean | null
  spender: { id: string } | null
}

export interface RabbyNftAuthorizedList {
  /** Одиночные ERC-721 approve по token id — схема неизвестна (в HAR пусто). */
  tokens: unknown[]
  contracts: RabbyNftContractApproval[]
}

/** Все ERC-20 апрувы кошелька в Soneium. */
export async function getTokenAuthorizedList (address: string): Promise<RabbyAuthorizedToken[]> {
  const data = await rabbyGet<unknown>('/v2/user/token_authorized_list', {
    id: address.toLowerCase(),
    chain_id: RABBY_CHAIN_ID
  })
  if (!Array.isArray(data)) {
    throw new Error('Rabby API: неожиданный формат ответа token_authorized_list')
  }
  return data as RabbyAuthorizedToken[]
}

/** Все NFT-апрувы (setApprovalForAll) кошелька в Soneium. */
export async function getNftAuthorizedList (address: string): Promise<RabbyNftAuthorizedList> {
  const data = await rabbyGet<unknown>('/v1/user/nft_authorized_list', {
    id: address.toLowerCase(),
    chain_id: RABBY_CHAIN_ID
  })
  if (typeof data !== 'object' || data === null) {
    throw new Error('Rabby API: неожиданный формат ответа nft_authorized_list')
  }
  const obj = data as Partial<RabbyNftAuthorizedList>
  return {
    tokens: Array.isArray(obj.tokens) ? obj.tokens : [],
    contracts: Array.isArray(obj.contracts) ? obj.contracts : []
  }
}
