import type { RegistryTarget } from '../api/registry'
import type { SliceValue, TimeSeriesResponse, TopResponse, ProfileResponse, TargetStatus } from '../api/types'
export const target: RegistryTarget = { targetId: 1, name: 'prod-main', dsn: 'postgres://reader:secret@db/prod', enabled: true, intervalSec: 10, statementTimeoutMs: 5000, labels: { env: 'prod' }, createdAt: 1, updatedAt: 2, revision: 3 }
export const slice = (value: string, shortText = '', isRemainder = false): SliceValue => ({ value, shortText, isRemainder, id: 0 })
export const series: TimeSeriesResponse = { range: { startUnix: 100, endUnix: 160 }, stepSeconds: 10, level: 'raw', timestamps: [100,110,140], totals: [3,4,2], series: [{ slice: slice('CPU'), values:[1,2,1], average:1 },{ slice:slice('IO'),values:[2,2,1],average:2 }] }
export const top: TopResponse = { totalAas: 3, nSamples: 10, level: 'raw', matchedRows: 17, entries: [{slice:slice('123','SELECT orders'),aas:2,percent:66,sub:[{slice:slice('CPU'),aas:2,percent:100,sub:[]}]},{slice:slice('456'),aas:1,percent:34,sub:[]},{slice:slice('other','',true),aas:0,percent:0,sub:[]}] }
export const profile: ProfileResponse = {totalSamples:6,nSamples:3,level:'raw',paths:[{values:['123','prod','CPU','CPU'],samples:2},{values:['123','prod','CPU','CPU'],samples:1},{values:['456','prod','IO','IO.Read'],samples:2}],queryShortTexts:{'123':'SELECT orders'}}
export const status: TargetStatus = {targetId:1,state:'CONNECTED',ownerInstance:'collector',lastSampleAt:140,disconnectedSince:0,lastError:'',serverVersionNum:160000,lastSampleDurationMs:5}
export function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
