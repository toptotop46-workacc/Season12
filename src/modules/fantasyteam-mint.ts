import { privateKeyToAccount } from 'viem/accounts'
import { logger } from '../logger.js'
import { fetchBonusDappProgress, formatQuestProgress, isAllQuestsDone } from '../bonus-quest-progress.js'

/**
 * ЗАГЛУШКА S12: Fantasy Team — бонусный квест 12 сезона (02.07–30.07.2026).
 *
 * Задание: "Mint your Team ID." (минт Team ID ×1)
 * Dapp: https://app.startale.com/miniapps#fantasy-team | dappId портала: fantasyteam_12
 *
 * TODO: реализовать минт Team ID (адрес контракта + ABI из explorer/HAR),
 * по образцу существующих mint-модулей (safeWriteContract из transaction-utils).
 */

const BONUS_DAPP_ID = 'fantasyteam_12'
const MODULE_LABEL = 'Fantasy Team'

export async function performFantasyTeamMint (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  const account = privateKeyToAccount(privateKey)

  // Проверяем прогресс квеста через портал — выполненные кошельки пропускаем
  const quests = await fetchBonusDappProgress(account.address, BONUS_DAPP_ID, MODULE_LABEL)
  if (isAllQuestsDone(quests)) {
    const label = formatQuestProgress(quests)
    logger.warn(`${MODULE_LABEL}: квест уже выполнен (${label}) — пропуск`)
    return {
      success: true,
      skipped: true,
      walletAddress: account.address,
      reason: `Квест выполнен ${label}`,
      message: `Квест выполнен ${label}`
    }
  }

  logger.warn(`${MODULE_LABEL}: модуль не реализован (заглушка S12) — пропуск`)
  return {
    success: false,
    skipped: true,
    walletAddress: account.address,
    reason: 'Модуль не реализован (заглушка S12)',
    message: 'Модуль не реализован (заглушка S12)'
  }
}
