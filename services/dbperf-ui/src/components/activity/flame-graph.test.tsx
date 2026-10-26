import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { profile } from '../../test/fixtures'
import { FlameGraph } from './flame-graph'
import { buildTree, collapse, find, layout, nodeLabel, searchMatches, waitTypeOf } from './flame-model'

const dims = ['QUERY', 'DATNAME', 'WAIT_EVENT_TYPE', 'WAIT_EVENT'] as const

it('builds the tree with sorted children and lays boxes out by share', () => {
  const root = buildTree(profile)
  expect(root.samples).toBe(6)
  expect(root.children.map((c) => [c.value, c.samples])).toEqual([['123', 3], ['456', 2]])
  const boxes = layout(root)
  expect(boxes[0]).toMatchObject({ left: 0, width: 1 })
  expect(boxes.find((b) => b.node.value === '456')).toMatchObject({ left: 0.5, width: 1 / 3 })
  expect(waitTypeOf(find(root, ['456', 'prod', 'IO', 'IO.Read'])!, [...dims])).toBe('IO')
  expect(waitTypeOf(find(root, ['456'])!, [...dims])).toBeNull()
  expect(nodeLabel(find(root, ['123'])!, [...dims], profile.queryShortTexts)).toBe('SELECT orders')
  expect(nodeLabel(find(root, ['456'])!, [...dims], profile.queryShortTexts)).toBe('#456')
})

it('collapses narrow siblings into one remainder per parent', () => {
  const data = { ...profile, totalSamples: 100, paths: [
    { values: ['a', 'x'], samples: 90 },
    { values: ['b', 'x'], samples: 5 },
    { values: ['c', 'x'], samples: 3 },
    { values: ['d', 'x'], samples: 2 },
  ] }
  const folded = collapse(buildTree(data), 4)
  expect(folded.children.map((c) => [c.remainder, c.samples])).toEqual([[false, 90], [false, 5], [true, 5]])
  expect(layout(folded).filter((b) => b.node.remainder)).toHaveLength(1)
})

it('search returns matching nodes without their matching descendants', () => {
  const root = buildTree(profile)
  const label = (n: Parameters<typeof nodeLabel>[0]) => nodeLabel(n, [...dims], profile.queryShortTexts)
  expect(searchMatches(root, 'cpu', label).map((n) => n.depth)).toEqual([3])
  expect(searchMatches(root, 'orders', label).map((n) => n.value)).toEqual(['123'])
  expect(searchMatches(root, '', label)).toEqual([])
})

it('selects, filters, opens SQL, zooms by double click and resets with Escape', () => {
  const onFilter = vi.fn(), onQuery = vi.fn()
  const { container } = render(<FlameGraph data={profile} dimensions={[...dims]} onFilter={onFilter} onQuery={onQuery} />)
  expect(container.querySelectorAll('.flame-node')).toHaveLength(9)
  fireEvent.click(screen.getByRole('button', { name: 'SELECT orders: 50.0 %' }))
  expect(screen.getByRole('complementary', { name: 'Выбранный узел' })).toHaveTextContent('50 % внутри корня')
  fireEvent.click(screen.getByRole('button', { name: 'Текст запроса' }))
  expect(onQuery).toHaveBeenCalledWith('123')
  fireEvent.click(screen.getByRole('button', { name: 'В фильтр дашборда' }))
  expect(onFilter).toHaveBeenCalledWith('QUERY', '123')
  fireEvent.click(screen.getByRole('button', { name: 'Сделать корнем' }))
  expect(container.querySelectorAll('.flame-node[data-depth="1"]')).toHaveLength(1)
  expect(screen.getByText(/корень 50\.0 %/)).toBeInTheDocument()
  fireEvent.dblClick(screen.getByRole('button', { name: 'prod: 50.0 %' }))
  expect(screen.getByText(/корень 50\.0 %, 1\.00 AAS/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Вся активность' }))
  expect(container.querySelectorAll('.flame-node[data-depth="1"]')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'IO.Read: 33.3 %' }))
  fireEvent.click(screen.getByRole('button', { name: 'В фильтр дашборда' }))
  expect(onFilter).toHaveBeenLastCalledWith('WAIT_EVENT', 'IO.Read')
  fireEvent.keyDown(container.querySelector('.flame-view')!, { key: 'Escape' })
  expect(screen.getByRole('complementary', { name: 'Выбранный узел' })).toHaveTextContent('Вся активность')
})

it('highlights search matches, folds narrow nodes and shows hover details', () => {
  const wide = { ...profile, totalSamples: 1000, nSamples: 100, paths: [
    { values: ['123', 'prod', 'CPU', 'CPU'], samples: 995 },
    { values: ['456', 'prod', 'IO', 'IO.Read'], samples: 5 },
  ] }
  const { container } = render(<FlameGraph data={wide} dimensions={[...dims]} onFilter={vi.fn()} onQuery={vi.fn()} />)
  expect(container.querySelectorAll('.flame-node.rest')).toHaveLength(1)
  fireEvent.click(screen.getByLabelText(/свернуть/))
  expect(container.querySelectorAll('.flame-node.rest')).toHaveLength(0)
  fireEvent.change(screen.getByPlaceholderText('Поиск по узлам'), { target: { value: 'io' } })
  expect(container.querySelectorAll('.flame-node.match')).toHaveLength(1)
  expect(screen.getByText(/1 узл\. · 0\.5 %/)).toBeInTheDocument()
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'SELECT orders: 99.5 %' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('99.5 % · 9.95 AAS · 995 снимков')
  fireEvent.mouseLeave(container.querySelector('.flame-plot')!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('shows empty and loading states and the uncovered share', () => {
  const { rerender } = render(<FlameGraph data={null} dimensions={[...dims]} onFilter={vi.fn()} onQuery={vi.fn()} loading />)
  expect(screen.getByText(/Загрузка профиля/)).toBeInTheDocument()
  rerender(<FlameGraph data={{ ...profile, totalSamples: 0, paths: [] }} dimensions={[...dims]} onFilter={vi.fn()} onQuery={vi.fn()} />)
  expect(screen.getByText(/Нет активности/)).toBeInTheDocument()
  rerender(<FlameGraph data={profile} dimensions={[...dims]} onFilter={vi.fn()} onQuery={vi.fn()} />)
  expect(screen.getByText(/За пределами выдачи профиля: 16\.7 %/)).toBeInTheDocument()
})
