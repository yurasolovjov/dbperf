import { afterEach, expect, it, vi } from 'vitest'
import { registry, ownerOf, redactDSN, validateInput } from './registry'
import { api } from './client'
import { target } from '../test/fixtures'
afterEach(()=>vi.unstubAllGlobals())
it('paginates all targets and supports an absent target list',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({targets:[target],nextPageToken:'next'}))).mockResolvedValueOnce(new Response('{}'))
 vi.stubGlobal('fetch',fetcher)
 expect(await registry.list()).toEqual([target])
 expect(JSON.parse(fetcher.mock.calls[1][1].body).pageToken).toBe('next')
})
it('uses registry endpoint contracts and camelCase revision masks',async()=>{
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{}')));vi.stubGlobal('fetch',fetcher)
 const signal=new AbortController().signal
 await registry.get(1,signal);await registry.create(target,signal);await registry.update(target,['interval_sec','enabled'],signal);await registry.delete(1,signal);await registry.bulkCreate([target],false,signal);await registry.assignments(signal)
 expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/api/v1/registry/targets/get','/api/v1/registry/targets/create','/api/v1/registry/targets/update','/api/v1/registry/targets/delete','/api/v1/registry/targets/bulk-create','/api/v1/registry/assignments'])
 expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({target,updateMask:'intervalSec,enabled',expectedRevision:'3'})
 expect(JSON.parse(fetcher.mock.calls[4][1].body).skipExisting).toBe(false)
 expect(fetcher.mock.calls.every(c=>c[1].signal===signal)).toBe(true)
})
it('maps owners safely and never exposes DSN passwords',()=>{
 expect(ownerOf(null).size).toBe(0)
 expect(ownerOf({instances:[{instance:'a',targetIds:[1,2]},{instance:'b'}],unassigned:[]} as any).get(2)).toBe('a')
 for(const value of ['host=db','postgres://db','postgres://reader@host/db'])expect(redactDSN(value)).toBe(value)
 expect(redactDSN('postgres://reader:p@ss:word@host/db')).toBe('postgres://reader:***@host/db')
})
it('validates names, schemes and both boundaries of numeric inputs',()=>{
 expect(validateInput(target)).toBeNull()
 expect(validateInput({name:'a',dsn:'postgresql://db'})).toBeNull()
 for(const change of [{name:''},{name:'bad name'},{dsn:''},{dsn:'https://db'},{intervalSec:0},{intervalSec:3601},{statementTimeoutMs:99},{statementTimeoutMs:600001}])expect(validateInput({...target,...change})).toBeTypeOf('string')
 expect(validateInput({...target,name:undefined,dsn:undefined} as any)).toContain('имя')
 expect(validateInput({...target,dsn:undefined} as any)).toContain('dsn')
 for(const value of [1,3600])expect(validateInput({...target,intervalSec:value})).toBeNull()
 for(const value of [100,600000])expect(validateInput({...target,statementTimeoutMs:value})).toBeNull()
})
it('calls every activity endpoint and revives numeric array and scalar fields',async()=>{
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{"timestamps":["12",13],"nSamples":3}')));vi.stubGlobal('fetch',fetcher)
 const params:any={targetId:1,range:{startUnix:1,endUnix:2},filters:[],excludeSelf:true,stepSeconds:1,slicing:{dimension:'QUERY',limit:1}}
 expect(await api.listTargets()).toEqual([])
 await api.targetStatus(1);await api.timeSeries(params);await api.totals(params);await api.sessions({targetId:1,atUnix:1,filters:[],limit:10});await api.profile({...params,dimensions:['QUERY']})
 expect((await api.timeSeries(params)).timestamps).toEqual([12,13])
 expect(fetcher.mock.calls[4][0]).toContain('/sessions')
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{"targets":[{"targetId":1}]}')))
 expect(await api.listTargets()).toEqual([{targetId:1}])
})
it('preserves plain JSON errors without error fields and HTTP fallback text',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{}',{status:400})).mockResolvedValueOnce(new Response('',{status:503,statusText:'Unavailable'})))
 await expect(api.listTargets()).rejects.toThrow('{}')
 await expect(api.listTargets()).rejects.toThrow('Unavailable')
})
