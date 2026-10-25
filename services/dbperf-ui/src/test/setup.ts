import { configure } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
afterEach(cleanup)

// Browser primitives absent from jsdom; component behavior remains real.
class TestResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) { this.callback([{ target, contentRect: { width: 1000, height: 160 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver })
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open') } })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value() {} })
if (!globalThis.PointerEvent) Object.defineProperty(globalThis, 'PointerEvent', { configurable: true, writable: true, value: MouseEvent })

configure({ asyncUtilTimeout: 5000 })
