import axios from 'axios'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import { CURRENT_SEASON, POINTS_LIMIT_SEASON } from '../season-config.js'
import { parseApiResponse as parseSeasonApiResponse, statusFromPoints, sortByScoreAsc } from '../wallet-selection.js'

// Типы

interface TransactionCheckResult {
  address: string
  success: boolean
  pointsCount?: number
  maxPoints?: number
  ratio?: string
  status: 'done' | 'not_done' | 'error'
  error?: string
  responseTime?: number
}

// Основной класс модуля
export class TransactionChecker {
  private proxyManager: ProxyManager
  private readonly baseUrl = 'https://portal.soneium.org/api'
  private readonly proxyRetryErrorMessage = 'Не удалось подобрать рабочий прокси'
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0'
  ]

  private readonly CONFIG = {
    timeout: 10000,            // Timeout в мс
    retryAttempts: 10,         // Попытки повтора
    pointsLimit: POINTS_LIMIT_SEASON  // Лимит поинтов для статуса 'done' (из season-config)
  }

  constructor () {
    this.proxyManager = ProxyManager.getInstance()
  }

  // Проверка одного кошелька (публичный метод)
  async checkSingleWalletPublic (address: string): Promise<TransactionCheckResult> {
    return await this.checkSingleWallet(address)
  }

  // Основной метод для проверки списка кошельков
  async checkWallets (wallets: string[]): Promise<{
    activeWallets: string[]
    completedWallets: string[]
    /** Адреса отсортированные по score (от меньшего к большему) с их score */
    walletScores: Array<{ address: string, score: number, status: 'done' | 'not_done' | 'error' }>
  }> {
    // Выполняем все проверки параллельно
    const checkPromises = wallets.map(async (wallet) => {
      try {
        const result = await this.checkSingleWallet(wallet)
        return { wallet, result, error: null }
      } catch (error) {
        return {
          wallet,
          result: null,
          error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        }
      }
    })

    // Ждем завершения всех проверок
    const results = await Promise.all(checkPromises)

    const activeWallets: string[] = []
    const completedWallets: string[] = []
    const walletScores: Array<{ address: string, score: number, status: 'done' | 'not_done' | 'error' }> = []

    for (const { wallet, result, error } of results) {
      if (error) {
        activeWallets.push(wallet)
        walletScores.push({ address: wallet, score: 0, status: 'error' })
        logger.error(`${wallet}: критическая ошибка - ${error}`)
      } else if (result) {
        walletScores.push({ address: wallet, score: result.pointsCount ?? 0, status: result.status })
        if (result.status === 'done') {
          completedWallets.push(wallet)
        } else if (result.status === 'not_done') {
          activeWallets.push(wallet)
        } else {
          activeWallets.push(wallet)
          logger.error(`${wallet}: ошибка - ${result.error}`)
        }
      }
    }

    // Сортируем по score (отстающие первыми)
    const sortedScores = sortByScoreAsc(walletScores)
    walletScores.length = 0
    walletScores.push(...sortedScores)

    logger.info(`Проверка завершена: активных ${activeWallets.length}, завершенных ${completedWallets.length}`)

    return { activeWallets, completedWallets, walletScores }
  }

  // Проверка одного кошелька
  private async checkSingleWallet (address: string): Promise<TransactionCheckResult> {
    // Всегда запрашиваем через API
    return await this.checkWalletViaApi(address)
  }

  // Проверка через API с 10 попытками
  private async checkWalletViaApi (address: string): Promise<TransactionCheckResult> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.CONFIG.retryAttempts; attempt++) {
      let proxy: import('../proxy-manager.js').ProxyConfig | null = null

      try {
        proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }
        const result = await this.getTransactionData(address, proxy)

        if (result.success) {
          // Записываем в БД всегда (не только завершенные)
          // Данные уже сохранены в saveSeasonData

          return result
        } else {
          if (this.proxyManager.isProxyAuthError(result.error)) {
            this.proxyManager.markProxyAsUnhealthy(proxy)
            lastError = this.proxyRetryErrorMessage
            continue
          }

          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        if (proxy && this.proxyManager.isProxyAuthError(error)) {
          this.proxyManager.markProxyAsUnhealthy(proxy)
          lastError = this.proxyRetryErrorMessage
          continue
        }

        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      // Небольшая задержка между попытками
      if (attempt < this.CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    return {
      address,
      success: false,
      status: 'error',
      error: `Все ${this.CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}`
    }
  }

  // Получение данных из API
  private async getTransactionData (address: string, proxy: import('../proxy-manager.js').ProxyConfig): Promise<TransactionCheckResult> {
    const startTime = Date.now()

    try {
      const axiosInstance = this.createAxiosInstance(proxy)

      // Получаем данные о поинтах
      const response = await axiosInstance.get(`${this.baseUrl}/profile/calculator?address=${address}`)
      const data = response.data

      const { count, max } = this.parseApiResponse(data)
      const ratio = `${count}/${max}`
      const status = statusFromPoints(count, this.CONFIG.pointsLimit)

      return {
        address,
        success: true,
        pointsCount: count,
        maxPoints: max,
        ratio,
        status,
        responseTime: Date.now() - startTime
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        address,
        success: false,
        status: 'error',
        error: errorMessage,
        responseTime: Date.now() - startTime
      }
    }
  }

  // Получение случайного User-Agent
  private getRandomUserAgent (): string {
    const randomIndex = Math.floor(Math.random() * this.userAgents.length)
    return this.userAgents[randomIndex] || this.userAgents[0]!
  }

  // Создание axios instance с прокси
  private createAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
    const proxyAgents = this.proxyManager.createProxyAgents(proxy)
    const userAgent = this.getRandomUserAgent()

    return axios.create({
      timeout: this.CONFIG.timeout,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive'
      },
      httpsAgent: proxyAgents.httpsAgent,
      httpAgent: proxyAgents.httpAgent
    })
  }

  // Парсинг ответа API
  private parseApiResponse (apiData: unknown): { count: number, max: number } {
    return parseSeasonApiResponse(apiData, CURRENT_SEASON, POINTS_LIMIT_SEASON)
  }

}
