import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'
afterEach(() => vi.unstubAllGlobals())
it('sends SQL filters, aggregate bounds and pagination as a single server query', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          totalAas: 1,
          nSamples: '12',
          matchedRows: '42',
          level: 'raw',
          entries: [
            {
              slice: { value: '18446744073709551615' },
              aas: 1,
              percent: 100,
              sub: [],
            },
          ],
        }),
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  const params = {
    targetId: 1,
    range: { startUnix: 10, endUnix: 30 },
    slicing: { dimension: 'QUERY' as const, limit: 8 },
    filters: [],
    tableFilters: [
      {
        dimension: 'QUERY' as const,
        values: ['orders'],
        match: 'MATCH_CONTAINS' as const,
      },
    ],
    aas: { min: 0 },
    percent: { max: 50 },
    pageSize: 8,
    offset: 8,
    excludeSelf: true,
  }
  const result = await api.top(params)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(params)
  expect(result.matchedRows).toBe(42)
  expect(result.nSamples).toBe(12)
  expect(result.entries[0].slice.value).toBe('18446744073709551615')
})
it('preserves query hashes and passes cancellation to fetch', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response('{"query":"SELECT 1","lastSeen":"12","truncated":false}'),
    )
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  const result = await api.queryText(
    1,
    '18446744073709551615',
    controller.signal,
  )
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).queryHash).toBe(
    '18446744073709551615',
  )
  expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  expect(result.lastSeen).toBe(12)
})
it('reports structured and plain server errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"invalid filter"}', { status: 400 }),
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 })),
  )
  await expect(api.queryText(1, '1')).rejects.toMatchObject({
    status: 400,
    message: 'invalid filter',
  })
  await expect(api.queryText(1, '1')).rejects.toBeInstanceOf(ApiError)
})
