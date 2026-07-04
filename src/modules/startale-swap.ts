import { formatEther, formatUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import { TOKENS, CONTRACTS } from '../contracts.js'
import { fetchBonusDappProgress } from '../bonus-quest-progress.js'
import axios from 'axios'

/**
 * Startale бонусный квест S12 — задание «Swap 5$»:
 * "Complete swap for a minimum of 5 USDSC."
 * dappId портала: startale_12 (квест swap — индекс 2).
 *
 * Воспроизводит свап из образцовой транзакции
 * https://soneium.blockscout.com/tx/0xc04eaa99b0d2b1241c096753930db6cc0218ab0ba8b8185dbd7352ee2cb2fecb
 * ETH → USDSC через DEX-агрегатор Kyo (Router.swap, selector 0xa5d4096b).
 *
 * Kyo API (публичный, авторизация не обязательна) отдаёт готовую транзакцию:
 *   POST https://api.kyo.ag/1868/v1/swap { tokenIn, tokenOut, amountIn, userAddress, slippage }
 * Сумма свапа — случайная, эквивалент $5–6 в ETH (цена ETH берётся из /v1/quote).
 */

const KYO_API_BASE = 'https://api.kyo.ag/1868/v1'
const ETH_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' // нативный ETH в Kyo API
const USDSC_ADDRESS = TOKENS.USDSC
const EXPECTED_ROUTER = getAddress(CONTRACTS.kyoAggregatorRouter)
const USDSC_DECIMALS = 6

const SLIPPAGE = 0.01 // 1%
// Целевой диапазон свапа в долларах. Нижняя граница 5.1 (а не 5.0) — буфер, чтобы
// выход в USDSC гарантированно был ≥ 5 (требование квеста) даже после price impact.
const TARGET_USD_MIN = 5.1
const TARGET_USD_MAX = 6.0
const MIN_QUEST_OUTPUT = 5_000_000n // 5 USDSC (6 знаков) — минимум для зачёта квеста
const REFERENCE_ETH_WEI = 10_000_000_000_000_000n // 0.01 ETH — опорная сумма для котировки цены

const API_TIMEOUT_MS = 20000
const MAX_API_ATTEMPTS = 5
const BONUS_DAPP_ID = 'startale_12'
const MODULE_LABEL = 'Startale Swap'

const proxyManager = ProxyManager.getInstance()
const publicClient = rpcManager.createPublicClient(soneiumChain)

interface KyoQuote {
  amountIn: string
  amountOut: string
  minOutputAmount: string
}

interface KyoSwapTx {
  to: string
  value: string
  input: string
  gas?: string
}

interface KyoSwapResponse {
  toAddress: string
  quote: KyoQuote
  transactions: KyoSwapTx[]
}

/** Создаёт axios-инстанс: через прокси, если он есть, иначе прямой запрос. */
function createKyoAxios (): import('axios').AxiosInstance {
  const proxy = proxyManager.getRandomProxyFast()
  const base = {
    timeout: API_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  }
  if (!proxy) return axios.create(base)
  const proxyAgents = proxyManager.createProxyAgents(proxy)
  return axios.create({ ...base, httpsAgent: proxyAgents.httpsAgent, httpAgent: proxyAgents.httpAgent })
}

/** Повторяет запрос к Kyo API с ротацией прокси. */
async function kyoRequestWithRetry<T> (path: string, body: Record<string, unknown>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
    try {
      const client = createKyoAxios()
      const response = await client.post(`${KYO_API_BASE}${path}`, body)
      return response.data as T
    } catch (error) {
      lastError = error
      logger.warn(`${MODULE_LABEL}: Kyo API ${path} попытка ${attempt}/${MAX_API_ATTEMPTS} неудачна: ${error instanceof Error ? error.message : String(error)}`)
      if (attempt < MAX_API_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
  throw new Error(`Kyo API ${path} недоступен после ${MAX_API_ATTEMPTS} попыток: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Вычисляет сумму ETH (в wei) для свапа на случайные $5–6.
 * Цена ETH берётся из опорной котировки 0.01 ETH → USDSC.
 */
async function computeSwapAmountWei (): Promise<{ amountInWei: bigint, targetUsd: number }> {
  const quote = await kyoRequestWithRetry<KyoQuote>('/quote', {
    tokenIn: ETH_PLACEHOLDER,
    tokenOut: USDSC_ADDRESS,
    amountIn: REFERENCE_ETH_WEI.toString()
  })
  const refOut = BigInt(quote.amountOut) // USDSC (6 знаков) за REFERENCE_ETH_WEI
  if (refOut <= 0n) throw new Error('Kyo котировка вернула нулевой выход')

  const targetUsd = TARGET_USD_MIN + Math.random() * (TARGET_USD_MAX - TARGET_USD_MIN)
  const targetUsdc6 = BigInt(Math.round(targetUsd * 10 ** USDSC_DECIMALS))
  // amountInWei такой, чтобы выход ≈ targetUsdc6 USDSC: amountIn = target * refWei / refOut
  const amountInWei = (targetUsdc6 * REFERENCE_ETH_WEI) / refOut
  return { amountInWei, targetUsd }
}

/**
 * Проверяет на портале Soneium, что swap-квест Startale засчитан.
 * Не блокирует результат: свап уже прошёл on-chain, портал может обновляться с задержкой.
 */
async function verifyQuestCredited (address: string): Promise<boolean> {
  const quests = await fetchBonusDappProgress(address, BONUS_DAPP_ID, MODULE_LABEL)
  if (!quests) return false
  // Swap — третий квест dapp (индекс 2); подстрахуемся, если структура изменится.
  const swapQuest = quests[2] ?? quests[quests.length - 1]
  return swapQuest?.isDone === true
}

export async function performStartaleSwap (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  swapAmount?: string
  targetToken?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  const account = privateKeyToAccount(privateKey)

  try {
    // Квест уже засчитан → пропускаем, не тратим газ
    if (await verifyQuestCredited(account.address)) {
      logger.warn(`${MODULE_LABEL}: swap-квест уже выполнен — пропуск`)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        reason: 'Swap-квест уже выполнен',
        message: 'Swap-квест уже выполнен'
      }
    }

    const { amountInWei, targetUsd } = await computeSwapAmountWei()
    const amountInEth = formatEther(amountInWei)

    // Баланс должен покрыть сумму свапа + газ
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance <= amountInWei) {
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточно ETH: баланс ${formatEther(balance)}, нужно > ${amountInEth} + газ`
      }
    }

    // Готовая транзакция свапа от Kyo API
    const swap = await kyoRequestWithRetry<KyoSwapResponse>('/swap', {
      tokenIn: ETH_PLACEHOLDER,
      tokenOut: USDSC_ADDRESS,
      amountIn: amountInWei.toString(),
      userAddress: account.address,
      slippage: SLIPPAGE
    })

    const tx = swap.transactions?.[swap.transactions.length - 1]
    if (!tx?.input || !tx.to) {
      throw new Error('Kyo API не вернул данные транзакции свапа')
    }

    // Guard: роутер должен совпадать с ожидаемым (образцовая транзакция)
    const router = getAddress(tx.to)
    if (router !== EXPECTED_ROUTER) {
      throw new Error(`Неожиданный роутер от Kyo API: ${router} (ожидался ${EXPECTED_ROUTER})`)
    }

    // Guard: выход должен быть ≥ 5 USDSC, иначе квест не засчитается
    const expectedOut = BigInt(swap.quote.amountOut)
    if (expectedOut < MIN_QUEST_OUTPUT) {
      throw new Error(`Ожидаемый выход ${formatUnits(expectedOut, USDSC_DECIMALS)} USDSC < 5 (квест не засчитается)`)
    }

    // Нативный ETH-свап без approve: одна транзакция, value из ответа API
    const value = tx.value ? BigInt(tx.value) : amountInWei
    const calldata = tx.input as `0x${string}`

    let gas: bigint | undefined = tx.gas ? BigInt(tx.gas) : undefined
    if (!gas) {
      try {
        gas = await publicClient.estimateGas({ account, to: router, data: calldata, value })
      } catch {
        gas = 700000n
      }
    }

    logger.info(`${MODULE_LABEL}: свап ${amountInEth} ETH (~$${targetUsd.toFixed(2)}) → ${formatUnits(expectedOut, USDSC_DECIMALS)} USDSC`)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const txResult = await safeSendTransaction(
      publicClient,
      walletClient,
      account.address,
      {
        to: router,
        data: calldata,
        value,
        gas: (gas * 120n) / 100n
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции свапа'
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'STARTALE_SWAP')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success') {
      logger.transaction(hash, 'failed', 'STARTALE_SWAP', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Транзакция свапа откатилась (revert)'
      }
    }

    logger.success(`${MODULE_LABEL}: свап выполнен`)
    logger.transaction(hash, 'confirmed', 'STARTALE_SWAP', account.address)

    // Проверяем зачёт квеста на портале (несколько попыток, не блокируем результат)
    let credited = false
    for (let i = 0; i < 3 && !credited; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      credited = await verifyQuestCredited(account.address)
    }
    if (credited) {
      logger.success(`${MODULE_LABEL}: квест засчитан на портале`)
    } else {
      logger.info(`${MODULE_LABEL}: свап прошёл, но портал ещё не отметил квест (обновится позже)`)
    }

    return {
      success: true,
      walletAddress: account.address,
      transactionHash: hash,
      swapAmount: amountInEth,
      targetToken: 'USDSC',
      message: credited ? 'Свап выполнен, квест засчитан' : 'Свап выполнен, ожидается обновление портала'
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка ${MODULE_LABEL}`, errorMessage)
    return { success: false, walletAddress: account.address, error: errorMessage, message: errorMessage }
  }
}
