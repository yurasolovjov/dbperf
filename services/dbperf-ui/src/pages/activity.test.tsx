import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { registry } from '../api/registry'
import type { Dimension } from '../api/types'
import { target, series, top, profile, status } from '../test/fixtures'
import { ActivityPage } from './ActivityPage'
import App from '../App'
beforeEach(()=>{
 vi.spyOn(registry,'list').mockResolvedValue([target,{...target,targetId:2,name:'replica'}])
 vi.spyOn(registry,'assignments').mockResolvedValue({instances:[],unassigned:[1]})
 vi.spyOn(api,'targetStatus').mockResolvedValue(status)
 vi.spyOn(api,'timeSeries').mockImplementation(async(p)=>({...series,range:p.range,timestamps:[p.range.startUnix,p.range.startUnix+10,p.range.endUnix-10]}))
 vi.spyOn(api,'totals').mockResolvedValue({stepSeconds:10,timestamps:[100],values:[2,3],average:2.5})
 vi.spyOn(api,'top').mockResolvedValue(top)
 vi.spyOn(api,'profile').mockResolvedValue(profile)
 vi.spyOn(api,'queryText').mockResolvedValue({query:'SELECT orders',lastSeen:100,truncated:false})
})
const fullscreenDescriptors = [
 [document, 'fullscreenElement'], [document, 'exitFullscreen'], [HTMLElement.prototype, 'requestFullscreen'],
].map(([owner, key]) => ({ owner: owner as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(owner, key as string) }))
afterEach(()=>{
 vi.restoreAllMocks();vi.useRealTimers()
 for (const { owner, key, descriptor } of fullscreenDescriptors) {
  if (descriptor) Object.defineProperty(owner, key, descriptor)
  else Reflect.deleteProperty(owner, key)
 }
})
function Dashboard({id=1,dim='WAIT_EVENT_TYPE'}:{id?:number;dim?:Dimension}){
 const [dimension,setDimension]=useState(dim)
 return <ActivityPage targetId={id} initialDimension={dimension} onDimensionChange={setDimension} onTargetChange={vi.fn()}/>
}
async function loaded(){await screen.findByRole('button',{name:'CPU'})}
function lastTop(){return vi.mocked(api.top).mock.calls.slice(-1)[0]![0]}
it('dashboard preserves shared filters, updates dimensions, periods and chart selection',async()=>{
 render(<Dashboard/>);await loaded()
 fireEvent.click(screen.getByRole('button',{name:'CPU'}));await waitFor(()=>expect(lastTop().filters).toContainEqual({dimension:'WAIT_EVENT_TYPE',values:['CPU']}))
 fireEvent.click(screen.getByRole('button',{name:'CPU'}));await waitFor(()=>expect(lastTop().filters).not.toContainEqual({dimension:'WAIT_EVENT_TYPE',values:['CPU']}))
 fireEvent.click(screen.getByLabelText('Фоновые процессы'));await waitFor(()=>expect(lastTop().filters).toEqual([]))
 fireEvent.click(screen.getByLabelText('Только всего'));expect(document.querySelectorAll('.detail-plot .series-area')).toHaveLength(0)
 fireEvent.click(screen.getByRole('button',{name:'1 мин'}));await waitFor(()=>expect(vi.mocked(api.timeSeries).mock.calls.slice(-1)[0]![0].range.endUnix-vi.mocked(api.timeSeries).mock.calls.slice(-1)[0]![0].range.startUnix).toBeLessThanOrEqual(60))
 fireEvent.click(screen.getByRole('button',{name:'Разрез графиков'}));fireEvent.click(screen.getByRole('option',{name:'SQL'}));await waitFor(()=>expect(vi.mocked(api.timeSeries).mock.calls.slice(-1)[0]![0].slicing.dimension).toBe('QUERY'))
 fireEvent.click(screen.getByRole('tab',{name:'SQL'}));await screen.findByRole('button',{name:'SELECT orders'})
 fireEvent.click(screen.getByRole('button',{name:'SELECT orders'}));await screen.findByRole('dialog')
 fireEvent.click(screen.getByRole('button',{name:'Добавить в фильтры'}));await waitFor(()=>expect(lastTop().filters).toContainEqual({dimension:'QUERY',values:['123']}))
 fireEvent.click(screen.getByRole('button',{name:'Убрать общий фильтр QUERY'}));await waitFor(()=>expect(lastTop().filters).toEqual([]))
 fireEvent.click(screen.getByRole('button',{name:'Фильтр дашборда: SELECT orders'}));await waitFor(()=>expect(lastTop().filters).toContainEqual({dimension:'QUERY',values:['123']}))
 fireEvent.click(screen.getByRole('button',{name:'Сбросить всё'}));await waitFor(()=>expect(lastTop().filters).toEqual([]))
 fireEvent.click(screen.getByRole('button',{name:'График'}));fireEvent.keyDown(screen.getByRole('button',{name:'Анализ: начало окна'}),{key:'ArrowRight'});await waitFor(()=>expect(lastTop().range.startUnix).toBeGreaterThan(0))
 fireEvent.keyDown(screen.getByRole('group',{name:'Обзор: переместить окно'}),{key:'ArrowLeft'})
 fireEvent.click(screen.getByRole('button',{name:'Автообновление'}));fireEvent.click(screen.getByRole('option',{name:'Обновление выкл.'}));fireEvent.click(screen.getByRole('button',{name:'Обновить данные'}))
})
it('table filters survive tabs, units, pagination and resizing',async()=>{
 render(<Dashboard/>);await loaded()
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: Тип ожидания'}));fireEvent.change(screen.getByLabelText('Значение'),{target:{value:'CPU'}});fireEvent.click(screen.getByRole('button',{name:'Применить фильтр'}))
 await waitFor(()=>expect(lastTop().tableFilters?.[0].values).toEqual(['CPU']))
 fireEvent.click(screen.getByRole('tab',{name:'SQL'}));fireEvent.click(screen.getByRole('button',{name:'AAS'}));await waitFor(()=>expect(lastTop().slicing.dimension).toBe('QUERY'))
 fireEvent.click(screen.getByRole('button',{name:'Следующая страница'}));await waitFor(()=>expect(lastTop().offset).toBe(8))
 vi.mocked(api.top).mockResolvedValue({...top,matchedRows:2});fireEvent.click(screen.getByRole('button',{name:'Обновить данные'}));await waitFor(()=>expect(lastTop().offset).toBe(0))
})
it('flame graph opens the query dialog, filters the dashboard and changes the level order',async()=>{
 render(<Dashboard/>);await loaded();fireEvent.click(await screen.findByRole('button',{name:'#prod: 50.0 %'}))
 fireEvent.click(screen.getByRole('button',{name:'Текст запроса'}));await screen.findByRole('dialog');fireEvent.click(screen.getByRole('button',{name:'Закрыть запрос'}))
 fireEvent.click(screen.getByRole('button',{name:'В фильтр дашборда'}));await waitFor(()=>expect(lastTop().filters.some(f=>f.dimension==='QUERY')).toBe(true))
 fireEvent.click(screen.getByRole('button',{name:/перевернуть/}));await waitFor(()=>expect(vi.mocked(api.profile).mock.calls.slice(-1)[0]![0].dimensions[0]).toBe('APPLICATION_NAME'))
 fireEvent.click(screen.getByRole('button',{name:'График'}));expect(screen.getByRole('img',{name:'Анализ'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Flame graph'}));await screen.findByRole('group',{name:'Flame graph активности'})
})
it('fullscreen supports native entry, browser change, exit, fallback and Escape',async()=>{
 const request=vi.fn().mockResolvedValue(undefined),exit=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(HTMLElement.prototype,'requestFullscreen',{configurable:true,value:request});Object.defineProperty(document,'exitFullscreen',{configurable:true,value:exit})
 render(<Dashboard/>);await loaded();const root=document.querySelector('.focus-dashboard')!
 fireEvent.click(screen.getByRole('button',{name:'Весь дашборд на полный экран'}));await waitFor(()=>expect(request).toHaveBeenCalled())
 Object.defineProperty(document,'fullscreenElement',{configurable:true,value:root});fireEvent(document,new Event('fullscreenchange'));fireEvent.click(screen.getByRole('button',{name:'Выйти из полного экрана'}));await waitFor(()=>expect(exit).toHaveBeenCalled())
 Object.defineProperty(document,'fullscreenElement',{configurable:true,value:null});fireEvent(document,new Event('fullscreenchange'))
 request.mockRejectedValue(Error('unsupported'));fireEvent.click(screen.getByRole('button',{name:'Весь дашборд на полный экран'}));await screen.findByRole('button',{name:'Выйти из полного экрана'})
 fireEvent.keyDown(document,{key:'x'});fireEvent.keyDown(document,{key:'Escape'});await screen.findByRole('button',{name:'Весь дашборд на полный экран'})
 Object.defineProperty(HTMLElement.prototype,'requestFullscreen',{configurable:true,value:undefined});fireEvent.click(screen.getByRole('button',{name:'Весь дашборд на полный экран'}));await screen.findByRole('button',{name:'Выйти из полного экрана'});fireEvent.click(screen.getByRole('button',{name:'Выйти из полного экрана'}))
})
it('displays failures and retries without hiding the entire dashboard',async()=>{
 vi.mocked(api.timeSeries).mockRejectedValue(new Error('timeseries failed'))
 render(<Dashboard/>);await screen.findByRole('alert');expect(screen.getByRole('banner')).toBeVisible()
 vi.mocked(api.timeSeries).mockResolvedValue(series);fireEvent.click(screen.getByRole('button',{name:'Повторить'}));await loaded();expect(screen.queryByRole('alert')).toBeNull()
 vi.mocked(api.profile).mockRejectedValue(new Error('profile failed'));fireEvent.click(screen.getByRole('button',{name:'График'}));fireEvent.click(screen.getByRole('button',{name:'Flame graph'}));await screen.findByRole('alert')
})
it('handles no selected target, empty registry, no samples and aggregate data',async()=>{
 vi.mocked(registry.list).mockResolvedValue([])
 const {rerender}=render(<Dashboard id={0}/>);await screen.findByText(/Добавьте/);expect(api.top).not.toHaveBeenCalled()
 vi.mocked(registry.list).mockResolvedValue([target]);const onTargetChange=vi.fn()
 rerender(<ActivityPage key="auto" targetId={0} onDimensionChange={vi.fn()} onTargetChange={onTargetChange}/>);await waitFor(()=>expect(onTargetChange).toHaveBeenCalledWith(1))
 vi.mocked(api.top).mockResolvedValue({...top,level:'hour',entries:[]});vi.mocked(api.targetStatus).mockResolvedValue({...status,lastSampleAt:0});vi.mocked(api.totals).mockResolvedValue({stepSeconds:10,timestamps:[],values:[],average:0})
 rerender(<ActivityPage key="aggregate" targetId={1} initialDimension="QUERY" onDimensionChange={vi.fn()} onTargetChange={onTargetChange}/>);await screen.findByText(/Нет значений/);expect(screen.getByRole('tab',{name:'Процессы'})).toBeDisabled()
})
it('applies a custom period and clears legend with the dedicated reset control',async()=>{
 render(<Dashboard/>);await loaded();fireEvent.click(screen.getByRole('button',{name:'CPU'}));fireEvent.click(screen.getByRole('button',{name:'Сбросить легенду'}));await waitFor(()=>expect(lastTop().filters).toHaveLength(1))
 fireEvent.click(screen.getByRole('button',{name:/Произвольный/}));fireEvent.change(screen.getByLabelText('Начало'),{target:{value:'2026-10-25T12:00:00'}});fireEvent.change(screen.getByLabelText('Конец'),{target:{value:'2026-10-25T12:15:00'}});fireEvent.click(screen.getByRole('button',{name:'Применить период'}));await waitFor(()=>expect(vi.mocked(api.timeSeries).mock.calls.slice(-1)[0]![0].range.endUnix).toBe(Date.parse('2026-10-25T12:15:00+03:00')/1000))
})
it('App routes through sidebar, topbar target select and dimension URL replacement',async()=>{
 window.history.replaceState(null,'','#/t/1/activity');render(<App/>);await loaded()
 fireEvent.click(screen.getByRole('button',{name:'Разрез графиков'}));fireEvent.click(screen.getByRole('option',{name:'SQL'}));await waitFor(()=>expect(location.hash).toContain('dim=QUERY'))
 fireEvent.click(screen.getByRole('button',{name:'Разрез графиков'}));fireEvent.click(screen.getByRole('option',{name:'SQL'}))
 fireEvent.click(screen.getByRole('button',{name:'Объект мониторинга'}));fireEvent.click(screen.getByRole('option',{name:'replica'}));await waitFor(()=>expect(location.hash).toContain('/t/2/'))
 fireEvent.click(screen.getByRole('link',{name:/Объекты мониторинга/}));await screen.findByRole('button',{name:/Создать/})
 fireEvent.click(screen.getByRole('button',{name:/Создать/}));fireEvent.change(screen.getByLabelText('Имя'),{target:{value:'new'}});vi.spyOn(registry,'create').mockResolvedValue(target);fireEvent.click(screen.getByRole('button',{name:'Создать'}));await waitFor(()=>expect(screen.queryByText('Новый объект мониторинга')).toBeNull())
 fireEvent.click(screen.getAllByRole('button',{name:'Дашборд'})[0]);await screen.findByRole('banner')
})

it('switches both charts together without changing requests, filters or the selected windows', async () => {
  const {container} = render(<Dashboard/>); await loaded()
  const paths = () => Array.from(container.querySelectorAll('.focus-plot svg > path:last-of-type')).map(p => p.getAttribute('d'))
  const windows = () => Array.from(container.querySelectorAll('.brush-window')).map(w => w.getAttribute('style'))
  const smooth = paths(), selection = windows(), requests = vi.mocked(api.timeSeries).mock.calls.length
  expect(screen.getByRole('button',{name:'Плавно'})).toHaveAttribute('aria-pressed','true')
  fireEvent.click(screen.getByRole('button',{name:'По снимкам'}))
  expect(screen.getByRole('button',{name:'По снимкам'})).toHaveAttribute('aria-pressed','true')
  expect(paths()).not.toEqual(smooth)
  expect(paths().every(p => p?.includes(' H'))).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'Плавно'}))
  expect(paths()).toEqual(smooth)
  expect(windows()).toEqual(selection)
  expect(vi.mocked(api.timeSeries)).toHaveBeenCalledTimes(requests)
})

