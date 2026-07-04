/**
 * Отзыв всех апрувов кошелька в Soneium.
 *
 * Список апрувов берётся из Rabby API (см. ../rabby-api.ts) — как в UI Rabby:
 *  - ERC-20  → token_authorized_list → approve(spender, 0)
 *  - NFT     → nft_authorized_list  → setApprovalForAll(spender, false)
 *
 * Перед каждой транзакцией состояние перепроверяется он-чейн: данные Rabby
 * могут отставать, а при недоступности/подмене ответа API чужой апрув даст
 * allowance 0 / isApprovedForAll false и будет пропущен без транзакции.
 */

import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { getTokenAuthorizedList, getNftAuthorizedList } from '../rabby-api.js'

// Задержка между транзакциями отзыва
const DELAY_BETWEEN_TX_MS = 5000

// ERC20 ABI: чтение allowance + отзыв через approve(spender, 0)
const ERC20_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' }
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

// Общий ABI ERC-721/ERC-1155: isApprovedForAll + setApprovalForAll
const NFT_APPROVAL_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'operator', type: 'address' }
    ],
    name: 'isApprovedForAll',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'operator', type: 'address' },
      { internalType: 'bool', name: 'approved', type: 'bool' }
    ],
    name: 'setApprovalForAll',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

// Одна задача отзыва: (контракт, спендер) + вид апрува
interface RevokeTask {
  kind: 'erc20' | 'nft'
  contract: `0x${string}`
  spender: `0x${string}`
  label: string
}

// Результат отзыва одного апрува
interface RevokeResult {
  success: boolean
  transactionHash?: string
  skipped?: boolean
  error?: string
}

function shortAddr (addr: string): string {
  return `${addr.slice(0, 8)}…`
}

/**
 * Загружает апрувы кошелька из Rabby API и собирает план отзыва.
 * Пары (контракт, спендер) дедуплицируются: в NFT-ответе пара повторяется
 * на каждый token id коллекции.
 */
async function buildRevokeTasks (walletAddress: `0x${string}`): Promise<RevokeTask[]> {
  const [tokens, nft] = await Promise.all([
    getTokenAuthorizedList(walletAddress),
    getNftAuthorizedList(walletAddress)
  ])

  const tasks: RevokeTask[] = []
  const seen = new Set<string>()

  const addTask = (kind: RevokeTask['kind'], contract: string, spender: string, label: string): void => {
    if (!isAddress(contract) || !isAddress(spender)) return
    const key = `${kind}:${contract.toLowerCase()}:${spender.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    tasks.push({
      kind,
      contract: contract.toLowerCase() as `0x${string}`,
      spender: spender.toLowerCase() as `0x${string}`,
      label
    })
  }

  let erc20Count = 0
  for (const token of tokens) {
    const symbol = token.optimized_symbol || token.symbol || shortAddr(token.id)
    for (const spender of token.spenders ?? []) {
      addTask('erc20', token.id, spender.id, `${symbol} → ${shortAddr(spender.id)}`)
      erc20Count++
    }
  }

  for (const approval of nft.contracts) {
    if (!approval.spender) continue
    const name = approval.contract_name || shortAddr(approval.contract_id)
    addTask('nft', approval.contract_id, approval.spender.id, `NFT ${name} → ${shortAddr(approval.spender.id)}`)
  }

  if (nft.tokens.length > 0) {
    logger.warn(`Rabby вернул ${nft.tokens.length} одиночных NFT-апрувов (approve по token id) — их отзыв не поддерживается, пропускаем`)
  }

  logger.info(`Rabby: апрувов ERC-20: ${erc20Count}, NFT-коллекций: ${nft.contracts.length}, к отзыву после дедупликации: ${tasks.length}`)

  return tasks
}

/**
 * Отзывает один апрув. Перед отправкой перепроверяет состояние он-чейн —
 * уже отозванный (или чужой) апрув пропускается без транзакции.
 */
async function revokeApproval (
  publicClient: ReturnType<typeof rpcManager.createPublicClient>,
  walletClient: ReturnType<typeof rpcManager.createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  task: RevokeTask
): Promise<RevokeResult> {
  try {
    if (task.kind === 'erc20') {
      const allowance = await publicClient.readContract({
        address: task.contract,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account.address, task.spender]
      }) as bigint

      if (allowance === 0n) {
        return { success: true, skipped: true }
      }
    } else {
      const approved = await publicClient.readContract({
        address: task.contract,
        abi: NFT_APPROVAL_ABI,
        functionName: 'isApprovedForAll',
        args: [account.address, task.spender]
      }) as boolean

      if (!approved) {
        return { success: true, skipped: true }
      }
    }

    const writeParams = task.kind === 'erc20'
      ? {
          address: task.contract,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [task.spender, 0n] as const
        }
      : {
          address: task.contract,
          abi: NFT_APPROVAL_ABI,
          functionName: 'setApprovalForAll',
          args: [task.spender, false] as const
        }

    const estimatedGas = await publicClient.estimateContractGas({
      ...writeParams,
      account
    } as Parameters<typeof publicClient.estimateContractGas>[0])

    const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        ...writeParams,
        gas: gasLimit,
        chain: soneiumChain,
        account
      }
    )

    if (!txResult.success) {
      return { success: false, error: txResult.error || 'Ошибка отправки транзакции' }
    }

    const hash = txResult.hash
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'REVOKE', account.address)
      return { success: true, transactionHash: hash }
    }

    logger.transaction(hash, 'failed', 'REVOKE', account.address)
    return { success: false, error: 'Транзакция не подтверждена' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка при отзыве апрува ${task.label}: ${errorMessage}`)
    return { success: false, error: errorMessage }
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

    // Получаем список апрувов из Rabby API; при недоступности API — ошибка модуля
    let tasks: RevokeTask[]
    try {
      tasks = await buildRevokeTasks(walletAddress)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Не удалось получить список апрувов: ${message}`)
      return {
        success: false,
        walletAddress,
        error: message
      }
    }

    if (tasks.length === 0) {
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

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!

      const result = await revokeApproval(publicClient, walletClient, account, task)

      if (result.success) {
        if (result.skipped) {
          skippedCount++
          logger.info(`Пропущено (уже отозван): ${task.label}`)
        } else {
          revokedCount++
          logger.success(`Отозван апрув: ${task.label}`)
          if (result.transactionHash) {
            lastTransactionHash = result.transactionHash
          }
        }
      } else {
        errorCount++
        logger.error(`Ошибка отзыва апрува: ${task.label} - ${result.error}`)
      }

      // Задержка между транзакциями (кроме последней)
      if (i < tasks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_TX_MS))
      }
    }

    // Формируем explorer URL для последней транзакции
    let explorerUrl: string | null = null
    if (lastTransactionHash) {
      explorerUrl = `https://soneium.blockscout.com/tx/${lastTransactionHash}`
    }

    logger.info(`Отозвано: ${revokedCount}, Пропущено: ${skippedCount}, Ошибок: ${errorCount} из ${tasks.length}`)

    const overallSuccess = errorCount === 0 || revokedCount > 0

    return {
      success: overallSuccess,
      walletAddress,
      ...(lastTransactionHash && { transactionHash: lastTransactionHash }),
      explorerUrl: explorerUrl ?? null,
      revokedCount,
      totalCount: tasks.length,
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
