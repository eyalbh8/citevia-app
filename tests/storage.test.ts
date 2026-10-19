import { expect,it } from 'vitest';
import { MemoryArtifacts,MemoryQueue,MemoryRepository } from '@citevia/storage';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider,newProject } from './fixtures/scanner.js';

it('commits one winning result transition and matching run counters under contention',async()=>{
  const repository=new MemoryRepository(),queue=new MemoryQueue(),artifacts=new MemoryArtifacts();const project=newProject({prompts:['Which analytics tools should I use?']});
  await repository.saveProject(project,null);const scanner=new Scanner({repository,queue,artifacts,provider:new FixtureProvider()});
  await scanner.handle({kind:'kickoff',projectId:project.id,scheduledAt:new Date().toISOString(),trigger:'manual'});
  const run=(await repository.listRuns(project.id))[0],before=(await repository.listResults(project.id,run.id))[0];
  const next={...before,version:1,status:'failed_collection' as const};
  const commits=await Promise.all([repository.commitResult(next,before),repository.commitResult(next,before)]);
  expect(commits.filter(Boolean)).toHaveLength(1);expect(await repository.getRun(project.id,run.id)).toMatchObject({terminalCount:1,resultVersion:1});
  expect(await repository.finalizeRun(project.id,run.id,0,'failed','stale-summary','2026-10-19')).toBe(false);
  expect(await repository.finalizeRun(project.id,run.id,1,'failed','summary','2026-10-19')).toBe(true);
  await repository.markRunRunning(project.id,run.id,'2026-10-20');
  expect(await repository.getRun(project.id,run.id)).toMatchObject({status:'failed',completedAt:'2026-10-19',summaryVersion:1});
});
it('bounds oversized UTF8 project configuration documents',async()=>{
  const repo=new MemoryRepository(),project=newProject();project.prompts.forEach(p=>p.text='🙂'.repeat(2000));
  await expect(repo.saveProject(project,null)).rejects.toThrow('300 KB');
});
