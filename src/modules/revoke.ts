import { formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { TOKENS, SPENDERS } from '../contracts.js'

// Адреса токенов и спендеров берутся из единого реестра ../contracts.ts

// Маппинг имен спендеров для удобного отображения
const SPENDER_NAMES: Record<string, string> = {
  [SPENDERS.AAVE_L2_POOL]: 'Aave L2Pool',
  [SPENDERS.MORPHO_METAMORPHO]: 'Morpho MetaMorpho',
  [SPENDERS.STARGATE_POOL]: 'Stargate Pool',
  [SPENDERS.UNTITLED_BANK]: 'Untitled Bank',
  [SPENDERS.SONUS]: 'Sonus',
  [SPENDERS.WHEELX]: 'WheelX',
  [SPENDERS.RELAY]: 'Relay',
  [SPENDERS.LI_FI]: 'LI.FI',
  [SPENDERS.SAKE]: 'Sake',
  [SPENDERS.UNISWAP_V3]: 'Uniswap V3'
}

// Маппинг имен токенов
const TOKEN_NAMES: Record<string, string> = {
  [TOKENS.USDT]: 'USDT',
  [TOKENS.USDC_e]: 'USDC.e'
}

// ERC20 ABI для работы с токенами
const ERC20_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' },
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' }
    ],
    'name': 'allowance',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' }
    ],
    'name': 'approve',
    'outputs': [{ 'internalType': 'bool', 'name': '', 'type': 'bool' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'symbol',
    'outputs': [{ 'internalType': 'string', 'name': '', 'type': 'string' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Интерфейс для информации об апруве
interface ApprovalInfo {
  token: string
  tokenSymbol: string
  spender: string
  spenderName: string
  allowance: bigint
  allowanceFormatted: string
}

// Результат отзыва одного апрува
interface RevokeResult {
  success: boolean
  transactionHash?: string
  skipped?: boolean
  error?: string
}

/**
 * Находит все активные апрувы для указанного кошелька
 */
async function findAllApprovals (
  publicClient: ReturnType<typeof rpcManager.createPublicClient>,
  walletAddress: `0x${string}`
): Promise<ApprovalInfo[]> {
  const approvals: ApprovalInfo[] = []
  const tokenAddresses = Object.values(TOKENS)
  const spenderAddresses = Object.values(SPENDERS)

  // Проверяем все комбинации токенов и спендеров
  for (const tokenAddress of tokenAddresses) {
    try {
      // Получаем decimals и symbol токена
      let tokenDecimals = 18
      let tokenSymbol = TOKEN_NAMES[tokenAddress] || 'UNKNOWN'

      try {
        const decimals = await publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals'
        }) as number

        tokenDecimals = decimals

        const symbol = await publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'symbol'
        }) as string

        if (symbol) {
          tokenSymbol = symbol
        }
      } catch (err) {
        // Используем значения по умолчанию
        logger.debug(`revoke: не удалось получить данные токена, используем значения по умолчанию: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Проверяем allowance для каждого спендера
      for (const spenderAddress of spenderAddresses) {
        try {
          const allowance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [walletAddress, spenderAddress as `0x${string}`]
          }) as bigint

          // Если allowance > 0, добавляем в список
          if (allowance > 0n) {
            const allowanceFormatted = formatUnits(allowance, tokenDecimals)
            const spenderName = SPENDER_NAMES[spenderAddress] || spenderAddress.slice(0, 8) + '...'

            approvals.push({
              token: tokenAddress,
              tokenSymbol,
              spender: spenderAddress,
              spenderName,
              allowance,
              allowanceFormatted
            })
          }
        } catch (err) {
          // Пропускаем ошибки при проверке конкретного спендера
          logger.debug(`revoke: ошибка при проверке спендера, пропускаем: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      // Пропускаем ошибки при работе с токеном
      logger.debug(`revoke: ошибка при работе с токеном, пропускаем: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return approvals
}

/**
 * Отзывает один апрув (устанавливает approve в 0)
 */
async function revokeApproval (
  publicClient: ReturnType<typeof rpcManager.createPublicClient>,
  walletClient: ReturnType<typeof rpcManager.createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  token: string,
  spender: string,
  tokenSymbol: string,
  spenderName: string
): Promise<RevokeResult> {
  try {
    // Проверяем текущий allowance
    const currentAllowance = await publicClient.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, spender as `0x${string}`]
    }) as bigint

    // Если allowance уже 0, пропускаем
    if (currentAllowance === 0n) {
      return {
        success: true,
        skipped: true
      }
    }

    // Оцениваем газ
    const estimatedGas = await publicClient.estimateContractGas({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, 0n],
      account: account
    })

    const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

    // Отправляем транзакцию через safeWriteContract
    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender as `0x${string}`, 0n],
        gas: gasLimit,
        chain: soneiumChain,
        account: account
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash

    // Ждем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'REVOKE', account.address)

      return {
        success: true,
        transactionHash: hash
      }
    } else {
      logger.transaction(hash, 'failed', 'REVOKE', account.address)
      return {
        success: false,
        error: 'Транзакция не подтверждена'
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка при отзыве апрува ${tokenSymbol} → ${spenderName}: ${errorMessage}`)
    return {
      success: false,
      error: errorMessage
    }
  }
}

/**
 * Основная функция модуля - отзыв всех апрувов для кошелька
 */
export async function performRevoke (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  revokedCount?: number
  totalCount?: number
  skippedCount?: number
}> {
  try {
    logger.moduleStart('REVOKE APPROVALS')

    const account = privateKeyToAccount(privateKey)
    const walletAddress = account.address

    // Создаем клиенты
    const publicClient = rpcManager.createPublicClient(soneiumChain)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Проверяем баланс ETH
    const balance = await publicClient.getBalance({ address: walletAddress })
    const balanceETH = Number(balance) / 1e18

    const MIN_BALANCE = 0.00001 // Минимальный баланс для газа
    if (balanceETH < MIN_BALANCE) {
      const error = `Недостаточно средств для отзыва апрувов. Требуется минимум ${MIN_BALANCE} ETH`
      logger.error(error)
      return {
        success: false,
        walletAddress,
        error
      }
    }

    // Находим все активные апрувы
    const approvals = await findAllApprovals(publicClient, walletAddress)

    if (approvals.length === 0) {
      logger.success('Активных апрувов не найдено')
      return {
        success: true,
        walletAddress,
        explorerUrl: null,
        revokedCount: 0,
        totalCount: 0,
        skippedCount: 0
      }
    }

    // Отзываем каждый апрув
    let revokedCount = 0
    let skippedCount = 0
    let errorCount = 0
    let lastTransactionHash: string | undefined

    for (let i = 0; i < approvals.length; i++) {
      const approval = approvals[i]!

      const result = await revokeApproval(
        publicClient,
        walletClient,
        account,
        approval.token,
        approval.spender,
        approval.tokenSymbol,
        approval.spenderName
      )

      if (result.success) {
        if (result.skipped) {
          skippedCount++
        } else {
          revokedCount++
          if (result.transactionHash) {
            lastTransactionHash = result.transactionHash
          }
        }
      } else {
        errorCount++
        logger.error(`Ошибка отзыва апрува: ${approval.tokenSymbol} → ${approval.spenderName} - ${result.error}`)
      }

      // Задержка между транзакциями (кроме последней)
      if (i < approvals.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000)) // 2 секунды
      }
    }

    // Формируем explorer URL для последней транзакции
    let explorerUrl: string | null = null
    if (lastTransactionHash) {
      explorerUrl = `https://soneium.blockscout.com/tx/${lastTransactionHash}`
    }

    logger.info(`Отозвано: ${revokedCount}, Пропущено: ${skippedCount}, Ошибок: ${errorCount} из ${approvals.length}`)

    const overallSuccess = errorCount === 0 || revokedCount > 0

    return {
      success: overallSuccess,
      walletAddress,
      ...(lastTransactionHash && { transactionHash: lastTransactionHash }),
      explorerUrl: explorerUrl ?? null,
      revokedCount,
      totalCount: approvals.length,
      skippedCount
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Критическая ошибка при отзыве апрувов', error)

    return {
      success: false,
      error: errorMessage
    }
  }
}

