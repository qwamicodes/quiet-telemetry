import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SidebarResizeHandle, SidebarToggle } from '@/components/sidebar-resize'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarProvider, useSidebarPrefs } from '@/lib/sidebar'
import { HIDDEN_KEY, WIDTH_KEY } from '@/lib/sidebar-width'
import { useHotkeys } from '@/lib/use-hotkeys'

Element.prototype.setPointerCapture ??= () => {}

function Harness() {
  const s = useSidebarPrefs()
  return (
    <SidebarProvider value={s}>
      <TooltipProvider>
        <div data-sidebar-root data-testid="root" style={{ '--sidebar-w': `${s.width}px` } as React.CSSProperties}>
          <aside data-slot="app-sidebar" data-testid="aside" data-hidden={s.hidden ? '' : undefined}>
            {!s.hidden && <SidebarResizeHandle />}
          </aside>
          <SidebarToggle />
        </div>
      </TooltipProvider>
    </SidebarProvider>
  )
}

const handle = () => screen.getByRole('separator', { name: 'Resize sidebar' })

describe('sidebar resize handle', () => {
  const width0 = window.innerWidth
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1440
  })
  afterEach(() => {
    window.innerWidth = width0
  })

  it('is an accessible vertical separator for #sidebar', () => {
    render(<Harness />)
    const h = handle()
    expect(h).toHaveAttribute('aria-orientation', 'vertical')
    expect(h).toHaveAttribute('aria-controls', 'sidebar')
    expect(h).toHaveAttribute('aria-valuemin', '200')
    expect(h).toHaveAttribute('aria-valuemax', '420')
    expect(h).toHaveAttribute('aria-valuenow', '248')
    expect(h).toHaveAttribute('tabindex', '0')
  })

  it('arrows, Shift, Home/End resize and save; Enter hides, the toggle reopens at the last width', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    handle().focus()
    await user.keyboard('{ArrowRight}')
    expect(handle()).toHaveAttribute('aria-valuenow', '264')
    expect(localStorage.getItem(WIDTH_KEY)).toBe('264')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(handle()).toHaveAttribute('aria-valuenow', '328')
    await user.keyboard('{End}')
    expect(handle()).toHaveAttribute('aria-valuenow', '420')
    await user.keyboard('{Home}')
    expect(handle()).toHaveAttribute('aria-valuenow', '200')
    expect(screen.getByTestId('root').style.getPropertyValue('--sidebar-w')).toBe('200px')
    await user.keyboard('{ArrowRight}{Enter}')
    expect(screen.getByTestId('aside')).toHaveAttribute('data-hidden')
    expect(localStorage.getItem(HIDDEN_KEY)).toBe('true')
    const show = screen.getByRole('button', { name: 'Show sidebar' })
    expect(show).toHaveAttribute('aria-expanded', 'false')
    await user.click(show)
    expect(screen.getByTestId('aside')).not.toHaveAttribute('data-hidden')
    expect(handle()).toHaveAttribute('aria-valuenow', '216')
  })

  it('drag resizes and commits on release; double-click resets to 248', () => {
    render(<Harness />)
    const h = handle()
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 248, clientY: 400 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 264, clientY: 400 })
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 264, clientY: 400 })
    expect(h).toHaveAttribute('aria-valuenow', '264')
    expect(localStorage.getItem(WIDTH_KEY)).toBe('264')
    fireEvent.pointerDown(h, { button: 0, pointerId: 2, clientX: 264, clientY: 400 })
    fireEvent.pointerMove(h, { pointerId: 2, clientX: 900, clientY: 400 })
    fireEvent.pointerUp(h, { pointerId: 2 })
    expect(h).toHaveAttribute('aria-valuenow', '420')
    fireEvent.doubleClick(h)
    expect(h).toHaveAttribute('aria-valuenow', '248')
  })

  it('140–200 holds at 200; below 140 hides and keeps the width to reopen at', () => {
    render(<Harness />)
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 248, clientY: 400 })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 170, clientY: 400 })
    fireEvent.pointerUp(handle(), { pointerId: 1 })
    expect(handle()).toHaveAttribute('aria-valuenow', '200')
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 2, clientX: 200, clientY: 400 })
    fireEvent.pointerMove(handle(), { pointerId: 2, clientX: 100, clientY: 400 })
    fireEvent.pointerUp(handle(), { pointerId: 2 })
    expect(screen.getByTestId('aside')).toHaveAttribute('data-hidden')
    expect(localStorage.getItem(WIDTH_KEY)).toBe('200')
  })

  it('Esc cancels a drag back to the start width', () => {
    render(<Harness />)
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 248, clientY: 400 })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 380, clientY: 400 })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.documentElement).not.toHaveAttribute('data-sidebar-resizing')
    fireEvent.pointerUp(handle(), { pointerId: 1 })
    expect(handle()).toHaveAttribute('aria-valuenow', '248')
    expect(screen.getByTestId('root').style.getPropertyValue('--sidebar-w')).toBe('248px')
  })

  it('clamps a saved width on load', () => {
    localStorage.setItem(WIDTH_KEY, '9999')
    render(<Harness />)
    expect(handle()).toHaveAttribute('aria-valuenow', '420')
  })
})

describe('⌘B', () => {
  function Keys({ onB }: { onB: () => void }) {
    useHotkeys({ 'mod+b': onB })
    return (
      <>
        <input aria-label="plain" />
        <div aria-label="rich" contentEditable suppressContentEditableWarning tabIndex={0} />
      </>
    )
  }

  it('fires anywhere, also from a plain input, but leaves bold to a rich-text field', () => {
    let n = 0
    render(<Keys onB={() => n++} />)
    fireEvent.keyDown(document.body, { key: 'b', metaKey: true })
    fireEvent.keyDown(screen.getByLabelText('plain'), { key: 'b', ctrlKey: true })
    expect(n).toBe(2)
    fireEvent.keyDown(screen.getByLabelText('rich'), { key: 'b', metaKey: true })
    expect(n).toBe(2)
  })
})
