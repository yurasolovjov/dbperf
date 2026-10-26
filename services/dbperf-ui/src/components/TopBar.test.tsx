import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'
import { target, status } from '../test/fixtures'
it('handles missing target/status and switches targets from the designed menu',()=>{
 const onChange=vi.fn(),{rerender}=render(<TopBar targets={[]} targetId={0} status={null} onChange={onChange}/>);
 expect(screen.queryByText('подключена')).toBeNull()
 rerender(<TopBar targets={[target]} targetId={1} status={status} onChange={onChange}/>);expect(screen.getByText('подключена')).toBeVisible()
 fireEvent.click(screen.getByRole('button',{name:'Объект мониторинга'}));fireEvent.click(screen.getByRole('option',{name:target.name}));expect(onChange).toHaveBeenCalledWith(1)
 rerender(<TopBar targets={[target]} targetId={1} status={{...status,state:'STATE_UNSPECIFIED',lastSampleAt:0,serverVersionNum:0,lastError:'connection failed'}} onChange={onChange}/>);expect(screen.getByText(/ведёт collector/)).toBeVisible()
 rerender(<TopBar targets={[target]} targetId={1} status={{...status,state:'STATE_UNSPECIFIED',ownerInstance:''}} onChange={onChange}/>);expect(screen.getByText('нет данных')).toBeVisible()
 for(const state of ['DISCONNECTED','DISABLED'] as const)rerender(<TopBar targets={[target]} targetId={1} status={{...status,state}} onChange={onChange}/>);
})
