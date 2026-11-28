import 'fake-indexeddb/auto';
import {describe,expect,it,vi} from 'vitest';
import {recordDeviceUsage,readDeviceUsage,shiftDay,utcDay} from './ai-usage-store';
import {estimatedUsd} from './ai-usage-pricing';
import {chartData,mountUsage} from './ai-usage-panel';
import type {AiClient} from './ai-client';
import type {RemoteWorkspace} from './workspace-registry';

describe('AI usage history',()=>{
  it('retains concurrent native calls and isolates accounts sharing a workspace',async()=>{
    const ref:RemoteWorkspace = {kind:'remote',id:'remote',name:'Space',server:'https://blok.example',workspaceId:'space',accountId:'alice'};
    const today = utcDay();
    await Promise.all([
      recordDeviceUsage(ref,'chat','codex'),recordDeviceUsage(ref,'chat','codex'),
      recordDeviceUsage(ref,'edit','openai',7),recordDeviceUsage({...ref,accountId:'bob'},'chat','claude'),
    ]);
    const rows = await readDeviceUsage(ref,today,7);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({provider:'codex',calls:2,measured:0,tokens:0}),
      expect.objectContaining({provider:'openai',calls:1,measured:1,tokens:7}),
    ]));
    expect(await readDeviceUsage(ref,shiftDay(today,-1),30)).toEqual([]);
    expect(chartData(rows,today,7,'feature','calls').at(-1)).toMatchObject({chat:2,edit:1});
    expect(chartData(rows,today,30,'provider','tokens').at(-1)).toMatchObject({openai:7,codex:0});
  });
  it('renders an empty period without interactive bars and refreshes when the window regains focus',async()=>{
    const host=document.createElement('div');
    document.body.append(host);
    const ref:RemoteWorkspace={kind:'remote',id:'remote',name:'Space',server:'https://blok.example',workspaceId:'stats',accountId:'alice'};
    const usage=vi.fn<NonNullable<AiClient['usage']>>().mockResolvedValue({rows:[]});
    const dispose=mountUsage(host,ref,{usage});
    try {
      await vi.waitFor(()=>expect(host.querySelector('.ai-usage-empty')).toBeTruthy());
      expect(host.querySelector('.ai-usage-chart')).toBeNull();
      expect(host.querySelector('.ai-usage-legend')).toBeNull();
      expect(host.textContent).not.toContain('0 appels sur 0');
      usage.mockResolvedValue({rows:[{day:utcDay(),feature:'chat',calls:1,tokens:0,measured:0}]});
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(()=>expect(host.querySelector('.ai-usage-total strong')?.textContent).toBe('1'));
      host.querySelector<HTMLButtonElement>('[aria-label="Mesure"]')!.click();
      document.querySelector<HTMLElement>('[data-blok-item-name=tokens]')!.click();
      await vi.waitFor(()=>expect(host.querySelector('.ai-usage-empty')?.textContent).toContain('Aucun token'));
      expect(host.querySelector('.ai-usage-chart')).toBeNull();
    } finally { dispose();host.remove(); }
  });
  it('estimates model-specific standard API costs and leaves CLI and unknown rates unavailable',()=>{
    const row={day:utcDay(),provider:'openai' as const,feature:'chat' as const,model:'gpt-5-mini-2025-08-07',calls:1,measured:1,detailed:1,standard:true,tokens:1100,input:1000,cached:400,output:100};
    expect(estimatedUsd(row)).toBeCloseTo(0.00036,10);
    expect(estimatedUsd({...row,provider:'codex'})).toBeUndefined();
    expect(estimatedUsd({...row,model:'unknown'})).toBeUndefined();
    expect(estimatedUsd({...row,model:'text-embedding-3-small',input:50421,cached:0,output:0})).toBeCloseTo(0.00100842,10);
  });
  it('includes each UTC calendar day exactly once across month boundaries',()=>{
    const points=chartData([],'2024-03-01',7,'feature','calls');
    expect(points.map(p=>p.day)).toEqual(['2024-02-24','2024-02-25','2024-02-26','2024-02-27','2024-02-28','2024-02-29','2024-03-01']);
  });
});

