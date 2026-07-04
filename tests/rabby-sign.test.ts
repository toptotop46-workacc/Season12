import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { signRabbyRequest, generateRabbyNonce } from '../src/rabby-api.js'

describe('signRabbyRequest', () => {
  // Эталон — реальный запрос веб-версии Rabby из HAR-записи
  // (GET /v2/user/token_authorized_list, chain_id=soneium).
  it('воспроизводит подпись реального запроса из HAR', () => {
    const { signature, nonce, ts } = signRabbyRequest(
      'GET',
      '/v2/user/token_authorized_list',
      { id: '0xb3fb4369d1079dc85c10ac6366b345925df71adb', chain_id: 'soneium' },
      'n_q4swhlHcCM4vVqvBrFuCxzFdaO8VkEGJESwSFIfg',
      1783182865
    )

    assert.equal(signature, '8b0dc0435ed0234b9e4a56eb4635dfe3551ce2c2e926bf167be5ed65205d02a8')
    assert.equal(nonce, 'n_q4swhlHcCM4vVqvBrFuCxzFdaO8VkEGJESwSFIfg')
    assert.equal(ts, 1783182865)
  })

  it('сортирует query-параметры по ключу (порядок не влияет на подпись)', () => {
    const a = signRabbyRequest('GET', '/v2/x', { b: '2', a: '1' }, 'n_test', 1000)
    const b = signRabbyRequest('GET', '/v2/x', { a: '1', b: '2' }, 'n_test', 1000)
    assert.equal(a.signature, b.signature)
  })

  it('генерирует nonce и ts, если они не переданы', () => {
    const before = Math.floor(Date.now() / 1000)
    const { nonce, ts } = signRabbyRequest('GET', '/v2/x', {})
    assert.match(nonce, /^n_[0-9A-Za-z]{40}$/)
    assert.ok(ts >= before && ts <= before + 2)
  })
})

describe('generateRabbyNonce', () => {
  it('возвращает n_ + 40 символов алфавита', () => {
    for (let i = 0; i < 20; i++) {
      assert.match(generateRabbyNonce(), /^n_[0-9A-Za-z]{40}$/)
    }
  })
})
