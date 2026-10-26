import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesignedSelect } from './designed-select'
import { popoverContainer } from './use-popover-position'
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();Object.defineProperty(document,'fullscreenElement',{configurable:true,value:null})})
it('keeps a popup inside fallback or native fullscreen',()=>{
 const parent=document.createElement('div'),anchor=document.createElement('button');parent.className='dashboard-fullscreen';parent.append(anchor);document.body.append(parent)
 expect(popoverContainer(anchor)).toBe(parent)
 Object.defineProperty(document,'fullscreenElement',{configurable:true,value:parent});expect(popoverContainer(null)).toBe(parent)
 Object.defineProperty(document,'fullscreenElement',{configurable:true,value:null});expect(popoverContainer(null)).toBe(document.body);parent.remove()
})
it('clamps a popup near the bottom/right and updates on scroll without ResizeObserver',()=>{
 vi.stubGlobal('ResizeObserver',undefined)
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return (this.classList.contains('select-menu')?{width:200,height:300}:{left:innerWidth-20,top:innerHeight-20,bottom:innerHeight,width:100,height:20}) as DOMRect})
 render(<DesignedSelect label="Test" value="a" options={[{value:'a',label:'Alpha'}]} onChange={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'Test'}))
 const menu=screen.getByRole('listbox');expect(parseFloat(menu.style.top)).toBeLessThan(innerHeight-100);expect(parseFloat(menu.style.left)).toBeLessThan(innerWidth-100)
 fireEvent(window,new Event('resize'));fireEvent(window,new Event('scroll'));fireEvent.keyDown(menu,{key:'Escape'});expect(screen.queryByRole('listbox')).toBeNull()
})
