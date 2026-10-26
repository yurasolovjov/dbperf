import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const capture=vi.hoisted(()=>({props:null as any}))
vi.mock('plotly.js-dist-min',()=>({default:{}}))
vi.mock('react-plotly.js/factory',()=>({default:()=> (props:any)=>{capture.props=props;return <div data-testid="plot"/>}}))
import { ActivityChart } from './ActivityChart'
import { FlameGraph } from './FlameGraph'
import { plotTime } from '../lib/plot'
import { profile, series, slice } from '../test/fixtures'
it('creates gap-aware stacked traces, escapes labels and highlights selection',()=>{
 const onWindow=vi.fn(),onLegendClick=vi.fn()
 const data={...series,series:[{...series.series[0],slice:slice('123','SELECT <a>&b>')}]}
 render(<ActivityChart data={data} dimension="QUERY" height={150} window={{startUnix:100,endUnix:110}} onWindow={onWindow} onLegendClick={onLegendClick} tickSeconds />)
 const props=capture.props
 expect(props.data[0].y).toEqual([1,2,null,1])
 expect(props.data[0].hovertemplate).toContain('&lt;a&gt;&amp;b&gt;')
 expect(props.layout.shapes).toHaveLength(3)
 expect(props.layout.xaxis.tickformat).toBe('%H:%M:%S')
 props.onSelected({range:{x:['2026-01-01 10:00:00','2026-01-01 10:01:00']}})
 expect(onWindow).toHaveBeenCalledOnce()
 props.onSelected({});props.onSelected({range:{x:['bad','bad']}});props.onSelected({range:{x:['2026-01-01','2025-01-01']}})
 expect(onWindow).toHaveBeenCalledOnce()
 expect(props.onLegendClick({data:[{meta:'123'}],curveNumber:0})).toBe(false)
 props.onLegendClick({data:[{}],curveNumber:0});expect(onLegendClick).toHaveBeenCalledWith('123')
})
it('handles total-only, smooth lines, empty data and optional callbacks',()=>{
 const {rerender}=render(<ActivityChart data={series} dimension="WAIT_EVENT_TYPE" height={120} totalOnly stepped={false} />)
 expect(capture.props.data[0].line.shape).toBe('linear')
 expect(capture.props.layout.showlegend).toBe(false)
 capture.props.onSelected({range:{x:['2026-01-01','2026-01-02']}})
 expect(capture.props.onLegendClick({})).toBe(true)
 rerender(<ActivityChart data={{...series,timestamps:[100,110],totals:[1,2]}} dimension="WAIT_EVENT_TYPE" height={120} totalOnly />)
 expect(capture.props.data[0].line.shape).toBe('hv')
 rerender(<ActivityChart data={null} dimension="QUERY" height={120} emptyText="No samples" />)
 expect(capture.props.layout.annotations[1].text).toBe('No samples')
 rerender(<ActivityChart data={null} dimension="QUERY" height={120} />)
 expect(capture.props.layout.annotations[1].text).toBe('Нет данных за период')
 expect(plotTime(0)).toMatch(/^1970-01-01 /)
})
it('builds profile nodes and dispatches only modifier actions to filters and SQL',()=>{
 const onFilter=vi.fn(),onQueryText=vi.fn()
 const {rerender}=render(<FlameGraph data={null} dimensions={['QUERY']} tickSeconds={10} onFilter={onFilter} onQueryText={onQueryText} />)
 expect(screen.getByText('Нет активных сессий в окне')).toBeVisible()
 rerender(<FlameGraph data={profile} dimensions={['QUERY','DATNAME','WAIT_EVENT_TYPE','WAIT_EVENT']} tickSeconds={10} onFilter={onFilter} onQueryText={onQueryText} />)
 const props=capture.props,trace=props.data[0]
 expect(trace.labels).toContain('other');expect(trace.labels).toContain('SELECT orders')
 const id=trace.ids[1]
 props.onClick({points:[{id}],event:{shiftKey:true}});expect(onQueryText).toHaveBeenCalledWith('123')
 props.onClick({points:[{id}],event:{ctrlKey:true}});expect(onFilter).toHaveBeenCalledWith('QUERY','123')
 props.onClick({points:[{id}],event:{metaKey:true}})
 props.onClick({points:[{id}],event:{}});props.onClick({points:[]});props.onClick({points:[{id:'root'}]});props.onClick({points:[{id:'missing'}]})
 expect(onFilter).toHaveBeenCalledTimes(2)
 rerender(<FlameGraph data={{...profile,nSamples:0,totalSamples:5,queryShortTexts:{},paths:[{values:['CPU',''],samples:5}]}} dimensions={['WAIT_EVENT','QUERY','DATNAME']} tickSeconds={1} onFilter={onFilter} onQueryText={onQueryText} />)
 expect(capture.props.data[0].labels).toContain('CPU')
 rerender(<FlameGraph data={{...profile,paths:[{values:['','123'],samples:6}]}} dimensions={['DATNAME','QUERY']} tickSeconds={1} onFilter={onFilter} onQueryText={onQueryText} />)
 expect(capture.props.data[0].labels).toContain('(пусто)')
})
