import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { QueryModal } from './QueryModal'
import { deferred } from '../test/fixtures'
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
afterEach(()=>{
 vi.restoreAllMocks()
 if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
 else Reflect.deleteProperty(navigator, 'clipboard')
 if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor)
 else Reflect.deleteProperty(document, 'execCommand')
})
it('loads truncated SQL, copies text and adds a hash filter',async()=>{
 vi.spyOn(api,'queryText').mockResolvedValue({query:'SELECT 1',lastSeen:10,truncated:true})
 const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 const onFilter=vi.fn(),onClose=vi.fn();render(<QueryModal targetId={1} hash="123" onClose={onClose} onFilter={onFilter}/>);
 await screen.findByText('SELECT 1');expect(screen.getByText(/текст обрезан/)).toBeVisible()
 fireEvent.click(screen.getByRole('button',{name:'Скопировать'}));await screen.findByText('Запрос скопирован');expect(writeText).toHaveBeenCalledWith('SELECT 1')
 fireEvent.click(screen.getByRole('button',{name:'Добавить в фильтры'}));expect(onFilter).toHaveBeenCalledWith('123');expect(onClose).toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Закрыть запрос'}));fireEvent(screen.getByRole('dialog'), new Event('cancel'));fireEvent(screen.getByRole('dialog'), new Event('close'))
})
it.each([true,false,'throw','string'] as const)('handles clipboard fallback: %s',async(result)=>{
 vi.spyOn(api,'queryText').mockResolvedValue({query:'SQL',lastSeen:10,truncated:false})
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue('denied')}})
 Object.defineProperty(document,'execCommand',{configurable:true,value:vi.fn(()=>{if(result==='throw')throw Error('clipboard failed');if(result==='string')throw 'failure';return result})})
 render(<QueryModal targetId={1} hash="123" onClose={vi.fn()}/>);await screen.findByText('SQL');fireEvent.click(screen.getByRole('button',{name:'Скопировать'}))
 await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(result===true?'Запрос скопирован':result==='throw'?'clipboard failed':/Не удалось скопировать/))
 expect(document.querySelector('dialog textarea')).toBeNull()
})
it.each([new Error('unavailable'),'network down'])('retries an error without closing the dialog: %s',async(error)=>{
 const query=vi.spyOn(api,'queryText').mockRejectedValueOnce(error).mockResolvedValueOnce({query:'',lastSeen:0,truncated:false})
 render(<QueryModal targetId={1} hash="123" onClose={vi.fn()}/>);await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Скопировать'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'Повторить'}));await screen.findByText('Текст запроса пуст');expect(query).toHaveBeenCalledTimes(2)
})
it('ignores stale responses and failures after cancellation',async()=>{
 const old=deferred<any>(),current=deferred<any>(),query=vi.spyOn(api,'queryText').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
 const {rerender}=render(<QueryModal targetId={1} hash="old" onClose={vi.fn()}/>);expect(screen.getByText(/Загружаем текст/)).toBeVisible()
 rerender(<QueryModal targetId={1} hash="new" onClose={vi.fn()}/>);await act(async()=>old.resolve({query:'stale',lastSeen:0,truncated:false}));expect(screen.queryByText('stale')).toBeNull()
 rerender(<QueryModal targetId={1} hash={null} onClose={vi.fn()}/>);await act(async()=>current.reject(Error('late')));expect(query.mock.calls[1][2]?.aborted).toBe(true);expect(screen.queryByRole('alert')).toBeNull()
})
it('backdrop closes outside all four edges but not for content clicks',async()=>{
 vi.spyOn(api,'queryText').mockResolvedValue({query:'SELECT 1',lastSeen:0,truncated:false});const onClose=vi.fn()
 render(<QueryModal targetId={1} hash="1" onClose={onClose}/>);await screen.findByText('SELECT 1');const dialog=screen.getByRole('dialog');vi.spyOn(dialog,'getBoundingClientRect').mockReturnValue({left:10,right:100,top:10,bottom:100} as DOMRect)
 fireEvent.click(screen.getByText('SELECT 1'));fireEvent.click(dialog,{clientX:50,clientY:50});expect(onClose).not.toHaveBeenCalled()
 for(const [clientX,clientY] of [[0,50],[110,50],[50,0],[50,110]])fireEvent.click(dialog,{clientX,clientY});expect(onClose).toHaveBeenCalledTimes(4)
 fireEvent.click(screen.getByRole('button',{name:'Добавить в фильтры'}));expect(onClose).toHaveBeenCalledTimes(5)
})
