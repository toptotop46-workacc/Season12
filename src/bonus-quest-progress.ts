import axios from 'axios'
import { logger } from './logger.js'
import { ProxyManager } from './proxy-manager.js'
import { config } from './config.js'

/**
 * Общий помощник для бонусных квестов сезона: запрос прогресса dapp-квеста
 * с портала Soneium (endpoint `profile/bonus-dapp`).
 *
 * Используется модулями бонусных заданий, чтобы не отправлять транзакции,
 * когда квест уже выполнен (не тратить газ).
 */

export interface QuestProgress {
  completed: number
  required: number
  isDone: boolean
}

/**
 * Запрашивает прогресс всех квестов указанного dapp с портала Soneium.
 *
 * Возвращает:
 * - `QuestProgress[]` — прогресс по каждому квесту dapp (порядок как в API);
 * - `[]` — dapp не найден в ответе (квест ещё не активен / другой сезон);
 * - `null` — не удалось получить данные (тогда выполнение не блокируем).
 */
export async function fetchBonusDappProgress (
  address: string,
  dappId: string,
  logLabel: string = dappId
): Promise<QuestProgress[] | null> {
  const proxyManager = ProxyManager.getInstance()
  const maxAttempts = 5

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = proxyManager.getRandomProxyFast()
    if (!proxy) {
      logger.debug(`${logLabel}: нет доступных прокси для проверки портала`)
      return null
    }

    try {
      const proxyAgents = proxyManager.createProxyAgents(proxy)
      const response = await axios.get(`${config.statsApiBaseUrl}/profile/bonus-dapp?address=${address}`, {
        timeout: config.statsApiTimeout,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        httpsAgent: proxyAgents.httpsAgent,
        httpAgent: proxyAgents.httpAgent
      })

      const data = response.data
      if (!Array.isArray(data)) return null

      const dapp = data.find((d: Record<string, unknown>) => d['id'] === dappId)
      if (!dapp || !Array.isArray(dapp['quests'])) {
        // Квест не найден (ещё не активен / другой сезон) — считаем прогресс нулевым
        return []
      }

      return (dapp['quests'] as Record<string, unknown>[]).map(quest => ({
        completed: typeof quest['completed'] === 'number' ? quest['completed'] : 0,
        required: typeof quest['required'] === 'number' ? quest['required'] : 1,
        isDone: quest['isDone'] === true
      }))
    } catch (error) {
      if (proxyManager.isProxyAuthError(error)) {
        proxyManager.markProxyAsUnhealthy(proxy)
      }
      if (attempt === maxAttempts) {
        logger.debug(`${logLabel}: не удалось получить прогресс с портала: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  return null
}

/** Форматирует прогресс квестов в строку вида "3/5, 1/1". */
export function formatQuestProgress (quests: QuestProgress[]): string {
  return quests.map(q => `${q.completed}/${q.required}`).join(', ')
}

/** Все квесты dapp выполнены (список не пуст и каждый isDone). */
export function isAllQuestsDone (quests: QuestProgress[] | null): quests is QuestProgress[] {
  return Array.isArray(quests) && quests.length > 0 && quests.every(q => q.isDone)
}
