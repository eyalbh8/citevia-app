import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { productionDatabase, summarizeProviderCosts } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';

const {values}=parseArgs({options:{mode:{type:'string',default:'local'},project:{type:'string'},start:{type:'string'},end:{type:'string'},help:{type:'boolean'}}});
if(values.help) console.log('Usage: npm run costs:report -- [--mode local|aws] [--project ID] [--start ISO_DATE] [--end ISO_DATE]\nRead-only. End is exclusive. Defaults to the current UTC month. Never applies migrations.');
else {
  if(!['local','aws'].includes(values.mode)) throw new Error('Use --mode local or aws.');
  const now=new Date();
  const start=values.start || new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
  const end=values.end || new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
  let db;
  if(values.mode==='local') {
    const path=resolve(process.env.LOCAL_DATA_DIR || '.local-data/real','postgres');
    await stat(path);
    db=await localPostgres(path,{migrate:false});
  } else db=productionDatabase();
  try {console.log(JSON.stringify(await summarizeProviderCosts(db,{start,end,projectId:values.project}),null,2));}
  finally {await db.close();}
}
