import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { accountCostPolicyReport, productionDatabase, summarizeProviderCosts } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';

const {values}=parseArgs({options:{mode:{type:'string',default:'local'},project:{type:'string'},start:{type:'string'},end:{type:'string'},'account-budget-usd':{type:'string',default:process.env.ACCOUNT_MONTHLY_BUDGET_USD || '100'},'infra-reserve-usd':{type:'string',default:process.env.ACCOUNT_MONTHLY_INFRA_RESERVE_USD || '30'},'ai-budget-usd':{type:'string',default:process.env.LLM_MONTHLY_BUDGET_USD || '70'},'non-ai-usd':{type:'string'},help:{type:'boolean'}}});
if(values.help) console.log('Usage: npm run costs:report -- [--mode local|aws] [--project ID] [--start ISO_DATE] [--end ISO_DATE] [--account-budget-usd 100] [--infra-reserve-usd 30] [--ai-budget-usd 70] [--non-ai-usd AMOUNT --project ID]\nNon-AI USD is an explicit allocation for this account and reporting period; omitted allocations leave all-in totals unknown.\nRead-only. End is exclusive. Defaults to the current UTC month. Never applies migrations.');
else {
  if(!['local','aws'].includes(values.mode)) throw new Error('Use --mode local or aws.');
  if(values['non-ai-usd'] !== undefined && !values.project) throw new Error('--non-ai-usd requires --project to attribute the allocation.');
  const policy = { accountMonthlyBudgetUsd: Number(values['account-budget-usd']), infrastructureReserveUsd: Number(values['infra-reserve-usd']), aiMonthlyBudgetUsd: Number(values['ai-budget-usd']),
    ...(values['non-ai-usd'] !== undefined ? { allocatedNonAiUsd: { [values.project!]: Number(values['non-ai-usd']) } } : {}) };
  const now=new Date();
  const start=values.start || new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
  const end=values.end || new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
  let db;
  if(values.mode==='local') {
    const path=resolve(process.env.LOCAL_DATA_DIR || '.local-data/real','postgres');
    await stat(path);
    db=await localPostgres(path,{migrate:false});
  } else db=productionDatabase();
  try {
    const report=await summarizeProviderCosts(db,{start,end,projectId:values.project});
    console.log(JSON.stringify({...report, policy:accountCostPolicyReport(report,policy)},null,2));
  }
  finally {await db.close();}
}
