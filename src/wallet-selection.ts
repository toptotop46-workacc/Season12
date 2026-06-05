/**
 * Чистые (без побочных эффектов) функции критического пути выбора кошельков.
 *
 * Вынесены сюда из `transaction-checker.ts` и `parallel-executor.ts`,
 * чтобы их можно было покрыть unit-тестами без сети, прокси и приватных
 * ключей. Боевой код импортирует эти функции — тесты проверяют ровно ту
 * логику, что работает в проде.
 */

export type WalletStatus = 'done' | 'not_done' | 'error'

export interface WalletScore {
  address: string
  score: number
  status: WalletStatus
}

interface SeasonDataItem {
  season: number
  totalScore: number
}

/**
 * Определяет статус кошелька по набранным поинтам.
 * `done`, если набрано не меньше порога завершённости.
 */
export function statusFromPoints (count: number, pointsLimit: number): 'done' | 'not_done' {
  return count >= pointsLimit ? 'done' : 'not_done'
}

/**
 * Сортирует кошельки по score по возрастанию (отстающие — первыми).
 * Возвращает новый массив, исходный не мутирует.
 */
export function sortByScoreAsc (scores: WalletScore[]): WalletScore[] {
  return [...scores].sort((a, b) => a.score - b.score)
}

/**
 * Проверяет, достиг ли кошелёк дневного лимита транзакций.
 */
export function hasReachedDailyCap (todayTxCount: number, maxPerDay: number): boolean {
  return todayTxCount >= maxPerDay
}

/**
 * Фильтрует кошельки, у которых не достигнут дневной лимит транзакций.
 * Если лимита достигли все — возвращает исходный список (fallback),
 * чтобы итерация не оставалась пустой.
 */
export function filterUnderDailyCap<T extends { address: string }> (
  wallets: T[],
  txCountOf: (address: string) => number,
  maxPerDay: number
): T[] {
  const underCap = wallets.filter(w => !hasReachedDailyCap(txCountOf(w.address), maxPerDay))
  return underCap.length > 0 ? underCap : wallets
}

/**
 * Сортирует пул кошельков по приоритету для итерации:
 *   1) Кошельки без транзакции сегодня (нужен streak) — первыми.
 *   2) При равенстве — по score (меньший score = отстающий = выше).
 * Возвращает новый массив, исходный не мутирует.
 */
export function prioritizeWallets<T extends { address: string }> (
  wallets: T[],
  hasTransactedToday: (address: string) => boolean,
  scoreOf: (address: string) => number
): T[] {
  return [...wallets].sort((a, b) => {
    const aToday = hasTransactedToday(a.address) ? 1 : 0
    const bToday = hasTransactedToday(b.address) ? 1 : 0
    if (aToday !== bToday) return aToday - bToday // без транзакции сегодня → выше
    return scoreOf(a.address) - scoreOf(b.address) // меньший score → выше
  })
}

/**
 * Парсит ответ API портала Soneium: достаёт totalScore текущего сезона.
 * Возвращает безопасные значения по умолчанию для пустого/невалидного ответа.
 */
export function parseApiResponse (
  apiData: unknown,
  currentSeason: number,
  pointsLimit: number
): { count: number, max: number } {
  if (!Array.isArray(apiData) || apiData.length === 0) {
    return { count: 0, max: pointsLimit }
  }

  const seasonData: SeasonDataItem[] = apiData.map((item: unknown) => {
    const data = (item ?? {}) as Record<string, unknown>
    return {
      season: typeof data['season'] === 'number' ? data['season'] : 0,
      totalScore: typeof data['totalScore'] === 'number' ? data['totalScore'] : 0
    }
  })

  const seasonDataItem = seasonData.find(item => item.season === currentSeason)
  const totalScore = seasonDataItem ? seasonDataItem.totalScore : 0

  return { count: totalScore, max: pointsLimit }
}
