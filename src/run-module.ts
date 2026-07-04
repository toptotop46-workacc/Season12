import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { logger } from './logger.js'
import { shutdownManager } from './shutdown.js'

// Импорт всех модулей
import { performArkadaCheckin } from './modules/arkada-checkin.js'
import { performLootcoinCheckin } from './modules/lootcoin.js'
import { performJumperSwap } from './modules/jumper.js'
import { performRevoke } from './modules/revoke.js'
import { performHarkan } from './modules/harkan.js'
import { performVelodrome } from './modules/velodrome.js'
import { performWowmax } from './modules/wowmax.js'
import { performCaptainCheckin } from './modules/captain-checkin.js'
import { performDiceOrDieCheckin } from './modules/diceordie-checkin.js'
import { performPocketKnightsCheckin } from './modules/pocketknights-checkin.js'
import { performStartaleGm } from './modules/startale-gm.js'
import { performStartaleSwap } from './modules/startale-swap.js'
import { performStartaleInvite } from './modules/startale-invite.js'
import { performFantasyTeamMint } from './modules/fantasyteam-mint.js'
import { performSweepMint } from './modules/sweep-mint.js'
import { performOnChainGm } from './modules/onchaingm.js'
import { performHecanosMint } from './modules/hecanos-mint.js'

// Интерфейс для результата выполнения модуля
interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean // Флаг пропуска кошелька (не ошибка)
  reason?: string // Причина пропуска
  // Дополнительные поля для конкретных модулей
  ethBalance?: string
  swapAmount?: string
  targetToken?: string
  streak?: number
  blockNumber?: bigint
  message?: string
  [key: string]: unknown
}

// Типы для модулей
interface Module {
  name: string
  description: string
  execute: (privateKey: `0x${string}`) => Promise<ModuleResult>
}

// Список всех доступных модулей
const modules: Record<string, Module> = {
  'arkada-checkin': {
    name: 'Arkada Check-in',
    description: 'Ежедневный check-in в Arkada',
    execute: performArkadaCheckin
  },
  'lootcoin': {
    name: 'Lootcoin Check-in',
    description: 'Ежедневный check-in в Lootcoin',
    execute: performLootcoinCheckin
  },
  'jumper': {
    name: 'Jumper',
    description: 'Свапы токенов через LI.FI',
    execute: performJumperSwap
  },
  'revoke': {
    name: 'Revoke',
    description: 'Отзыв всех апрувов для кошелька',
    execute: performRevoke
  },
  'harkan': {
    name: 'Harkan',
    description: 'Один спин в Harkan (cyber-roulette)',
    execute: performHarkan
  },
  'velodrome': {
    name: 'Velodrome',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через Velodrome',
    execute: performVelodrome
  },
  'wowmax': {
    name: 'WOWMAX',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX',
    execute: performWowmax
  },
  'captain-checkin': {
    name: 'Captain Check-in',
    description: 'Ежедневный check-in в Captain',
    execute: performCaptainCheckin
  },
  'diceordie-checkin': {
    name: 'Dice or Die Check-in',
    description: 'Ежедневный check-in в Dice or Die',
    execute: performDiceOrDieCheckin
  },
  'pocketknights-checkin': {
    name: 'Pocket Knights Check-in',
    description: 'Ежедневный check-in в Pocket Knights',
    execute: performPocketKnightsCheckin
  },
  // Бонусные квесты S12 (заглушки — onchain-действия реализуем по одному)
  'startale-gm': {
    name: 'Startale GM',
    description: 'Бонусный квест S12: Daily GM x5 для Startale (бесплатный checkIn)',
    execute: performStartaleGm
  },
  'startale-swap': {
    name: 'Startale Swap',
    description: 'Бонусный квест S12: свап ~$5-6 ETH → USDSC через Kyo',
    execute: performStartaleSwap
  },
  'startale-invite': {
    name: 'Startale Invite',
    description: 'Бонусный квест S12: реферал (invite 1 friend) — требует прокси',
    execute: performStartaleInvite
  },
  'fantasyteam-mint': {
    name: 'Fantasy Team',
    description: 'Бонусный квест S12: минт Team ID (заглушка)',
    execute: performFantasyTeamMint
  },
  'sweep-mint': {
    name: 'Sweep',
    description: 'Бонусный квест S12: минт 4 NFT Chain of Legends (заглушка)',
    execute: performSweepMint
  },
  'onchaingm': {
    name: 'OnChainGM',
    description: 'Бонусный квест S12: GM x5 (заглушка)',
    execute: performOnChainGm
  },
  'hecanos-mint': {
    name: 'Heroes of Hecanos',
    description: 'Бонусный квест S12: минт Card Back NFT (заглушка)',
    execute: performHecanosMint
  }
}

