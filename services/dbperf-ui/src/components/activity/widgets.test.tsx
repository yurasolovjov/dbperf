import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { TableFilters } from '../../api/types'
import { ColumnFilter } from './column-filter'
import { DesignedSelect } from './designed-select'
import { BrushChart } from './brush-chart'
import { Controls } from '../Controls'
import { DimensionOrder } from '../DimensionOrder'
import { FiltersBar } from '../FiltersBar'
import { TopTable } from '../TopTable'
import { series, top, slice } from '../../test/fixtures'
const noop=()=>{}
it('table dispatches tabs, units, expansion, filters, SQL and pagination',()=>{
 const props={dimension:'QUERY' as const,onDimension:vi.fn(),data:top,error:null,loading:false,unit:'PERCENT' as 'PERCENT'|'AAS',onUnit:vi.fn(),onFilter:vi.fn(),onQueryText:vi.fn(),rawLevel:true,filters:{dimensions:[]} as TableFilters,onFilters:vi.fn(),offset:8,onOffset:vi.fn(),pageSize:8}
 const {rerender}=render(<TopTable {...props} />)
 fireEvent.click(screen.getByRole('button',{name:'Развернуть SELECT orders'}));expect(screen.getByText('% строки',{exact:false})).toBeVisible()
 fireEvent.click(screen.getByRole('button',{name:'Свернуть SELECT orders'}))
 fireEvent.click(screen.getByRole('button',{name:'Фильтр дашборда: SELECT orders'}));expect(props.onFilter).toHaveBeenCalledWith('QUERY','123')
 fireEvent.click(screen.getByRole('button',{name:'Фильтр дашборда: other'}));expect(props.onFilter).toHaveBeenCalledOnce()
 fireEvent.click(screen.getByRole('button',{name:'SELECT orders'}));expect(props.onQueryText).toHaveBeenCalledWith('123')
 fireEvent.click(screen.getByRole('tab',{name:'Хосты'}));expect(props.onDimension).toHaveBeenCalledWith('CLIENT_ADDR')
 fireEvent.click(screen.getByRole('button',{name:'AAS'}));fireEvent.click(screen.getByRole('button',{name:'%'}));expect(props.onUnit.mock.calls.map(c=>c[0])).toEqual(['AAS','PERCENT'])
 fireEvent.click(screen.getByRole('button',{name:'Следующая страница'}));fireEvent.click(screen.getByRole('button',{name:'Предыдущая страница'}));expect(props.onOffset.mock.calls.map(c=>c[0])).toEqual([16,0])
 rerender(<TopTable {...props} unit="AAS" rawLevel={false} />);expect(screen.getByRole('tab',{name:'Процессы'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'Развернуть SELECT orders'}));expect(screen.queryByText('% строки',{exact:false})).not.toBeInTheDocument()
 rerender(<TopTable {...props} data={{...top,totalAas:0,matchedRows:0,entries:[{slice:slice('zero'),aas:0,percent:0,sub:[]}]}} dimension="DATNAME" />)
 expect(screen.getByText('zero')).toBeVisible()
})
it('table exposes persistent filter chips, removal and reset',()=>{
 const onFilters=vi.fn(),props={dimension:'QUERY' as const,onDimension:noop,data:null,error:null,loading:false,unit:'AAS' as const,onUnit:noop,onFilter:noop,onQueryText:noop,rawLevel:true,filters:{dimensions:[{dimension:'QUERY' as const,values:['orders'],match:'MATCH_TEXT_EQUALS' as const},{dimension:'DATNAME' as const,values:['test'],exclude:true},{dimension:'USENAME' as const,values:['reader']}],aas:{min:0},percent:{max:50}},onFilters,offset:0,onOffset:noop,pageSize:8}
 render(<TopTable {...props}/>);expect(screen.getByText(/Нет значений/)).toBeVisible()
 for(const name of ['QUERY','aas','percent'])fireEvent.click(screen.getByRole('button',{name:`Убрать фильтр ${name}`}))
 fireEvent.click(screen.getByRole('button',{name:'Сбросить'}));expect(onFilters).toHaveBeenLastCalledWith({dimensions:[]})
})
it.each([{error:'unavailable',loading:false,text:'Данные недоступны'},{error:null,loading:true,text:'Загружаем активность…'}])('table displays $text',({error,loading,text})=>{
 render(<TopTable dimension="BACKEND_TYPE" onDimension={noop} data={null} error={error} loading={loading} unit="PERCENT" onUnit={noop} onFilter={noop} onQueryText={noop} rawLevel={false} filters={{dimensions:[]}} onFilters={noop} offset={0} onOffset={noop} pageSize={8}/>);expect(screen.getByText(text)).toBeVisible()
})
function NumericFilter({column='aas'}:{column?:'aas'|'percent'}){const [value,onChange]=useState<TableFilters>({dimensions:[],[column]:{min:1,max:5}});return <><ColumnFilter column={column} title="Metric" value={value} onChange={onChange}/><output>{JSON.stringify(value)}</output></>}
it.each(['aas','percent'] as const)('numeric filter validates and clears %s',column=>{
 render(<NumericFilter column={column}/>);fireEvent.click(screen.getByRole('button',{name:'Фильтр: Metric'}))
 const change=(a:string,b:string)=>{fireEvent.change(screen.getByLabelText('От'),{target:{value:a}});fireEvent.change(screen.getByLabelText('До'),{target:{value:b}});fireEvent.submit(screen.getByRole('form'))}
 change('10','1');expect(screen.getByRole('alert')).toHaveTextContent('Проверьте границы')
 change('-1','10');expect(screen.getByRole('alert')).toBeVisible()
 if(column==='percent'){change('0','101');expect(screen.getByRole('alert')).toBeVisible()}
 change('0','2');expect(screen.getByRole('status')).toHaveTextContent('"min":0')
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: Metric'}));change('','');expect(screen.getByRole('status')).not.toHaveTextContent('"min"')
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: Metric'}));fireEvent.keyDown(screen.getByLabelText('От'),{key:'Escape'});expect(screen.queryByRole('form')).toBeNull()
})
it('text filters support equality/exclusion, preserve portal clicks and remove blanks',()=>{
 function Harness(){const[value,set]=useState<TableFilters>({dimensions:[{dimension:'QUERY',values:['old'],exclude:true}]});return <><ColumnFilter column="QUERY" title="SQL" value={value} onChange={set}/><output>{JSON.stringify(value)}</output></>}
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Фильтр: SQL'}));expect(screen.getByLabelText('Значение')).toHaveValue('old')
 fireEvent.click(screen.getByRole('button',{name:'Условие'}));fireEvent.pointerDown(screen.getByRole('option',{name:'Равно'}));fireEvent.click(screen.getByRole('option',{name:'Равно'}))
 fireEvent.change(screen.getByLabelText('Значение'),{target:{value:'  SELECT 1  '}});fireEvent.submit(screen.getByRole('form'));expect(screen.getByRole('status')).toHaveTextContent('MATCH_TEXT_EQUALS')
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: SQL'}));fireEvent.change(screen.getByLabelText('Значение'),{target:{value:'  '}});fireEvent.submit(screen.getByRole('form'));expect(screen.getByRole('status')).toHaveTextContent('"dimensions":[]')
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: SQL'}));fireEvent.click(screen.getByRole('button',{name:'Отмена'}))
 fireEvent.click(screen.getByRole('button',{name:'Фильтр: SQL'}));fireEvent.pointerDown(document.body);expect(screen.queryByRole('form')).toBeNull()
})
it('select keyboard skips disabled values, searches, wraps and closes on escape/tab/outside',async()=>{
 const user=userEvent.setup(),onChange=vi.fn()
 render(<DesignedSelect value="missing" label="Choice" options={[{value:'a',label:'Alpha'},{value:'b',label:'Beta',disabled:true},{value:'g',label:'Gamma'}]} onChange={onChange}/>);
 const trigger=screen.getByRole('button',{name:'Choice'})
 await user.click(trigger);await user.keyboard('{End}{Home}{ArrowUp}{ArrowDown}g');expect(screen.getByRole('option',{name:'Gamma'})).toHaveFocus()
 await user.keyboard('z{Escape}');expect(trigger).toHaveFocus()
 await user.keyboard('{ArrowUp}');expect(screen.getByRole('listbox')).toBeVisible()
 await user.keyboard('{Tab}');expect(screen.queryByRole('listbox')).toBeNull()
 await user.click(trigger);fireEvent.pointerDown(document.body);expect(screen.queryByRole('listbox')).toBeNull()
 await user.click(trigger);await user.keyboard('a{Enter}');expect(onChange).toHaveBeenCalledWith('a')
})
it('controls cover preset, invalid custom period, cancel, refresh and dimensions',()=>{
 const props={period:{seconds:0,start:100,end:200},onPeriod:vi.fn(),dimension:'QUERY' as const,onDimension:vi.fn(),refresh:0,onRefresh:vi.fn(),onReload:vi.fn(),loading:true,pidAvailable:false,onFullscreen:vi.fn(),fullscreen:true}
 const {rerender}=render(<Controls {...props}/>);fireEvent.click(screen.getByRole('button',{name:'1 мин'}));expect(props.onPeriod).toHaveBeenCalledWith({seconds:60})
 fireEvent.click(screen.getByRole('button',{name:/Произвольный/}));fireEvent.change(screen.getByLabelText('Конец'),{target:{value:'1970-01-01T00:00:00'}});fireEvent.submit(screen.getByRole('form'));expect(screen.getByRole('alert')).toBeVisible()
 fireEvent.keyDown(screen.getByLabelText('Начало'),{key:'Escape'});expect(screen.queryByRole('form')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:/Произвольный/}));fireEvent.click(screen.getByRole('button',{name:'Отмена'}))
 fireEvent.click(screen.getByRole('button',{name:'Разрез графиков'}));expect(screen.getByRole('option',{name:'Процессы'})).toBeDisabled();fireEvent.click(screen.getByRole('option',{name:'Хосты'}));expect(props.onDimension).toHaveBeenCalledWith('CLIENT_ADDR')
 fireEvent.click(screen.getByRole('button',{name:'Автообновление'}));fireEvent.click(screen.getByRole('option',{name:'Каждые 5 с'}));expect(props.onRefresh).toHaveBeenCalledWith(5)
 fireEvent.click(screen.getByRole('button',{name:'Обновить данные'}));fireEvent.click(screen.getByRole('button',{name:'Выйти из полного экрана'}));expect(props.onFullscreen).toHaveBeenCalled()
 rerender(<Controls {...props} fullscreen={false}/>);
})
it('dimension order moves, removes, adds and reverses levels; respects minimum',()=>{
 const onChange=vi.fn(),{rerender}=render(<DimensionOrder order={['QUERY','DATNAME']} rawLevel={true} onChange={onChange}/>);
 fireEvent.click(screen.getAllByRole('button',{name:'Правее'})[0]);fireEvent.click(screen.getAllByRole('button',{name:'Левее'})[1]);expect(onChange).toHaveBeenCalledWith(['DATNAME','QUERY'])
 fireEvent.click(screen.getAllByRole('button',{name:'Убрать'})[0]);expect(onChange).toHaveBeenCalledWith(['DATNAME'])
 fireEvent.click(screen.getByRole('button',{name:'Добавить уровень'}));fireEvent.click(screen.getByRole('option',{name:'Хосты'}));expect(onChange).toHaveBeenCalledWith(['QUERY','DATNAME','CLIENT_ADDR'])
 fireEvent.click(screen.getByRole('button',{name:/перевернуть/}));rerender(<DimensionOrder order={['QUERY']} rawLevel={false} onChange={onChange}/>);const n=onChange.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:'Убрать'}));expect(onChange).toHaveBeenCalledTimes(n)
})
it('legacy filter bar handles empty state and all actions',()=>{
 const props={filters:[],onRemove:vi.fn(),onClear:vi.fn(),totalOnly:false,onTotalOnly:vi.fn(),background:false,onBackground:vi.fn(),expanded:false,onExpand:vi.fn()}
 const{rerender}=render(<FiltersBar {...props}/>);expect(screen.getByText('Фильтры не выбраны')).toBeVisible();fireEvent.click(screen.getByLabelText('Фоновые процессы'));fireEvent.click(screen.getByLabelText('Общая активность'));fireEvent.click(screen.getByRole('button',{name:'Развернуть график'}));expect(props.onExpand).toHaveBeenCalled()
 rerender(<FiltersBar {...props} filters={[{dimension:'BACKEND_TYPE',values:['a'],exclude:true},{dimension:'QUERY',values:['b']}]} expanded/>);fireEvent.click(screen.getAllByRole('button',{name:'Убрать фильтр'})[0]);fireEvent.click(screen.getByText('сбросить'));expect(props.onRemove).toHaveBeenCalledWith(0);expect(props.onClear).toHaveBeenCalled()
})
it('brush moves/resizes by keyboard and pointer, cancels drag and reports hover',()=>{
 const onChange=vi.fn(),props={data:series,range:series.range,selection:{start:.2,end:.8},onChange,dimension:'WAIT_EVENT_TYPE' as const,label:'Test'}
 const {container,rerender}=render(<BrushChart {...props}/>),window=screen.getByRole('group',{name:'Test: переместить окно'}),start=screen.getByRole('button',{name:'Test: начало окна'}),end=screen.getByRole('button',{name:'Test: конец окна'})
 for(const element of [window,start,end])for(const key of ['ArrowLeft','ArrowRight','Home','End','x'])fireEvent.keyDown(element,{key,shiftKey:true})
 for(const name of ['сдвинуть влево','уменьшить окно','увеличить окно','сдвинуть вправо'])fireEvent.click(screen.getByRole('button',{name:`Test: ${name}`}))
 fireEvent.click(screen.getByRole('button',{name:'Весь интервал'}));expect(onChange).toHaveBeenCalledWith({start:0,end:1})
 const track=container.querySelector('.brush-track')!;vi.spyOn(track,'getBoundingClientRect').mockReturnValue({left:0,width:1000} as DOMRect)
 fireEvent.pointerMove(track,{clientX:500});expect(container.querySelector('.plot-tooltip')).not.toBeNull()
 fireEvent.pointerLeave(track);expect(container.querySelector('.plot-tooltip')).toBeNull()
 const n=onChange.mock.calls.length;fireEvent.pointerDown(track,{clientX:100,button:2});fireEvent.pointerMove(track,{clientX:200});fireEvent.pointerUp(track);expect(onChange).toHaveBeenCalledTimes(n)
 for(const element of [window,start,end,track]){fireEvent.pointerDown(element,{clientX:200,button:0});fireEvent.pointerMove(track,{clientX:400});fireEvent.pointerUp(track)}
 expect(onChange.mock.calls.length).toBeGreaterThan(n)
 fireEvent.pointerDown(track,{clientX:100,button:0});fireEvent.pointerMove(track,{clientX:200});fireEvent.pointerCancel(track)
 rerender(<BrushChart {...props} compact totalOnly data={null}/>);expect(screen.getByText(/Нет снимков/)).toBeVisible()
})

