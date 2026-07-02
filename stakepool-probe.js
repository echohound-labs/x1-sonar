require('dotenv').config();
const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAKE_PROG = 'Stake11111111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const IX = ['Initialize','AddValidatorToPool','RemoveValidatorFromPool','DecreaseValidatorStake','IncreaseValidatorStake','SetPreferredValidator','UpdateValidatorListBalance','UpdateStakePoolBalance','CleanupRemovedValidatorEntries','DepositStake','WithdrawStake','SetManager','SetFee','SetStaker','DepositSol','WithdrawSol','CreateTokenMetadata','UpdateTokenMetadata','IncreaseAdditionalValidatorStake','DecreaseAdditionalValidatorStake','Redelegate','DepositStakeWithSlippage','WithdrawStakeWithSlippage','DepositSolWithSlippage','WithdrawSolWithSlippage'];
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str){let n=0n;for(const c of str){const i=B58.indexOf(c);if(i<0)throw new Error('bad');n=n*58n+BigInt(i);}const bytes=[];while(n>0n){bytes.unshift(Number(n%256n));n/=256n;}for(const c of str){if(c==='1')bytes.unshift(0);else break;}return Buffer.from(bytes);}
function b58encode(buf){let n=0n;for(const b of buf)n=n*256n+BigInt(b);let s='';while(n>0n){s=B58[Number(n%58n)]+s;n/=58n;}for(const b of buf){if(b===0)s='1'+s;else break;}return s;}
let rpcId=0;
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;}
async function main(){
  const programId=process.argv[2];const SCAN=parseInt(process.argv[3]||'60',10);
  if(!programId){console.error('usage: node stakepool-probe.js <PROGRAM_ID> [scan]');process.exit(1);}
  console.log(`\nSPL Stake Pool probe · scanning ${SCAN} txs\n${programId}\n`);
  const sigs=await rpc('getSignaturesForAddress',[programId,{limit:SCAN}]);
  const ixTally=new Map();const cpiTally=new Map();let stakeCpiTxs=0;
  for(const s of sigs){
    await sleep(90);let tx;
    try{tx=await rpc('getTransaction',[s.signature,{maxSupportedTransactionVersion:0,encoding:'json'}]);}catch{continue;}
    if(!tx)continue;
    const keys=tx.transaction.message.accountKeys;
    for(const ix of tx.transaction.message.instructions){
      if(keys[ix.programIdIndex]!==programId)continue;
      try{const d=b58decode(ix.data);const v=d[0];const l=IX[v]||`Unknown(#${v})`;ixTally.set(l,(ixTally.get(l)||0)+1);}catch{}
    }
    const invoked=new Set();
    for(const log of tx.meta?.logMessages||[]){const m=log.match(/Program (\w{32,44}) invoke/);if(m&&m[1]!==programId)invoked.add(m[1]);}
    if(invoked.has(STAKE_PROG))stakeCpiTxs++;
    for(const p of invoked)cpiTally.set(p,(cpiTally.get(p)||0)+1);
  }
  console.log(`── Decoded instructions (${sigs.length} txs) ──`);
  for(const [n,c] of [...ixTally].sort((a,b)=>b[1]-a[1]))console.log(`  ${String(c).padStart(3)}×  ${n}`);
  console.log(`\n── Programs invoked (CPI) ──`);
  const nm={[STAKE_PROG]:'Stake Program (native) ★',[SYSTEM]:'System',[TOKEN]:'SPL Token'};
  for(const [p,c] of [...cpiTally].sort((a,b)=>b[1]-a[1]))console.log(`  ${String(c).padStart(3)}×  ${nm[p]||p}`);
  console.log(`\n  Stake Program CPI in ${stakeCpiTxs}/${sigs.length} txs`);
  console.log(`\n── Live pool state ──`);
  try{
    const accts=await rpc('getProgramAccounts',[programId,{encoding:'base64',dataSlice:{offset:0,length:0}}]);
    let best=null;
    for(const a of accts.slice(0,40)){await sleep(60);const f=await rpc('getAccountInfo',[a.pubkey,{encoding:'base64'}]);const buf=Buffer.from(f.value.data[0],'base64');if(buf.length>200&&buf.length<700&&buf[0]===1){best={pubkey:a.pubkey,buf};break;}}
    if(best){const b=best.buf;const pk=(o)=>b58encode(b.subarray(o,o+32));
      console.log(`  StakePool account: ${best.pubkey}`);
      console.log(`  manager:        ${pk(1)}`);
      console.log(`  validator_list: ${pk(98)}`);
      console.log(`  reserve_stake:  ${pk(130)}`);
      console.log(`  pool_mint:      ${pk(162)}`);
      if(b.length>=274){const tl=b.readBigUInt64LE(258);const ps=b.readBigUInt64LE(266);console.log(`  total_lamports: ${tl} (${(Number(tl)/1e9).toFixed(4)} XNT staked)`);console.log(`  pool_token_supply: ${ps}`);}
    }else console.log('  (no StakePool-shaped account in first 40)');
  }catch(e){console.log(`  state read skipped: ${e.message}`);}
  console.log(`\n── Verdict ──`);
  const hasStakeIx=[...ixTally.keys()].some(k=>/Stake|Validator|Deposit|Withdraw/.test(k));
  if(stakeCpiTxs>0||hasStakeIx)console.log('  ✓ CONFIRMED SPL Stake Pool — validator-stake instructions and/or Stake CPIs present.');
  else console.log('  ~ Only crank instructions sampled; instruction decode + pool state above still identify it.');
}
main().catch(e=>{console.error('error:',e.message);process.exit(1);});
