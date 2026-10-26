import { describe, expect, it } from 'vitest'
import {
  clampSelection,
  dateInput,
  FULL,
  moveSelection,
  parseDateInput,
  selectedRange,
  validatePeriod,
} from './range-model'
describe('nested selections', () => {
  it('clamps movement at both edges while preserving width', () => {
    expect(moveSelection({ start: 0.2, end: 0.4 }, 'move', -1).start).toBe(0)
    expect(moveSelection({ start: 0.2, end: 0.4 }, 'move', -1).end).toBeCloseTo(
      0.2,
    )
    expect(moveSelection({ start: 0.2, end: 0.4 }, 'move', 1)).toEqual({
      start: 0.8,
      end: 1,
    })
    expect(clampSelection({ start: -1, end: 2 })).toEqual(FULL)
  })
  it('resizes either handle without crossing the other', () => {
    expect(
      moveSelection({ start: 0.2, end: 0.4 }, 'start', 1).start,
    ).toBeCloseTo(0.38)
    expect(moveSelection({ start: 0.2, end: 0.4 }, 'end', -1).end).toBeCloseTo(
      0.22,
    )
  })
  it('moves the analysis proportionally with its parent', () => {
    const outer = { startUnix: 1000, endUnix: 2000 }
    const win = selectedRange(outer, { start: 0.2, end: 0.6 })
    expect(win).toEqual({ startUnix: 1200, endUnix: 1600 })
    expect(selectedRange(win, { start: 0.25, end: 0.75 })).toEqual({
      startUnix: 1300,
      endUnix: 1500,
    })
  })
})
describe('custom period UTC+3', () => {
  it('applies minute, second and fraction inputs', () => {
    const expected = Date.parse('2026-10-25T12:00:00+03:00') / 1000
    for (const value of [
      '2026-10-25T12:00',
      '2026-10-25T12:00:00',
      '2026-10-25T12:00:00.500',
    ])
      expect(parseDateInput(value)).toBe(expected)
    expect(dateInput(expected)).toBe('2026-10-25T12:00:00')
  })
  it('rejects nonexistent dates, reversed ranges and intervals over 30 days', () => {
    expect(parseDateInput('2026-02-30T12:00')).toBeNull()
    expect(parseDateInput('garbage')).toBeNull()
    expect(parseDateInput('2026-10-25T25:00')).toBeNull()
    expect(validatePeriod('', '')).toMatch(/корректные/)
    expect(validatePeriod('2026-10-25T12:00', '2026-10-25T11:00')).toMatch(
      /позже/,
    )
    expect(validatePeriod('2026-09-01T12:00', '2026-10-25T11:00')).toMatch(
      /30 дней/,
    )
    expect(
      validatePeriod('2026-10-25T12:00:30', '2026-10-25T12:05:30'),
    ).toEqual({
      startUnix: parseDateInput('2026-10-25T12:00:30'),
      endUnix: parseDateInput('2026-10-25T12:05:30'),
    })
  })
})
