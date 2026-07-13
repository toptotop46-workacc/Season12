import type { SeasonBadgeMintConfig } from './modules/season-badge-mint.js'

/**
 * Единая конфигурация текущего сезона.
 * Смена сезона и порога завершённости — в одном месте.
 */
export const CURRENT_SEASON = 12
/** Порог поинтов для статуса «завершён» (>= включительно). */
export const POINTS_LIMIT_SEASON = 81

/**
 * Если `true`, completed-кошельки (`seasonScore >= POINTS_LIMIT_SEASON`)
 * НЕ исключаются из работы parallel-executor: они продолжают попадать в
 * итерацию с обычной ротацией модулей.
 *
 * Если `false` — completed-кошельки полностью
 * исключаются из работы.
 */
export const GM_IGNORE_POINTS_LIMIT = false

/**
 * Переопределения колонок бонусных заданий в таблице статистики/Excel.
 * Ключ — dappId с портала (`profile/bonus-dapp`). При смене сезона обновить под новые квесты.
 *
 * - `header` — короткий заголовок вместо полного имени dapp (одна агрегированная колонка);
 * - `questHeaders` — развернуть dapp в отдельную колонку на каждый квест с этими заголовками
 *   (порядок как в API; лишние квесты получат заголовок «Имя #N»).
 */
export const BONUS_COLUMN_OVERRIDES: Record<string, { header?: string, questHeaders?: string[] }> = {
  startale_12: { questHeaders: ['GM', 'Referral', 'Swap 5$'] },
  sweep_12: { questHeaders: ['Guardian', 'Spirit', 'Shadow', 'Dragonlord'] },
  heroesofhecanos_12: { header: 'HOH' }
}

/** Минимальный процент от баланса ETH для свапа в USDC.e (через Jumper). Дробные значения допустимы, например 0.1 = 0.1%, 1 = 1%, 15 = 15%. */
export const LIQUIDITY_SWAP_PERCENT_MIN = 0.1
/** Максимальный процент от баланса ETH для свапа в USDC.e (через Jumper). Дробные значения допустимы. */
export const LIQUIDITY_SWAP_PERCENT_MAX = 0.9

/** Симулировать транзакцию перед отправкой (eth_call / simulateContract). Отключить при глючном RPC. */
export const SIMULATE_BEFORE_SEND = true

/** Строгая симуляция: блокировать транзакции при ошибке симуляции. false = только предупреждение. */
export const STRICT_SIMULATION = true

/**
 * Конфигурация активного минта SBT-бейджа предыдущего сезона.
 *
 * При наступлении нового сезона достаточно обновить только этот блок:
 * - `season` — номер сезона (UI таблицы, Excel и логов берётся отсюда)
 * - `nftContract` — адрес ERC721-контракта бейджа
 * - `mintPhase1Date` — старт Stage 1 (для 84+ поинтов)
 * - `mintPhase2Date` — старт Stage 2 (для threshold..83 поинтов)
 * - `threshold` — минимальный score для eligibility (по умолчанию 80)
 * - `txLabel` — метка для логов транзакций
 */
export const BADGE_MINT_CONFIG: SeasonBadgeMintConfig = {
  season: 11,
  nftContract: '0x37E893d74B01807aF36697E95BeBd2FD9B297425',
  mintPhase1Date: new Date('2026-07-08T10:00:00+03:00'), // Stage 1 для 84-100
  mintPhase2Date: new Date('2026-07-22T10:00:00+03:00'), // Stage 2 для 80-83
  threshold: 80,
  txLabel: 'SEASON11_BADGE_MINT'
}
