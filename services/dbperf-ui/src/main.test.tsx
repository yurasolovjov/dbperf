import { expect, it, vi } from 'vitest'
const root=vi.hoisted(()=>({render:vi.fn(),create:vi.fn()}))
vi.mock('react-dom/client',()=>({default:{createRoot:root.create}}))
vi.mock('./App',()=>({default:()=>null}))
it('applies persisted theme before mounting the application',async()=>{
 document.body.innerHTML='<div id="root"></div>';localStorage.setItem('dbperf-theme','light');root.create.mockReturnValue({render:root.render})
 await import('./main');expect(document.documentElement.dataset.theme).toBe('light');expect(root.create).toHaveBeenCalledWith(document.getElementById('root'));expect(root.render).toHaveBeenCalledOnce()
})
