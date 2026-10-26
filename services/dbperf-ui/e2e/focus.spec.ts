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
  const filters = page.getByRole('region', {name:'Фильтры дашборда', exact:true})
  const overview = (await page.locator('.overview-block').boundingBox())!
  const detail = (await page.locator('.detail-block').boundingBox())!
  const filterBounds = (await filters.boundingBox())!
  expect(filterBounds.y).toBeGreaterThanOrEqual(overview.y + overview.height)
  expect(filterBounds.y + filterBounds.height).toBeLessThanOrEqual(detail.y)
  await cpu.click()
  await expect(filters).toContainText('Легенда: CPU')
  await expect(cpu).toHaveAttribute('aria-pressed', 'true')
  await cpu.click()
  await expect(cpu).toHaveAttribute('aria-pressed', 'false')
  await expect(filters).toContainText('Без фильтров')
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
test('flame graph lists queries and opens the query dialog', async ({ page }) => {
  await fixture(page)
  const nodes = page.locator('.flame-node[data-depth="1"]')
  await expect(nodes.first()).toBeVisible()
  expect(await nodes.count()).toBeGreaterThan(1)
  await nodes.first().click()
  await expect(page.locator('.flame-node[data-depth="1"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Текст запроса' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})
for (const size of [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 840 },
  { width: 1440, height: 900 },
  { width: 1440, height: 960 },
  { width: 1440, height: 961 },
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
      path: `test-results/focus-${size.width}x${size.height}.png`,
      fullPage: true,
    })
    expect(await page.locator('.focus-table-head .tabs').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(page.locator('.period-context, .analysis-caption')).toHaveCount(0)
    const chartBounds = (await page.locator('.focus-charts').boundingBox())!
    const tableBounds = (await page.locator('.focus-table').boundingBox())!
    expect(tableBounds.y - chartBounds.y - chartBounds.height).toBeGreaterThanOrEqual(0)
    expect(tableBounds.y - chartBounds.y - chartBounds.height).toBeLessThanOrEqual(16)
    if (size.width >= 1024) {
      const bounds = tableBounds
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height)
      expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(size.height - 35)
    }
    await page.screenshot({
      path: `test-results/focus-${size.width}x${size.height}.png`,
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

test('mobile flame graph fits the viewport without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await expect(page.locator('.flame-node[data-depth="1"]').first()).toBeVisible()
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

test('smooth and snapshot modes update both charts while preserving windows and requests', async ({page}) => {
  const requests = await fixture(page)
  await page.goto('/#/t/1/activity')
  await expect(page.locator('.detail-plot .series-area').first()).toBeVisible()
  const paths = () => page.locator('.focus-plot svg > path:last-of-type').evaluateAll(elements => elements.map(e => e.getAttribute('d')))
  const windows = () => page.locator('.brush-window').evaluateAll(elements => elements.map(e => e.getAttribute('style')))
  const smooth = await paths(), selected = await windows()
  const count = requests.filter(r => r.path.endsWith('/timeseries')).length
  await expect(page.getByRole('button',{name:'Плавно',exact:true})).toHaveAttribute('aria-pressed','true')
  await page.getByRole('button',{name:'По снимкам',exact:true}).click()
  expect((await paths()).every(p => p?.includes(' H'))).toBe(true)
  await page.getByRole('button',{name:'Плавно',exact:true}).click()
  expect(await paths()).toEqual(smooth)
  expect(await windows()).toEqual(selected)
  expect(requests.filter(r => r.path.endsWith('/timeseries')).length).toBe(count)
})

test('compact header places PostgreSQL at the right and centers select chevrons', async ({page}) => {
  await fixture(page)
  await expect(page.locator('.focus-heading')).toHaveCount(0)
  await expect(page.locator('.topbar').locator('.focus-badge')).toHaveText('PostgreSQL 16')
  await expect(page.locator('.topbar')).not.toContainText('тик')
  const offsets = await page.locator('button > .select-chevron').evaluateAll(icons => icons.map(icon => {
    const svg = icon.getBoundingClientRect(), button = icon.parentElement!.getBoundingClientRect()
    return Math.abs(svg.y + svg.height / 2 - button.y - button.height / 2)
  }))
  expect(offsets.length).toBeGreaterThanOrEqual(4)
  expect(offsets.every(offset => offset < 1)).toBe(true)
})

test('dimension and refresh selectors retain widths and refresh stays with the right actions', async ({page}) => {
  await fixture(page)
  const dimension = page.getByRole('button', {name:'Разрез графиков',exact:true})
  const refresh = page.getByRole('button', {name:'Автообновление',exact:true})
  const positions = async () => ({dimension:(await dimension.boundingBox())!,refresh:(await refresh.boundingBox())!, actions:(await page.locator('.focus-actions').boundingBox())!})
  const initial = await positions()
  for (const label of ['SQL','Базы данных','Типы ожиданий']) {
    await dimension.click()
    await page.getByRole('option',{name:label,exact:true}).click()
    const current = await positions()
    expect(current.dimension.width).toBe(initial.dimension.width)
    expect(current.refresh.x).toBe(initial.refresh.x)
  }
  for (const label of ['Обновление выкл.','Каждую минуту','Каждые 10 с']) {
    await refresh.click()
    await page.getByRole('option',{name:label,exact:true}).click()
    const current = await positions()
    expect(current.refresh.width).toBe(initial.refresh.width)
    expect(current.actions.x).toBe(initial.actions.x)
  }
  const controls = (await page.locator('.focus-controls').boundingBox())!
  expect(initial.actions.x + initial.actions.width).toBeCloseTo(controls.x + controls.width, 0)
})

test('chart loaders preserve plots while cards and table show skeletons in both themes', async ({page}) => {
  // Crossing a real second used to shift the retained plot while refreshing.
  await page.clock.setFixedTime(new Date('2026-10-26T12:00:00Z'))
  await fixture(page)
  await expect(page.locator('.focus-charts')).toHaveAttribute('aria-busy','false')
  await expect.poll(() => page.locator('.focus-plot').evaluateAll(plots => plots.every(plot => {
    const bounds = plot.getBoundingClientRect(), box = plot.querySelector('svg')!.viewBox.baseVal
    return Math.abs(box.width - bounds.width) < .5 && Math.abs(box.height - bounds.height) < .5
  }))).toBe(true)
  await page.emulateMedia({reducedMotion:'reduce'})
  let release!: () => void
  const gate = new Promise<void>(resolve => {release=resolve})
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (['/timeseries','/totals','/targets/status','/top'].some(suffix=>path.endsWith(suffix))) await gate
    if (path.endsWith('/top')) {
      await route.fulfill({json:{totalAas:9,nSamples:2,level:'raw',matchedRows:1,entries:[{slice:{value:'Refreshed',shortText:'',id:0,isRemainder:false},aas:9,percent:100,sub:[]}]}})
      return
    }
    await route.fallback()
  })
  const oldPath = await page.locator('.detail-plot .chart-total-line').getAttribute('d')
  await page.clock.setFixedTime(new Date('2026-10-26T12:00:01Z'))
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
  const loading = page.getByRole('status',{name:'Анализ: загрузка данных'})
  await expect(loading).toBeVisible()
  await expect(page.locator('.focus-plot .loading-skeleton')).toHaveCount(0)
  await expect(page.getByRole('img',{name:'Анализ',exact:true})).toBeVisible()
  await expect(page.locator('.detail-plot .chart-total-line')).toHaveAttribute('d',oldPath!)
  await expect(page.locator('.focus-summary .loading-skeleton')).toHaveCount(8)
  await expect(page.getByText('Нет снимков за выбранный период')).toHaveCount(0)
  await expect(page.getByRole('status',{name:'Загрузка таблицы',exact:true})).toBeAttached()
  await expect(page.locator('.table-skeleton-row')).toHaveCount(8)
  await expect(page.locator('.focus-table tbody .bar')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Следующая страница',exact:true})).toBeDisabled()
  const before = await page.locator('.focus-charts').boundingBox()
  await page.screenshot({path:'test-results/loading-dark.png',fullPage:true})
  await page.getByRole('button',{name:'Светлая',exact:true}).click()
  await expect(loading).toBeVisible()
  await page.screenshot({path:'test-results/loading-light.png',fullPage:true})
  release()
  await expect(loading).toHaveCount(0)
  await expect(page.locator('.focus-summary .loading-skeleton')).toHaveCount(0)
  await expect(page.locator('.table-skeleton-row')).toHaveCount(0)
  await expect(page.locator('.focus-table tbody')).toContainText('Refreshed')
  await expect(page.getByRole('status',{name:'Загрузка таблицы',exact:true})).toHaveCount(0)
  expect(await page.locator('.focus-charts').boundingBox()).toEqual(before)
})

test('both chart tooltips follow the pointer, show series and keep the panel on screen', async ({page}) => {
  await fixture(page)
  for (const selector of ['.overview-plot','.detail-plot']) {
    const plot = page.locator(selector), bounds = (await plot.boundingBox())!
    const tooltip = plot.getByRole('tooltip')
    await page.mouse.move(bounds.x + 150, bounds.y + 20)
    await expect(tooltip).toBeVisible()
    await expect(tooltip.locator('.tooltip-series-row')).toHaveCount(3)
    await expect(tooltip).toContainText('CPU')
    await expect(tooltip).toContainText('IO')
    await expect(tooltip).toContainText('Всего')
    await expect(tooltip.locator('.tooltip-swatch')).toHaveCount(3)
    const crosshair = plot.locator('.chart-crosshair')
    await expect(crosshair).toBeAttached()
    expect(Number(await crosshair.getAttribute('y2'))).toBeGreaterThan(Number(await crosshair.getAttribute('y1')))
    const firstX = Number(await crosshair.getAttribute('x1'))
    const first = (await tooltip.boundingBox())!
    await page.mouse.move(bounds.x + 350, bounds.y + 40)
    await expect.poll(async () => (await tooltip.boundingBox())!.x).toBeGreaterThan(first.x + 100)
    await expect.poll(async () => Number(await crosshair.getAttribute('x1'))).toBeGreaterThan(firstX)
    for (const point of [{x:bounds.x+40,y:bounds.y+9},{x:bounds.x+bounds.width-14,y:bounds.y+bounds.height-26}]) {
      await page.mouse.move(point.x,point.y)
      await expect(tooltip).toBeVisible()
      await expect.poll(async () => {
        const tip = (await tooltip.boundingBox())!
        const viewport = page.viewportSize()!
        return tip.x >= bounds.x && tip.y >= 0 && tip.x + tip.width <= bounds.x + bounds.width && tip.y + tip.height <= viewport.height
      }).toBe(true)
    }
    await page.mouse.move(bounds.x + 400,bounds.y + 20)
    await page.screenshot({path:`test-results/tooltip-${selector.slice(1)}.png`,fullPage:true})
    await page.mouse.move(0,0)
    await expect(tooltip).toHaveCount(0)
    await expect(crosshair).toHaveCount(0)
  }
})

test('chart tooltip uses project surfaces and contrasting crosshairs with arrow cursors in both themes', async ({page}) => {
  await fixture(page)
  for (const theme of [{name:'Тёмная',dark:true},{name:'Светлая',dark:false}]) {
    await page.getByRole('button',{name:theme.name,exact:true}).click()
    for (const selector of ['.overview-plot','.detail-plot']) {
      const plot=page.locator(selector),bounds=(await plot.boundingBox())!
      await page.mouse.move(bounds.x+300,bounds.y+20)
      const tooltip=plot.getByRole('tooltip')
      await expect(tooltip).toBeVisible()
      const appearance=await tooltip.evaluate(el=>{
        const style=getComputedStyle(el),root=getComputedStyle(document.documentElement)
        const stroke=getComputedStyle(el.closest('.focus-plot')!.querySelector('.chart-crosshair')!).stroke
        return {background:style.backgroundColor,text:style.color,border:style.borderTopStyle,expectedSurface:root.getPropertyValue('--surface-raised').trim(),stroke}
      })
      const channels=appearance.stroke.match(/[\d.]+/g)!.map(Number)
      expect(channels.slice(0,3).reduce((sum,n)=>sum+n,0)/3 > 128).toBe(theme.dark)
      const surfaceRGB = `rgb(${appearance.expectedSurface.match(/[0-9a-f]{2}/gi)!.map(hex=>parseInt(hex,16)).join(', ')})`
      expect(appearance.background).toBe(surfaceRGB)
      expect(appearance.background).not.toBe(appearance.text)
      expect(appearance.border).toBe('solid')
      await expect(plot.locator('.brush-track')).toHaveCSS('cursor','default')
      await expect(plot.locator('.brush-window')).toHaveCSS('cursor','default')
      await expect(plot.locator('.brush-handle').first()).toHaveCSS('cursor','default')
    }
    await page.screenshot({path:`test-results/tooltip-theme-${theme.dark?'dark':'light'}.png`,fullPage:true})
  }
})
