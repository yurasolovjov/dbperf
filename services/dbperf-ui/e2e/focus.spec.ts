import { test, expect, type Page } from '@playwright/test'
const queries = Array.from({ length: 80 }, (_, i) => ({
  hash: String(BigInt('18446744073709550000') + BigInt(i)),
  sql: `SELECT customer_id, total FROM orders WHERE region_id = ${i}`,
}))
async function fixture(page: Page) {
  const requests: { path: string; body: any }[] = []
  const target = {
    targetId: 1,
    name: 'pgbench-main',
    intervalSec: 10,
    enabled: true,
    labels: {},
    dsn: '',
    revision: 1,
  }
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      body = route.request().postDataJSON()
    requests.push({ path, body })
    let data: any = {}
    if (path.endsWith('/targets/list')) data = { targets: [target] }
    else if (path.endsWith('/assignments'))
      data = { instances: [], unassigned: [1] }
    else if (path.endsWith('/targets/status'))
      data = {
        ...target,
        state: 'CONNECTED',
        serverVersionNum: 160000,
        lastSampleAt: Math.floor(Date.now() / 1000),
      }
    else if (path.endsWith('/timeseries') || path.endsWith('/totals')) {
      const { startUnix: start, endUnix: end } = body.range
      const timestamps = Array.from({ length: 61 }, (_, i) =>
        Math.floor(start + (i * (end - start)) / 61),
      )
      const cpu = timestamps.map(
          (_: number, i: number) => 2 + Math.sin(i * 0.3),
        ),
        io = timestamps.map(
          (_: number, i: number) => 0.6 + Math.cos(i * 0.4) * 0.4,
        )
      const totals = cpu.map((n: number, i: number) => n + io[i])
      const slice = (value: string, id: number) => ({
        value,
        id,
        isRemainder: false,
        shortText: '',
      })
      data = {
        range: body.range,
        timestamps,
        stepSeconds: Math.ceil((end - start) / 61),
        level: end - start > 7200 ? '1m' : 'raw',
        totals,
        values: totals,
        average: 2.6,
        series: [
          { slice: slice('CPU', 1), values: cpu, average: 2 },
          { slice: slice('IO', 2), values: io, average: 0.6 },
        ],
      }
    } else if (path.endsWith('/top')) {
      const isQuery = body.slicing.dimension === 'QUERY'
      const names = isQuery
        ? queries.map((q) => q.hash)
        : [
            'CPU',
            'IO',
            'Lock',
            'Client',
            'LWLock',
            'IPC',
            'Timeout',
            'Activity',
            'Extension',
          ]
      data = {
        totalAas: 7.85,
        nSamples: 30,
        matchedRows: names.length,
        level: 'raw',
        entries: names
          .slice(body.offset, body.offset + body.pageSize)
          .map((value, i) => ({
            slice: {
              value,
              shortText: isQuery
                ? queries.find((q) => q.hash === value)!.sql
                : '',
              isRemainder: false,
              id: i + 1,
            },
            aas: 3 / (i + 1),
            percent: 38 / (i + 1),
            sub: [
              {
                slice: { value: 'CPU', isRemainder: false },
                aas: 2,
                percent: 70,
              },
              {
                slice: { value: 'IO', isRemainder: false },
                aas: 1,
                percent: 30,
              },
            ],
          })),
      }
    } else if (path.endsWith('/profile')) {
      const dims = body.dimensions
      data = {
        nSamples: 30,
        totalSamples: 200,
        level: 'raw',
        queryShortTexts: Object.fromEntries(
          queries.map((q) => [q.hash, q.sql]),
        ),
        paths: queries.map((q, i) => ({
          values: dims.map((d: string) =>
            d === 'QUERY'
              ? q.hash
              : d === 'DATNAME'
                ? 'pgbench'
                : d === 'WAIT_EVENT_TYPE'
                  ? 'CPU'
                  : d === 'WAIT_EVENT'
                    ? 'CPU'
                    : 'web',
          ),
          samples: i === 0 ? 121 : 1,
        })),
      }
    } else if (path.endsWith('/query-text'))
      data = {
        query:
          queries.find((q) => q.hash === body.queryHash)?.sql ?? 'SELECT 1',
        lastSeen: Math.floor(Date.now() / 1000),
        truncated: false,
      }
    await route.fulfill({ status: 200, json: data })
  })
  await page.goto('/#/t/1/activity')
  await expect(
    page.getByRole('region', { name: 'Таблица активности' }),
  ).toHaveAttribute('aria-busy', 'false')
  await page
    .getByRole('button', { name: 'Автообновление', exact: true })
    .click()
  await page.getByRole('option', { name: 'Обновление выкл.' }).click()
  return requests
}
test('custom seconds apply and manual refresh re-fetches fixed intervals', async ({
  page,
}) => {
  const requests = await fixture(page)
  await page.getByRole('button', { name: /Произвольный/ }).click()
  await page.getByLabel('Начало', { exact: true }).fill('2026-10-25T12:00:30')
  await page.getByLabel('Конец', { exact: true }).fill('2026-10-25T12:15:30')
  await page.getByRole('button', { name: 'Применить период' }).click()
  await expect
    .poll(() =>
      requests.some(
        (r) =>
          r.path.endsWith('/timeseries') &&
          r.body.range.startUnix ===
            Date.parse('2026-10-25T12:00:30+03:00') / 1000,
      ),
    )
    .toBe(true)
  const count = requests.filter((r) => r.path.endsWith('/top')).length
  await page.getByRole('button', { name: 'Обновить данные' }).click()
  await expect
    .poll(() => requests.filter((r) => r.path.endsWith('/top')).length)
    .toBeGreaterThan(count)
})
test('legend repeat click resets it and SQL hashes remain strings', async ({
  page,
}) => {
  const requests = await fixture(page)
  const cpu = page.getByRole('button', { name: 'CPU', exact: true })
  await cpu.click()
  await expect(cpu).toHaveAttribute('aria-pressed', 'true')
  await cpu.click()
  await expect(cpu).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('tab', { name: 'SQL', exact: true }).click()
  await page.locator('.query-link').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.sql')).toContainText('SELECT customer_id')
  await page
    .getByRole('button', { name: 'Добавить в фильтры', exact: true })
    .click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect
    .poll(() =>
      requests
        .filter((r) => r.path.endsWith('/top'))
        .at(-1)
        ?.body.filters.some(
          (f: any) =>
            f.dimension === 'QUERY' && f.values[0] === queries[0].hash,
        ),
    )
    .toBe(true)
})
test('column filters survive tabs and units and are sent to the backend', async ({
  page,
}) => {
  const requests = await fixture(page)
  await page.getByRole('tab', { name: 'SQL', exact: true }).click()
  await page
    .getByRole('button', { name: 'Фильтр: Текст запроса', exact: true })
    .click()
  await page.getByLabel('Значение', { exact: true }).fill('orders')
  await page.getByRole('button', { name: 'Применить фильтр' }).click()
  await expect
    .poll(
      () =>
        requests.filter((r) => r.path.endsWith('/top')).at(-1)?.body
          .tableFilters[0]?.values[0],
    )
    .toBe('orders')
  await page.getByRole('tab', { name: 'Хосты', exact: true }).click()
  await page.getByRole('button', { name: 'AAS', exact: true }).click()
  await expect(page.locator('.table-filter-bar')).toContainText('orders')
  expect(
    requests.filter((r) => r.path.endsWith('/top')).at(-1)?.body.tableFilters[0]
      .dimension,
  ).toBe('QUERY')
  await page.getByRole('button', { name: 'Фильтр: AAS', exact: true }).click()
  await page.getByLabel('От', { exact: true }).fill('1.5')
  await page.getByRole('button', { name: 'Применить фильтр' }).click()
  await expect
    .poll(
      () =>
        requests.filter((r) => r.path.endsWith('/top')).at(-1)?.body.aas?.min,
    )
    .toBe(1.5)
})
test('both chart windows move and resize independently', async ({ page }) => {
  const requests = await fixture(page)
  const overview = page.getByRole('group', {
    name: 'Обзор: переместить окно',
    exact: true,
  })
  await overview.focus()
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(
      () =>
        requests.filter((r) => r.path.endsWith('/top')).at(-1)?.body.range
          .startUnix,
    )
    .toBeLessThan(
      requests.find((r) => r.path.endsWith('/top'))!.body.range.startUnix,
    )
  const beforeAnalysis = requests.filter((r) => r.path.endsWith('/top')).at(-1)!
    .body.range.startUnix
  const analysis = page.getByRole('button', {
    name: 'Анализ: начало окна',
    exact: true,
  })
  await analysis.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(
      () =>
        requests.filter((r) => r.path.endsWith('/top')).at(-1)?.body.range
          .startUnix,
    )
    .toBeGreaterThan(beforeAnalysis)
  const handle = page.getByRole('button', {
    name: 'Обзор: начало окна',
    exact: true,
  })
  const box = (await handle.boundingBox())!
  const original = requests.filter((r) => r.path.endsWith('/timeseries')).length
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 50, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(() => requests.filter((r) => r.path.endsWith('/timeseries')).length)
    .toBeGreaterThan(original)
})
test('fullscreen includes the table and custom popover; Escape exits', async ({
  page,
}) => {
  await fixture(page)
  await page
    .getByRole('button', { name: 'Весь дашборд на полный экран' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Выйти из полного экрана' }),
  ).toBeVisible()
  await expect(page.locator('.focus-dashboard .focus-table')).toBeVisible()
  await page.getByRole('button', { name: /Произвольный/ }).click()
  await expect(
    page.getByRole('button', { name: 'Применить период' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await page.keyboard.press('Escape')
  // Native fullscreen exit is browser-controlled; fallback follows the same Escape path.
  if (await page.evaluate(() => !!document.fullscreenElement))
    await page.evaluate(() => document.exitFullscreen())
  await expect(
    page.getByRole('button', { name: 'Весь дашборд на полный экран' }),
  ).toBeVisible()
})
test('profile SQL cards wrap and open the query dialog', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: 'Профиль', exact: true }).click()
  await expect(page.locator('.profile-query-row .profile-node')).toHaveCount(80)
  const boxes = await page
    .locator('.profile-query-row .profile-node')
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect()
        return { width: r.width, top: r.top }
      }),
    )
  expect(Math.min(...boxes.map((b) => b.width))).toBeGreaterThanOrEqual(180)
  expect(new Set(boxes.map((b) => b.top)).size).toBeGreaterThan(1)
  await page.locator('.profile-node-main').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})