it('retains the previous chart and axis while a changed range loads, then reveals the new result',()=>{
 const props={data:series,range:series.range,selection:{start:.2,end:.8},onChange:noop,dimension:'WAIT_EVENT_TYPE' as const,label:'Retained'}
 const {container,rerender}=render(<BrushChart {...props}/>), path=()=>container.querySelector('.chart-total-line')!.getAttribute('d')
 const previous=path()
 // The parent advances its range before the request effect sets loading=true.
 // Preserve the returned data range, not this transient new requested range.
 rerender(<BrushChart {...props} range={{startUnix:101,endUnix:161}}/>)
 rerender(<BrushChart {...props} data={null} range={{startUnix:101,endUnix:161}} loading/> )
 expect(path()).toBe(previous)
 expect(screen.getByRole('status',{name:'Retained: загрузка данных'})).toBeVisible()
 expect(screen.getByRole('img',{name:'Retained'})).toBeVisible()
 expect(container.querySelector('.loading-skeleton')).toBeNull()
 const next={...series,totals:series.totals.map(v=>v+2),series:series.series.map((s,i)=>({...s,values:s.values.map(v=>v+(i===0?2:0))}))}
 rerender(<BrushChart {...props} data={next}/>)
 expect(path()).not.toBe(previous)
 expect(screen.queryByRole('status',{name:'Retained: загрузка данных'})).toBeNull()
})

