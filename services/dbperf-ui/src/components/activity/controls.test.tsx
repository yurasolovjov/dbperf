import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { Controls } from '../Controls'
import { DesignedSelect } from './designed-select'
it('applies a custom period containing seconds through the real form', async () => {
  const onPeriod = vi.fn(),
    user = userEvent.setup()
  render(
    <Controls
      period={{ seconds: 900 }}
      onPeriod={onPeriod}
      dimension="QUERY"
      onDimension={vi.fn()}
      refresh={0}
      onRefresh={vi.fn()}
      onReload={vi.fn()}
      loading={false}
    />,
  )
  await user.click(screen.getByRole('button', { name: /Произвольный/ }))
  fireEvent.change(screen.getByLabelText('Начало'), {
    target: { value: '2026-10-25T12:00:30' },
  })
  fireEvent.change(screen.getByLabelText('Конец'), {
    target: { value: '2026-10-25T12:05:30' },
  })
  await user.click(screen.getByRole('button', { name: 'Применить период' }))
  expect(onPeriod).toHaveBeenCalledWith({
    seconds: 0,
    start: Date.parse('2026-10-25T12:00:30+03:00') / 1000,
    end: Date.parse('2026-10-25T12:05:30+03:00') / 1000,
  })
  expect(screen.queryByRole('form')).not.toBeInTheDocument()
})
it('selects a designed option by keyboard and restores focus', async () => {
  const onChange = vi.fn(),
    user = userEvent.setup()
  render(
    <DesignedSelect
      value="a"
      options={[
        { value: 'a', label: 'Первый' },
        { value: 'b', label: 'Второй' },
      ]}
      onChange={onChange}
      label="Разрез"
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Разрез' })
  await user.click(trigger)
  await user.keyboard('{ArrowDown}{Enter}')
  expect(onChange).toHaveBeenCalledWith('b')
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})