for (const size of [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
])
  test(`responsive ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await fixture(page)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: `test-results/focus-${size.width}.png`,
      fullPage: true,
    })
    if (size.width >= 1024) {
      const bounds = (await page.locator('.focus-table').boundingBox())!
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height)
    }
    await page.screenshot({
      path: `test-results/focus-${size.width}.png`,
      fullPage: true,
    })
  })

test('SQL copy and empty/error states recover through refresh', async ({
  page,
  context,
}) => {
  await fixture(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('tab', { name: 'SQL', exact: true }).click()
  await page.locator('.query-link').first().click()
  await page.getByRole('button', { name: 'Скопировать', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Запрос скопирован' }),
  ).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    queries[0].sql,
  )
  await page.getByRole('button', { name: 'Закрыть запрос' }).click()
  await page.route('**/activity/top', (route) =>
    route.fulfill({ status: 500, json: { error: 'Тестовый отказ сервера' } }),
  )
  await page.getByRole('button', { name: 'Обновить данные' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Тестовый отказ сервера' }),
  ).toBeVisible()
  await page.unroute('**/activity/top')
  await page.getByRole('button', { name: 'Обновить данные' }).click()
  await expect(page.locator('.query-link').first()).toBeVisible()
  await page.route('**/activity/top', (route) =>
    route.fulfill({
      json: {
        totalAas: 0,
        nSamples: 0,
        matchedRows: 0,
        level: 'raw',
        entries: [],
      },
    }),
  )
  await page.getByRole('button', { name: 'Обновить данные' }).click()
  await expect(
    page.getByText('Нет значений за этот интервал с выбранными фильтрами'),
  ).toBeVisible()
})

test('live stack: server-side SQL filter, cross-tab reuse and query modal', async ({
  page,
}) => {
  test.skip(!process.env.DBPERF_LIVE, 'Requires the local compose stack')
  await page.goto('/#/t/2/activity?dim=QUERY')
  await page
    .getByRole('button', { name: 'Автообновление', exact: true })
    .click()
  await page.getByRole('option', { name: 'Обновление выкл.' }).click()
  await page.getByRole('tab', { name: 'SQL', exact: true }).click()
  await expect(page.locator('.query-link').first()).toBeVisible({
    timeout: 30000,
  })
  await page
    .getByRole('button', { name: 'Фильтр: Текст запроса', exact: true })
    .click()
  await page.getByLabel('Значение', { exact: true }).fill('pgbench_accounts')
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith('/activity/top') &&
      r.request().postDataJSON().tableFilters?.length,
  )
  await page.getByRole('button', { name: 'Применить фильтр' }).click()
  const filtered = await (await response).json()
  expect(Number(filtered.matchedRows)).toBeGreaterThan(0)
  expect(
    filtered.entries.every((e: any) =>
      e.slice.shortText.toLowerCase().includes('pgbench_accounts'),
    ),
  ).toBe(true)
  await page.locator('.query-link').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.sql')).toContainText('pgbench_accounts')
  await page.getByRole('button', { name: 'Закрыть запрос' }).click()
  const crossResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith('/activity/top') &&
      r.request().postDataJSON().slicing.dimension === 'DATNAME',
  )
  await page.getByRole('tab', { name: 'Базы данных', exact: true }).click()
  const cross = await (await crossResponse).json()
  expect(cross.entries[0].slice.value).toBe('pgbench')
  await expect(page.locator('.table-filter-bar')).toContainText(
    'pgbench_accounts',
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/focus-live.png', fullPage: true })
})

test('mobile profile keeps readable SQL cards without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await page.getByRole('button', { name: 'Профиль', exact: true }).click()
  await expect(page.locator('.profile-node')).toHaveCount(80)
  const bounds = await page
    .locator('.profile-node')
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().width))
  expect(Math.min(...bounds)).toBeGreaterThanOrEqual(180)
  expect(Math.max(...bounds)).toBeLessThanOrEqual(390)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('column popovers stay visible above an empty table and inside fullscreen', async ({
  page,
}) => {
  const requests = await fixture(page)
  await page.route('**/activity/top', (route) =>
    route.fulfill({
      json: {
        totalAas: 0,
        nSamples: 0,
        matchedRows: 0,
        level: 'raw',
        entries: [],
      },
    }),
  )
  await page.getByRole('button', { name: 'Обновить данные' }).click()
  await expect(
    page.getByText('Нет значений за этот интервал с выбранными фильтрами'),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Фильтр: Тип ожидания', exact: true })
    .click()
  await page.getByRole('button', { name: 'Условие', exact: true }).click()
  await page.getByRole('option', { name: 'Не содержит', exact: true }).click()
  await page.getByLabel('Значение', { exact: true }).fill('Lock')
  await page.getByRole('button', { name: 'Применить фильтр' }).click()
  await expect(page.locator('.table-filter-bar')).toContainText(
    'не содержит Lock',
  )
  await page
    .getByRole('button', { name: 'Весь дашборд на полный экран' })
    .click()
  await page.getByRole('button', { name: 'Фильтр: AAS', exact: true }).click()
  await page.getByLabel('От', { exact: true }).fill('0')
  const button = page.getByRole('button', { name: 'Применить фильтр' })
  await expect(button).toBeInViewport()
  await button.click()
  // The fixture override intentionally returns zero rows; the UI still preserves zero as a real bound.
  await expect(page.locator('.table-filter-bar')).toContainText('AAS: 0')
  expect(requests.some((r) => r.path.endsWith('/top'))).toBe(true)
})
