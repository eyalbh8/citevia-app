if(process.env.NODE_ENV!=='test')throw new Error('Test fixtures cannot be used by the application.');
// Test fixtures only. Never import this module from application or script code.
import { createHash } from 'node:crypto';
import { PARSER_VERSION, WEEKLY_SCHEDULE, type Analysis, type BrandAnalysis, type CapturedAnswer, type EvidenceSpan, type Project, type ScanRun } from '@citevia/core';
import type { AnswerProvider } from '@citevia/storage';

const hash=(text:string)=>parseInt(createHash('sha256').update(text).digest('hex').slice(0,8),16);
export const fixtureTopics=['marketing attribution','customer analytics','conversion tracking','campaign reporting','product analytics','revenue reporting','customer journeys','website analytics','funnel analysis','growth reporting'];
export function fixturePrompts() { return fixtureTopics.flatMap(topic=>[
  `What are the best tools for ${topic} for a growing business?`,
  `Which ${topic} platforms are easiest for a small team to use?`,
  `How should I choose a reliable ${topic} solution?`,
  `Recommend ${topic} software with transparent pricing.`,
  `Which ${topic} providers are best for ecommerce companies?`,
]); }

export class FixtureProvider implements AnswerProvider {
  constructor(private clock:()=>Date=()=>new Date()){}
  async collect(prompt:string,snapshot:ScanRun['snapshot']):Promise<CapturedAnswer>{
    const seed=hash(`${prompt}:${this.clock().toISOString().slice(0,10)}`),mentioned=seed%5!==0,rank=seed%4+1;
    const name=snapshot.brand.name;
    const introduction='For a growing team, compare ease of implementation, reporting depth, and total cost before choosing a platform.';
    const paragraphs=mentioned?[
      introduction,
      `${rank}. ${name} — A strong choice for teams that want clear reporting and a straightforward setup. Its focused analytics can help teams understand which activities contribute to growth.`,
      'Clearview is another option for teams with complex reporting requirements. Metriclane may suit teams that prioritize customizable dashboards.',
      'Choose a shortlist, connect a sample dataset, and compare the reports using the same questions. Pricing and integration coverage should be verified with each provider.',
    ]:[introduction,'Clearview and Metriclane are useful options to evaluate. Clearview emphasizes detailed analysis; Metriclane offers configurable dashboards.','Start with a short trial, confirm the available integrations, and test the reporting against your actual business questions.'];
    const blocks=paragraphs.map((text,i)=>({id:`block_${i}`,text}));
    const urls=[`https://reviewdesk.example/guides/${encodeURIComponent(fixtureTopics[seed%10])}`,`https://${mentioned?'northstar':'clearview'}.example/product`, 'https://analytics-guide.example/compare'];
    const citations=blocks.slice(1).map((block,i)=>({id:`c_${i}`,blockId:block.id,url:urls[i%urls.length],title:i===0?'Analytics software comparison':i===1?'Platform overview':'Choosing an analytics platform',start:0,end:block.text.length}));
    return{providerResponseId:`demo_${seed}`,model:'demo-fixture',status:'completed',blocks,text:blocks.map(b=>b.text).join('\n\n'),citations,sources:[...urls.map(url=>({url})),{url:'https://research.example/analytics-market'}],usage:{inputTokens:75,outputTokens:180,totalTokens:255,searchCalls:1},createdAt:this.clock().toISOString(),raw:{demo:true,label:'Synthetic demonstration data, not an OpenAI response'}};
  }
  async extract(answer:CapturedAnswer,snapshot:ScanRun['snapshot']):Promise<Analysis>{
    const span=(name:string):EvidenceSpan|null=>{const block=answer.blocks.find(b=>b.text.includes(name));if(!block)return null;const start=block.text.indexOf(name);return{blockId:block.id,quote:name,start,end:start+name.length};};
    const brands=[snapshot.brand,...snapshot.competitors].map(brand=>{
      const evidence=span(brand.name);const block=evidence?answer.blocks.find(b=>b.id===evidence.blockId)!:null;
      const ranked=block?.text.match(/^(\d+)\. /);const whole=block?{blockId:block.id,quote:block.text,start:0,end:block.text.length}:null;
      return{brandId:brand.id,mentioned:!!evidence,explicitRank:ranked?Number(ranked[1]):null,mentionOrder:evidence?1:null,sentiment:evidence?(brand.id===snapshot.brand.id?'positive':'neutral'):'not_applicable',evidence:evidence?[evidence]:[],rankEvidence:ranked?whole:null,sentimentEvidence:evidence?whole:null} as BrandAnalysis;
    });
    return{brands,parserVersion:snapshot.parserVersion,model:'demo-fixture',createdAt:this.clock().toISOString(),usage:{inputTokens:200,outputTokens:100,totalTokens:300}};
  }
}

export function newProject(options:{id?:string;name?:string;brand?:string;domain?:string;prompts?:string[];now?:Date}={}):Project{
  const at=(options.now||new Date()).toISOString();
  return{id:options.id||'northstar-demo',name:options.name||'Northstar Analytics',brand:{id:'target',name:options.brand||'Northstar',aliases:['Northstar Analytics'],domains:[options.domain||'northstar.example']},competitors:[{id:'clearview',name:'Clearview',aliases:[],domains:['clearview.example']},{id:'metriclane',name:'Metriclane',aliases:[],domains:['metriclane.example']}],country:'US',language:'en',timezone:'Asia/Nicosia',scheduleExpression:WEEKLY_SCHEDULE,enabled:true,generationModel:process.env.OPENAI_GENERATION_MODEL||'gpt-4.1-2025-04-14',extractionModel:process.env.OPENAI_EXTRACTION_MODEL||'gpt-4.1-mini-2025-04-14',parserVersion:PARSER_VERSION,version:1,prompts:(options.prompts||fixturePrompts()).map((text,i)=>({id:`p_${String(i+1).padStart(2,'0')}`,text,version:1,active:true,branded:false,createdAt:at,updatedAt:at})),createdAt:at,updatedAt:at,scheduleStatus:'synced',scanProviders:[{provider:'openai',model:process.env.OPENAI_GENERATION_MODEL||'gpt-4.1-2025-04-14'}]};
}