it('shows raw values and matching colors for every visible series with a snapped crosshair',()=>{
 const props={data:series,range:series.range,selection:{start:.2,end:.8},onChange:noop,dimension:'WAIT_EVENT_TYPE' as const,label:'Values'}
 const {container,rerender}=render(<BrushChart {...props}/>),track=container.querySelector('.brush-track')!
 vi.spyOn(track,'getBoundingClientRect').mockReturnValue({left:0,width:1000} as DOMRect)
 fireEvent.pointerMove(track,{clientX:500,clientY:40})
 const rows=()=>Array.from(screen.getByRole('tooltip').querySelectorAll('.tooltip-series-row'))
 expect(rows().map(row=>row.querySelector('strong')!.textContent)).toEqual(['1','1','2'])
 expect(rows().map(row=>row.textContent)).toEqual(['CPU1','IO1','Всего2'])
 expect(rows()[0].querySelector('.tooltip-swatch')).toHaveStyle({background:'var(--wait-cpu)'})
 expect(rows()[1].querySelector('.tooltip-swatch')).toHaveStyle({background:'var(--wait-io)'})
 const first=container.querySelector('.chart-crosshair')!.getAttribute('x1')
 fireEvent.pointerMove(track,{clientX:100,clientY:40})
 expect(container.querySelector('.chart-crosshair')!.getAttribute('x1')).not.toBe(first)
 rerender(<BrushChart {...props} totalOnly/>)
 expect(rows()).toHaveLength(1)
 expect(rows()[0]).toHaveTextContent('Всего')
 fireEvent.pointerLeave(track)
 expect(screen.queryByRole('tooltip')).toBeNull()
 expect(container.querySelector('.chart-crosshair')).toBeNull()
})