/**
 * Получает случайный приватный ключ из хранилища (зашифрованного или открытого)
 */
async function getRandomPrivateKey (): Promise<`0x${string}`> {
  try {
    let privateKeys: string[] = []

    if (KeyEncryption.hasEncryptedKeys()) {
      privateKeys = await KeyEncryption.promptPasswordWithRetry()
    } else if (KeyEncryption.hasPlainKeys()) {
      privateKeys = await KeyEncryption.loadPlainKeys()
    } else {
      throw new Error('Не найдено ключей')
    }

    if (privateKeys.length === 0) {
      throw new Error('Не найдено приватных ключей')
    }

    const randomIndex = Math.floor(Math.random() * privateKeys.length)
    const selectedKey = privateKeys[randomIndex]!

    return selectedKey as `0x${string}`
  } catch (error) {
    logger.error('Ошибка при получении приватного ключа', error)
    throw error
  }
}

/**
 * Выполняет указанный модуль
 */
async function executeModule (moduleName: string): Promise<void> {
  try {
    logger.moduleStart(moduleName)

    // Проверяем существование модуля
    const module = modules[moduleName]
    if (!module) {
      logger.error(`Модуль '${moduleName}' не найден!`)
      logger.info('Доступные модули:')
      Object.keys(modules).forEach(name => {
        logger.info(`  - ${name}`)
      })
      return
    }

    const privateKey = await getRandomPrivateKey()

    const startTime = Date.now()
    const result = await module.execute(privateKey)
    const endTime = Date.now()
    const executionTime = (endTime - startTime) / 1000

    // Если кошелек пропущен (skipped), это не ошибка
    const isSkipped = result.skipped === true
    const isSuccess = result.success || isSkipped

    logger.moduleEnd(moduleName, isSuccess, executionTime)

  } catch (error) {
    logger.moduleEnd(moduleName, false)
    logger.error('Критическая ошибка выполнения модуля', error)
  }
}

/**
 * Показывает список всех доступных модулей
 */
function showAvailableModules (): void {
  logger.info('Доступные модули: ' + Object.keys(modules).join(', '))
}

/**
 * Основная функция для запуска модуля
 */
async function main (): Promise<void> {
  try {
    // Настройка кодировки для корректного отображения кириллицы
    setupEncoding()

    // Получаем имя модуля из аргументов командной строки
    const moduleName = process.argv[2]

    if (!moduleName) {
      showAvailableModules()
      logger.info('Использование: npm run <module-name>')
      return
    }

    // Проверяем и предлагаем шифрование ключей
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      return
    }

    if (!KeyEncryption.hasEncryptedKeys() && !KeyEncryption.hasPlainKeys()) {
      logger.error('Не найдены ключи. Создайте файл keys.txt с приватными ключами.')
      return
    }

    // Выполняем указанный модуль
    await executeModule(moduleName)

  } catch (error) {
    logger.error('Критическая ошибка приложения', error)
    await shutdownManager.shutdown(1, 'Критическая ошибка')
  }
}

// SIGINT/SIGTERM handled by shutdownManager
main().catch(async (error) => {
  logger.error('Необработанная ошибка', error)
  await shutdownManager.shutdown(1, 'Необработанная ошибка')
})
