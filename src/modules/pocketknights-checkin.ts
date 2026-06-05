import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { CONTRACTS } from '../contracts.js'

const CONTRACT_ADDRESS = CONTRACTS.pocketKnightsCheckin

// Контракт — EIP1967 proxy; ABI берём от реализации UserActivityUpgradeable.
// Чекин = logDailyLogin(); доступность = nextDailyClaimable(user) (UTC-полночь).
const CONTRACT_ABI = [
  {
    inputs: [],
    name: 'logDailyLogin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: '_user', type: 'address' }],
    name: 'nextDailyClaimable',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Получает баланс ETH для указанного адреса
 */
async function getBalance (address: `0x${string}`): Promise<string> {
  const balance = await publicClient.getBalance({ address })
  return formatEther(balance)
}

/**
 * Выполняет чекин Pocket Knights: вызов logDailyLogin() на контракте
 * UserActivity (через EIP1967 proxy).
 *
 * Сначала читает nextDailyClaimable(EOA) — если время следующего чекина
 * ещё не наступило, не тратит газ. Иначе симулирует и отправляет транзакцию.
 */
export async function performPocketKnightsCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const ethBalance = await getBalance(account.address)

    if (parseFloat(ethBalance) === 0) {
      return {
        success: false,
        walletAddress: account.address,
        error: 'Недостаточно ETH для оплаты газа'
      }
    }

    // Проверяем статус: наступило ли время следующего чекина для этого EOA
    try {
      const nextClaimable = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'nextDailyClaimable',
        args: [account.address]
      })

      const nowSec = BigInt(Math.floor(Date.now() / 1000))
      if (nextClaimable > nowSec) {
        logger.warn('Pocket Knights чекин уже выполнен сегодня (по nextDailyClaimable)')
        return {
          success: true,
          walletAddress: account.address,
          message: 'Чекин уже выполнен сегодня'
        }
      }
    } catch (statusError) {
      // Чтение статуса упало (RPC) — не блокируем, дальше отработает симуляция
      logger.debug(`Pocket Knights: не удалось прочитать nextDailyClaimable, продолжаем: ${statusError instanceof Error ? statusError.message : String(statusError)}`)
    }

    // Симуляция: если контракт ревертит (Already logged in today) — не отправляем tx
    try {
      await publicClient.simulateContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'logDailyLogin',
        account: account
      })
    } catch {
      logger.warn('Pocket Knights чекин уже выполнен сегодня или недоступен (симуляция откатилась)')
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'logDailyLogin'
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции'
      // "Already logged in today" — состояние RPC обновилось между
      // симуляцией и отправкой. Не считаем это ошибкой.
      if (isDailyDoneRevert(msg)) {
        logger.warn('Pocket Knights чекин уже выполнен сегодня (revert detected)')
        return {
          success: true,
          walletAddress: account.address,
          message: 'Чекин уже выполнен сегодня'
        }
      }
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        error: msg,
        message: msg
      }
    }

    const hash = txResult.hash
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.success('Pocket Knights check-in выполнен')
      logger.transaction(hash, 'confirmed', 'POCKETKNIGHTS')
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash
      }
    }

    return {
      success: false,
      walletAddress: account.address,
      transactionHash: hash,
      error: 'Транзакция не прошла',
      message: 'Транзакция откатилась (revert)'
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    // Подстраховка: revert «уже выполнено» мог пробиться сквозь pre-simulation
    if (isDailyDoneRevert(errorMessage)) {
      logger.warn('Pocket Knights чекин уже выполнен сегодня (revert detected в catch)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }
    logger.error('Ошибка Pocket Knights check-in', errorMessage)
    return {
      success: false,
      error: errorMessage,
      message: errorMessage
    }
  }
}

export { CONTRACT_ADDRESS, CONTRACT_ABI }
