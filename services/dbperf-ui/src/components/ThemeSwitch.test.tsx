import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTheme, savedTheme, THEME_KEY } from '../lib/theme'
import { ThemeSwitch } from './ThemeSwitch'
beforeEach(() => { localStorage.clear(); applyTheme('dark') })
afterEach(() => vi.restoreAllMocks())
it('switches with the keyboard and restores the saved preference', async () => {
  render(<ThemeSwitch />)
  const light = screen.getByRole('button', { name: 'Светлая' })
  light.focus()
  await userEvent.keyboard('{Enter}')
  expect(light).toHaveAttribute('aria-pressed', 'true')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(savedTheme()).toBe('light')
  await userEvent.click(screen.getByRole('button', { name: 'Тёмная' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(savedTheme()).toBe('dark')
})
it('keeps working when preference storage is blocked', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked') })
  expect(savedTheme()).toBe('dark')
  render(<ThemeSwitch />)
  await userEvent.click(screen.getByRole('button', { name: 'Светлая' }))
  expect(document.documentElement.dataset.theme).toBe('light')
})
it('synchronizes another tab, ignores other keys and handles clearing storage', () => {
  render(<ThemeSwitch />)
  localStorage.setItem(THEME_KEY, 'light')
  fireEvent(window, new StorageEvent('storage', { key: THEME_KEY, newValue: 'light' }))
  expect(screen.getByRole('button', { name: 'Светлая' })).toHaveAttribute('aria-pressed', 'true')
  localStorage.clear()
  fireEvent(window, new StorageEvent('storage', { key: null }))
  expect(screen.getByRole('button', { name: 'Тёмная' })).toHaveAttribute('aria-pressed', 'true')
  localStorage.setItem(THEME_KEY, 'light')
  fireEvent(window, new StorageEvent('storage', { key: 'unrelated' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
})
it('falls back to dark for an invalid stored preference', () => {
  localStorage.setItem(THEME_KEY, 'invalid')
  expect(savedTheme()).toBe('dark')
})
