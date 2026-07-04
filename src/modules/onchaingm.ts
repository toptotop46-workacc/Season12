import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { CONTRACTS, ZERO_ADDRESS } from '../contracts.js'
import { fetchBonusDappProgress, isAllQuestsDone } from '../bonus-quest-progress.js'

/**
 * OnChainGM (onchaingm.com) — бонусный квест 12 сезона (02.07–30.07.2026).
 * Задание: "Complete the GM action on Soneium 5 times." (GM ×5, лимит 5/5).
 * Dapp: https://onchaingm.com | dappId портала: onchaingm_12
 *
 * Воспроизводит транзакцию
 * https://soneium.blockscout.com/tx/0x8e92e38031c1692234c10fc7eecd4bd21dbbcfd3d356b7959bc00d0bafbf7792
 * Контракт ERC1967Proxy `0x8ADA1808...`, метод onChainGM(address referrer) payable.
 *
 * Комиссия: платный GM ~$0.10 в ETH. Точную сумму в wei отдаёт сам контракт
 * через getCurrentFees() (обновляется по оракулу) — считать цену ETH не нужно.
 * Referrer = zero address (как в образце) → платим normalWei (полная комиссия).
 *
 * Доступность: timeUntilNextGM(address) — секунды до следующего GM. 0 = можно
 * сейчас, >0 = кулдаун (пропускаем кошелёк, не тратим комиссию).
 */

const CONTRACT_ADDRESS = CONTRACTS.onchainGm

const CONTRACT_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'referrer', type: 'address' }],
    name: 'onChainGM',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getCurrentFees',
    outputs: [
      { internalType: 'uint256', name: 'normalWei', type: 'uint256' },
      { internalType: 'uint256', name: 'referralWei', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'timeUntilNextGM',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const BONUS_DAPP_ID = 'onchaingm_12'
const MODULE_LABEL = 'OnChainGM'

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Квест уже полностью выполнен (5/5) на портале?
 * Нужно, чтобы не платить комиссию впустую после завершения задания.
 * Возвращает false при недоступности портала (тогда работаем по контракту).
 */
async function isQuestComplete (address: string): Promise<boolean> {
  const quests = await fetchBonusDappProgress(address, BONUS_DAPP_ID, MODULE_LABEL)
  return isAllQuestsDone(quests)
}

export async function performOnChainGm (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  feeEth?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  const account = privateKeyToAccount(privateKey)

  try {
    // 1. Доступность GM по контракту (кулдаун ~24ч). Дёшево, без прокси.
    const secondsLeft = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'timeUntilNextGM',
      args: [account.address]
    })
    if (secondsLeft > 0n) {
      const hours = (Number(secondsLeft) / 3600).toFixed(1)
      logger.warn(`${MODULE_LABEL}: GM недоступен (кулдаун ещё ${hours}ч) — пропуск`)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        reason: `GM на кулдауне (${hours}ч)`,
        message: `GM на кулдауне (${hours}ч)`
      }
    }

    // 2. GM доступен. Прежде чем платить $0.10 — проверим, не выполнен ли квест 5/5.
    //    (портал опционален: если недоступен, всё равно делаем GM)
    if (await isQuestComplete(account.address)) {
      logger.warn(`${MODULE_LABEL}: квест уже выполнен 5/5 — пропуск (не платим комиссию)`)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        reason: 'Квест выполнен 5/5',
        message: 'Квест выполнен 5/5'
      }
    }

    // 3. Комиссия из контракта (normalWei — путь без реферера, как в образце)
    const [normalWei] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'getCurrentFees'
    })
    const feeEth = formatEther(normalWei)

    // 4. Баланс должен покрыть комиссию + газ
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance <= normalWei) {
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточно ETH: баланс ${formatEther(balance)}, комиссия GM ${feeEth} + газ`
      }
    }

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    logger.info(`${MODULE_LABEL}: GM (комиссия ${feeEth} ETH ~$0.10)`)

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'onChainGM',
        args: [ZERO_ADDRESS],
        value: normalWei
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции GM'
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'ONCHAIN_GM')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success') {
      logger.transaction(hash, 'failed', 'ONCHAIN_GM', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Транзакция GM откатилась (revert)'
      }
    }

    logger.success(`${MODULE_LABEL}: GM выполнен (комиссия ${feeEth} ETH)`)
    logger.transaction(hash, 'confirmed', 'ONCHAIN_GM', account.address)

    return {
      success: true,
      walletAddress: account.address,
      transactionHash: hash,
      feeEth,
      message: `GM выполнен (${feeEth} ETH)`
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка ${MODULE_LABEL}`, errorMessage)
    return { success: false, walletAddress: account.address, error: errorMessage, message: errorMessage }
  }
}

export { CONTRACT_ADDRESS, CONTRACT_ABI }
