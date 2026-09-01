const fs=require('fs'), path=require('path'), XLSX=require('xlsx');
const mdir="D:/Motor_Payout/FY 26-27_New/July'26/July'26/Bajaj July'26/Grid";
const mf=fs.readdirSync(mdir).find(x=>/RTO.?Master/i.test(x));
const mrows=XLSX.utils.sheet_to_json(XLSX.readFile(path.join(mdir,mf)).Sheets['RTO Master for PC- Comp, SAOD'],{header:1,defval:''});
const nrm=(s)=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

// RTO -> GridState (col0 regn_no_new, col1 district, col2 grid state)
const rtoState={}, rtoDistrict={};
for(let i=1;i<mrows.length;i++){
  const code=nrm(mrows[i][0]); const dist=String(mrows[i][1]||'').trim(); const gs=String(mrows[i][2]||'').trim();
  if(!code||!gs) continue; rtoState[code]=gs; rtoDistrict[code]=dist;
}
// West-UP districts (standard) -> flag UP RTOs whose district is West-UP
const WEST_UP=/SAHARANPUR|SHAMLI|MUZAFFARNAGAR|BAGHPAT|BAGPAT|MEERUT|GHAZIABAD|HAPUR|GAUTAM|NOIDA|BULANDSHAHR|MORADABAD|SAMBHAL|AMROHA|JYOTIBA|RAMPUR|BIJNOR|BAREILLY|PILIBHIT|SHAHJAHANPUR|BADAUN|BUDAUN|ALIGARH|HATHRAS|MATHURA|\bAGRA\b|FIROZABAD|ETAH|KASGANJ|MAINPURI/i;
const upWest=[]; const upAll=[];
for(const code in rtoState){ if(rtoState[code]==='UTTAR PRADESH'){ upAll.push(code); if(WEST_UP.test(rtoDistrict[code])) upWest.push(code); } }

// Rates from the Sept prose (keyed by MASTER Grid State). {dNo,pNo,dNcb,pNcb}
const rates={
  'HARYANA':{dNo:10,pNo:15,dNcb:25,pNcb:25},
  'PONDICHERRY':{dNo:5,pNo:5,dNcb:5,pNcb:5},
  'ORISSA':{dNo:10,pNo:15,dNcb:25,pNcb:30},
  'JAMMU & KASHMIR':{dNo:10,pNo:15,dNcb:25,pNcb:30},
  'ASSAM':{dNo:10,pNo:15,dNcb:30,pNcb:30},
  'CHATTISGARH':{dNo:10,pNo:15,dNcb:30,pNcb:30},
  'REST OF KARNATAKA':{dNo:10,pNo:30,dNcb:30,pNcb:30},
  'KERALA':{dNo:10,pNo:30,dNcb:30,pNcb:30},
  'MADHYA PRADESH':{dNo:10,pNo:20,dNcb:30,pNcb:30},
  'PUNJAB':{dNo:10,pNo:30,dNcb:30,pNcb:30},
  'RAJASTHAN':{dNo:10,pNo:15,dNcb:30,pNcb:30},
  'REST OF TAMIL NADU':{dNo:10,pNo:15,dNcb:30,pNcb:30},
  'REST OF TELANGANA':{dNo:10,pNo:35,dNcb:35,pNcb:35},
  // UP: non-NCB flat 10 both fuels; NCB West->2.5(IRDA), Rest->35 (handled in resolver via upWest)
  'UTTAR PRADESH':{dNo:10,pNo:10,dNcb:35,pNcb:35,ncbWestIrda:2.5},
};
const _default={dNo:15,pNo:40,dNcb:45,pNcb:45};   // "Excluding Below RTO"
const existingGrid=['JHARKHAND'];  // leave on prior grid
const hevMakes=['AUDI','BENTLEY','BMW','CADILLAC','HUMMER','JAGUAR','LEXUS','MAYBACH','MERCEDES','PORSCHE','ROLLS ROYCE','ROVER','LAND ROVER'];

const cfg={ _source:"Ro Bajaj Pvt Car.xlsx (Sep'26) + RTO_Master-_ALL.xlsx PC sheet",
  _note:"Bajaj Pvt-Car Comp Sep'26 prose grid. rates keyed by RTO-master Grid State; DEFAULT for states not listed; UP split West(IRDA 2.5% NCB)/Rest(35%); Jharkhand keeps prior grid; HEV treaty makes separate.",
  rtoState, upWest, rates, default:_default, existingGrid, hevMakes };
fs.writeFileSync(path.join(__dirname,'..','config','bajaj_pvtcar_sep26.json'), JSON.stringify(cfg));
console.log("RTO->GridState:",Object.keys(rtoState).length,"| UP total:",upAll.length,"| UP-West flagged:",upWest.length);
console.log("UP-West RTOs:",upWest.sort().join(","));
console.log("rate regions:",Object.keys(rates).length,"| default:",JSON.stringify(_default));
// which grid states get DEFAULT (not in rates, not existingGrid)?
const listed=new Set([...Object.keys(rates),...existingGrid]);
const defStates=[...new Set(Object.values(rtoState))].filter(s=>!listed.has(s));
console.log("states -> DEFAULT ("+defStates.length+"):",defStates.join(", "));
