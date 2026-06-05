import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  statusFromPoints,
  sortByScoreAsc,
  hasReachedDailyCap,
  filterUnderDailyCap,
  prioritizeWallets,
  parseApiResponse,
  type WalletScore
} from '../src/wallet-selection.js'

describe('statusFromPoints', () => {
  it("returns 'done' when count >= limit", () => {
    assert.equal(statusFromPoints(81, 81), 'done')
    assert.equal(statusFromPoints(100, 81), 'done')
  })

  it("returns 'not_done' when count < limit", () => {
    assert.equal(statusFromPoints(80, 81), 'not_done')
    assert.equal(statusFromPoints(0, 81), 'not_done')
  })
})

describe('sortByScoreAsc', () => {
  it('sorts laggards (lower score) first', () => {
    const input: WalletScore[] = [
      { address: 'a', score: 50, status: 'not_done' },
      { address: 'b', score: 10, status: 'not_done' },
      { address: 'c', score: 90, status: 'done' }
    ]
    const sorted = sortByScoreAsc(input)
    assert.deepEqual(sorted.map(w => w.address), ['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const input: WalletScore[] = [
      { address: 'a', score: 2, status: 'not_done' },
      { address: 'b', score: 1, status: 'not_done' }
    ]
    sortByScoreAsc(input)
    assert.deepEqual(input.map(w => w.address), ['a', 'b'])
  })

  it('handles empty array', () => {
    assert.deepEqual(sortByScoreAsc([]), [])
  })
})

describe('hasReachedDailyCap', () => {
  it('is true at or above the cap', () => {
    assert.equal(hasReachedDailyCap(15, 15), true)
    assert.equal(hasReachedDailyCap(16, 15), true)
  })

  it('is false below the cap', () => {
    assert.equal(hasReachedDailyCap(14, 15), false)
    assert.equal(hasReachedDailyCap(0, 15), false)
  })
})

describe('filterUnderDailyCap', () => {
  const wallets = [{ address: 'a' }, { address: 'b' }, { address: 'c' }]

  it('keeps only wallets under the cap', () => {
    const counts: Record<string, number> = { a: 0, b: 15, c: 5 }
    const result = filterUnderDailyCap(wallets, (addr) => counts[addr] ?? 0, 15)
    assert.deepEqual(result.map(w => w.address), ['a', 'c'])
  })

  it('falls back to full list when all wallets are capped', () => {
    const counts: Record<string, number> = { a: 15, b: 20, c: 15 }
    const result = filterUnderDailyCap(wallets, (addr) => counts[addr] ?? 0, 15)
    assert.deepEqual(result.map(w => w.address), ['a', 'b', 'c'])
  })
})

describe('prioritizeWallets', () => {
  it('puts wallets without a tx today first, then lowest score', () => {
    const wallets = [{ address: 'a' }, { address: 'b' }, { address: 'c' }, { address: 'd' }]
    const txToday = new Set(['a', 'c']) // a and c already transacted today
    const scores: Record<string, number> = { a: 5, b: 50, c: 5, d: 10 }

    const result = prioritizeWallets(
      wallets,
      (addr) => txToday.has(addr),
      (addr) => scores[addr] ?? 0
    )

    // b (no tx, score 50) and d (no tx, score 10) come first, sorted by score: d, b
    // then a and c (transacted), sorted by score: a(5)/c(5)
    assert.deepEqual(result.slice(0, 2).map(w => w.address), ['d', 'b'])
    assert.ok(['a', 'c'].includes(result[2]!.address))
    assert.ok(['a', 'c'].includes(result[3]!.address))
  })

  it('sorts purely by score when all transacted today', () => {
    const wallets = [{ address: 'a' }, { address: 'b' }]
    const scores: Record<string, number> = { a: 90, b: 10 }
    const result = prioritizeWallets(wallets, () => true, (addr) => scores[addr] ?? 0)
    assert.deepEqual(result.map(w => w.address), ['b', 'a'])
  })

  it('does not mutate the input array', () => {
    const wallets = [{ address: 'a' }, { address: 'b' }]
    prioritizeWallets(wallets, () => false, () => 0)
    assert.deepEqual(wallets.map(w => w.address), ['a', 'b'])
  })
})

describe('parseApiResponse', () => {
  const SEASON = 11
  const LIMIT = 81

  it('returns 0/limit for empty array', () => {
    assert.deepEqual(parseApiResponse([], SEASON, LIMIT), { count: 0, max: LIMIT })
  })

  it('returns 0/limit for non-array input', () => {
    assert.deepEqual(parseApiResponse(null, SEASON, LIMIT), { count: 0, max: LIMIT })
    assert.deepEqual(parseApiResponse({ totalScore: 50 }, SEASON, LIMIT), { count: 0, max: LIMIT })
    assert.deepEqual(parseApiResponse('oops', SEASON, LIMIT), { count: 0, max: LIMIT })
  })

  it('extracts totalScore for the current season', () => {
    const data = [
      { season: 10, totalScore: 40 },
      { season: 11, totalScore: 73 }
    ]
    assert.deepEqual(parseApiResponse(data, SEASON, LIMIT), { count: 73, max: LIMIT })
  })

  it('returns 0 when current season is missing', () => {
    const data = [{ season: 9, totalScore: 99 }, { season: 10, totalScore: 88 }]
    assert.deepEqual(parseApiResponse(data, SEASON, LIMIT), { count: 0, max: LIMIT })
  })

  it('tolerates missing/garbage fields', () => {
    const data = [{ season: 11 }, { foo: 'bar' }, null]
    assert.deepEqual(parseApiResponse(data, SEASON, LIMIT), { count: 0, max: LIMIT })
  })

  it('ignores non-numeric totalScore', () => {
    const data = [{ season: 11, totalScore: '73' }]
    assert.deepEqual(parseApiResponse(data, SEASON, LIMIT), { count: 0, max: LIMIT })
  })
})
