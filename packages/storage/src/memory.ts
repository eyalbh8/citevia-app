import { isTerminal, type Analysis, type CapturedAnswer, type OnboardingJob, type Membership, type Project, type PromptResult, type ScanMessage, type ScanRun } from '@citevia/core';
import type { ArtifactStore, JobQueue, Repository } from './contracts.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

interface State { projects: Record<string, Project>; members: Record<string, Membership>; runs: Record<string, ScanRun>; results: Record<string, PromptResult>; onboarding: Record<string,OnboardingJob> }
const blank = (): State => ({ projects: {}, members: {}, runs: {}, results: {}, onboarding:{} });
const key = (...parts: string[]) => parts.join(':');
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryRepository implements Repository {
  protected state: State = blank();
  private tail: Promise<unknown> = Promise.resolve();
  createOnboarding(project:Project, job:OnboardingJob, maxAccounts:number) {return this.operation(()=>{
    this.state.onboarding ||= {};
    if(this.state.projects[project.id])return 'exists' as const;
    if(Object.values(this.state.members).filter(member=>member.userId===job.ownerId&&member.role==='owner').length>=maxAccounts)return 'limit' as const;
    this.state.projects[project.id]=copy(project);this.state.onboarding[key(project.id,job.id)]=copy(job);
    this.state.members[key(project.id,job.ownerId)]={projectId:project.id,userId:job.ownerId,role:'owner'};return 'created' as const;
  },true);}
  getOnboarding(projectId:string,jobId:string){return this.operation(()=>this.state.onboarding?.[key(projectId,jobId)]||null);}
  saveOnboarding(job:OnboardingJob,expectedVersion:number){return this.operation(()=>{const id=key(job.projectId,job.id);if(this.state.onboarding?.[id]?.version!==expectedVersion)return false;this.state.onboarding[id]=copy(job);return true;},true);}
  listActiveOnboarding(){return this.operation(()=>Object.values(this.state.onboarding||{}).filter(job=>['queued','running'].includes(job.status)));}
  async saveMeasurement(_result:PromptResult,_run:ScanRun,_answer:CapturedAnswer|null,_analysis:Analysis|null) {}
  protected async persist(): Promise<void> {}
  protected async operation<T>(fn: () => T, write = false): Promise<T> {
    const work = this.tail.then(async () => { const result = fn(); if (write) await this.persist(); return copy(result); });
    this.tail = work.catch(() => {});
    return work;
  }
  getProject(id: string) { return this.operation(() => this.state.projects[id] || null); }
  listProjects(userId: string) { return this.operation(() => Object.values(this.state.members).filter(m => m.userId === userId).flatMap(m => this.state.projects[m.projectId] ? [{ ...this.state.projects[m.projectId], role: m.role }] : [])); }
  async listProjectSummaries(userId:string,options:{offset:number;limit:number;query?:string}) {
    const q=options.query?.toLocaleLowerCase()||'';
    const projects=(await this.listProjects(userId)).filter(project=>`${project.name} ${project.brand.domains.join(' ')}`.toLocaleLowerCase().includes(q)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    const items:Project[]=[];
    for(const project of projects.slice(options.offset,options.offset+options.limit)){const job=project.onboardingJobId?await this.getOnboarding(project.id,project.onboardingJobId):null;items.push({...project,prompts:[],brandbook:undefined,activePromptCount:project.prompts.filter(prompt=>prompt.active).length,onboardingSummary:job?{status:job.status,step:job.step,error:job.error,firstRunId:job.firstRunId}:undefined});}
    return {items,total:projects.length,nextCursor:options.offset+options.limit<projects.length?Buffer.from(String(options.offset+options.limit)).toString('base64url'):null};
  }
  async saveProject(project: Project, expectedVersion: number | null) {
    if(Buffer.byteLength(JSON.stringify(project),'utf8')>300000)throw new Error('Project configuration exceeds the 300 KB limit');
    return this.operation(() => {
      const previous = this.state.projects[project.id];
      if (expectedVersion === null ? !!previous : previous?.version !== expectedVersion) return false;
      this.state.projects[project.id] = copy(project); return true;
    }, true);
  }
  getMembership(projectId: string, userId: string) { return this.operation(() => this.state.members[key(projectId, userId)] || null); }
  putMembership(member: Membership) { return this.operation(() => { this.state.members[key(member.projectId, member.userId)] = copy(member); }, true); }
  createRun(run: ScanRun, results: PromptResult[]) {
    return this.operation(() => {
      if (this.state.runs[key(run.projectId, run.id)]) return false;
      if (results.length !== run.totalCount || results.length > 50 || results.length === 0 || new Set(results.map(r => r.promptId)).size !== results.length) throw new Error('Invalid run manifest');
      this.state.runs[key(run.projectId, run.id)] = copy(run);
      results.forEach(result => { this.state.results[key(run.projectId, run.id, result.promptId)] = copy(result); });
      return true;
    }, true);
  }
  getRun(projectId: string, runId: string) { return this.operation(() => this.state.runs[key(projectId, runId)] || null); }
  listRuns(projectId: string, limit = 60) { return this.operation(() => Object.values(this.state.runs).filter(r => r.projectId === projectId).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)).slice(0, limit)); }
  listActiveRuns() { return this.operation(() => Object.values(this.state.runs).filter(r => r.status === 'queued' || r.status === 'running')); }
  listResults(projectId: string, runId: string) { return this.operation(() => Object.values(this.state.results).filter(r => r.projectId === projectId && r.runId === runId).sort((a,b) => a.promptId.localeCompare(b.promptId))); }
  getResult(projectId: string, runId: string, promptId: string) { return this.operation(() => this.state.results[key(projectId, runId, promptId)] || null); }
  commitResult(next: PromptResult, previous: PromptResult) {
    return this.operation(() => {
      const id = key(previous.projectId, previous.runId, previous.promptId);
      const current = this.state.results[id], run = this.state.runs[key(previous.projectId, previous.runId)];
      if (!current || current.version !== previous.version || !run) return false;
      if (next.version !== previous.version + 1 || key(next.projectId,next.runId,next.promptId) !== id) throw new Error('Invalid result transition');
      this.state.results[id] = copy(next);
      run.terminalCount += Number(isTerminal(next.status)) - Number(isTerminal(previous.status));
      run.succeededCount += Number(next.status === 'succeeded') - Number(previous.status === 'succeeded');
      run.capturedCount += Number(!!next.capturedAt) - Number(!!previous.capturedAt);
      run.resultVersion++; run.status = 'running'; run.startedAt ||= new Date().toISOString(); delete run.completedAt;
      return true;
    }, true);
  }
  markRunRunning(projectId: string, runId: string, deadlineAt?: string) { return this.operation(() => { const run = this.state.runs[key(projectId, runId)]; if (run && run.terminalCount < run.totalCount) { run.status = 'running'; run.startedAt ||= new Date().toISOString(); delete run.completedAt; if (deadlineAt) run.deadlineAt = deadlineAt; } }, true); }
  finalizeRun(projectId: string, runId: string, resultVersion: number, status: 'completed'|'partial'|'failed', summaryKey: string, completedAt: string) {
    return this.operation(() => {
      const run = this.state.runs[key(projectId, runId)];
      if (!run || run.resultVersion !== resultVersion || run.terminalCount !== run.totalCount) return false;
      Object.assign(run, { status, summaryKey, summaryVersion: resultVersion, completedAt }); return true;
    }, true);
  }
}

export class FileRepository extends MemoryRepository {
  private constructor(private path: string) { super(); }
  static async open(path: string): Promise<FileRepository> {
    const repository = new FileRepository(path);
    try { repository.state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return repository;
  }
  protected async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> { return copy(this.values.get(key) as T ?? null); }
  async put(key: string, value: unknown) { this.values.set(key, copy(value)); }
}
export class FileArtifacts implements ArtifactStore {
  constructor(private root: string) {}
  private path(key: string) { const path = resolve(this.root, `${key}.json`); if (!path.startsWith(`${resolve(this.root)}${sep}`)) throw new Error('Invalid artifact key'); return path; }
  async get<T>(key: string): Promise<T | null> { try { return JSON.parse(await readFile(this.path(key), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
  async put(key: string, value: unknown) { const path = this.path(key); await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${path}.tmp`, path); }
}
export class MemoryQueue implements JobQueue {
  readonly messages: ScanMessage[] = [];
  async send(messages: ScanMessage[]) { this.messages.push(...copy(messages)); }
}