it('shows chart loaders and card skeletons until data arrives', async () => {
 let resolveSeries!: (value:typeof series)=>void
 let resolveTotals!: (value:{stepSeconds:number;timestamps:number[];values:number[];average:number})=>void
 let resolveStatus!: (value:typeof status)=>void
 vi.mocked(api.timeSeries).mockReturnValue(new Promise(resolve=>{resolveSeries=resolve}))
 vi.mocked(api.totals).mockReturnValue(new Promise(resolve=>{resolveTotals=resolve}))
 vi.mocked(api.targetStatus).mockReturnValue(new Promise(resolve=>{resolveStatus=resolve}))
 const {container}=render(<Dashboard/>)
 fireEvent.click(await screen.findByRole('button',{name:'График'}))
 await screen.findByRole('status',{name:'Обзор: загрузка данных'})
 expect(screen.getByRole('status',{name:'Анализ: загрузка данных'})).toBeVisible()
 expect(container.querySelectorAll('.focus-plot .loading-skeleton')).toHaveLength(0)
 expect(screen.getByRole('img',{name:'Анализ'})).toBeVisible()
 expect(container.querySelectorAll('.focus-summary [aria-busy="true"]')).toHaveLength(4)
 expect(container.querySelectorAll('.focus-summary .loading-skeleton')).toHaveLength(8)
 expect(container.querySelectorAll('.focus-summary small .loading-skeleton')).toHaveLength(4)
 expect(container.querySelector('.focus-summary')?.textContent).not.toContain('AAS')
 expect(screen.queryByText('Нет снимков за выбранный период')).toBeNull()
 expect(screen.getByRole('button',{name:'Анализ: начало окна',hidden:true})).toBeDisabled()
 resolveSeries(series);resolveTotals({stepSeconds:10,timestamps:[100],values:[2,3],average:2.5});resolveStatus(status)
 await waitFor(()=>expect(container.querySelectorAll('.loading-skeleton')).toHaveLength(0))
 expect(screen.getByRole('img',{name:'Анализ'})).toBeVisible()
 expect(screen.getByText('2.50')).toBeVisible()
 expect(screen.getByRole('button',{name:'Анализ: начало окна'})).toBeEnabled()
})
