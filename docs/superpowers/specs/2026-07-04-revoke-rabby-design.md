# Revoke через Rabby API — дизайн

Дата: 2026-07-04. Статус: утверждён пользователем.

## Цель

Переделать `src/modules/revoke.ts`: вместо перебора фиксированной матрицы
TOKENS×SPENDERS из `contracts.ts` получать реальный список апрувов кошелька
через Rabby API (api.rabby.io) и отзывать **все** найденные апрувы —
ERC-20 (`approve(spender, 0)`) и NFT (`setApprovalForAll(spender, false)`).

## Источник знаний

- HAR-запись веб-версии Rabby (`acmacodkjbdgmoleebolmdjonilkdbch.har`, в корне,
  git-ignored) — эндпоинты, заголовки, эталонная подпись.
- https://github.com/privatekey7/DeBankChecker — алгоритм подписи DeBank;
  у Rabby та же схема с префиксом `rabby-api\n` (проверено: подпись из HAR
  воспроизведена байт-в-байт).

## Компоненты

### `src/rabby-api.ts` (новый)

Клиент Rabby API:

- **Подпись** (чистая функция `signRabbyRequest`, юнит-тестируется):
  - `nonce = "n_" + 40 символов` из алфавита
    `0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz`;
  - `ts` — unix-время в секундах;
  - `K = sha256("rabby-api\n{nonce}\n{ts}")` (hex);
  - `M = sha256("{METHOD}\n{path}\n{query-параметры, отсортированные по ключу}")` (hex);
  - `x-api-sign = HMAC-SHA256(key=K, msg=M)` (hex).
- **Заголовки**: `x-api-key` (начальное значение — константа из HAR, сервер
  может ротировать через `x-set-api-key` в ответе), `x-api-time` (ts инициализации
  клиента), `x-api-ts`, `x-api-nonce`, `x-api-ver: v2`, `x-api-sign`,
  `x-client: Rabby`, `x-version: 0.93.80`, браузерный User-Agent.
- **Транспорт**: undici `ProxyAgent` + fetch (паттерн `startale-gm.ts`),
  случайный прокси из `ProxyManager` на каждую попытку, ретраи с ротацией
  прокси, backoff на 429/5xx. Без прокси — прямой запрос.
- **Методы**: `getTokenAuthorizedList(address)` и `getNftAuthorizedList(address)`,
  оба с `chain_id=soneium`.

### `src/modules/revoke.ts` (переписан)

1. Забирает оба списка через Rabby. Ошибка API после всех ретраев →
   `success: false` (без fallback на он-чейн перебор — решение пользователя).
2. Составляет план отзыва: пары (токен, спендер) из `token_authorized_list.spenders`
   и (NFT-контракт, спендер) из `nft_authorized_list.contracts`; дедупликация
   по паре адресов (в NFT-ответе пары повторяются на каждый token id).
   Поле `tokens` NFT-ответа (одиночные ERC-721 approve) игнорируется —
   схема неизвестна, в HAR пусто; если непусто — warning в лог.
3. Перед каждой транзакцией — он-чейн проверка (`allowance > 0` /
   `isApprovedForAll`): данные Rabby могут отставать, плюс это защита от
   чужих данных в ответе API (response contamination — см. DeBankChecker):
   чужой апрув даст 0/false и будет пропущен.
4. Отзыв через `safeWriteContract`; сохраняются проверка баланса на газ,
   задержка 5 с между транзакциями и формат результата
   (`revokedCount`/`totalCount`/`skippedCount`).
5. Экспорт `performRevoke(privateKey)` не меняется → регистрации в
   `run-module.ts` и `parallel-executor.ts` не трогаем.

## Тесты

- `tests/rabby-sign.test.ts` — `signRabbyRequest` против эталонных значений
  из HAR (nonce, ts, ожидаемая подпись) + формат nonce.

## Проверка

`npm run type-check`, `npm run lint`, `npm test`, живой прогон
`npm run revoke` (случайный кошелёк).
