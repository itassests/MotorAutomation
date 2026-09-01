require("dotenv").config();
const fs=require("fs");
const { getPool }=require("./db/connection");
const { buildLucaBuffer }=require("./services/luca-export");
(async()=>{
  const pool=await getPool();
  // Cards in force as of the Sept-2026 risk date. The engine selects by NEWEST
  // effective_from <= risk-date (it does NOT gate on effective_to — cards are
  // chained, so a July card carries effective_to=Jul01 yet is still the latest
  // grid in Sept for insurers who haven't re-filed). buildLucaBuffer already
  // dedups each rate cell to the newest generation, so pass every active card
  // with effective_from <= Sep1 and let it keep the newest: Tata/Bajaj land on
  // their Sept cells, everyone else on their latest (usually July) grid. Gating
  // on effective_to>Sep1 (the earlier bug) dropped all 12 July-latest insurers.
  const r=await pool.request().query(`
    SELECT id, insurer FROM rate_cards
    WHERE status='active'
      AND (effective_from IS NULL OR effective_from <= '2026-09-01')`);
  const ids=r.recordset.map(x=>x.id);
  console.log("Sept-effective cards:",ids.length);
  // insurers with a card effective_from >= Sep 1 (genuinely Sept generation)
  const sep=await pool.request().query(`SELECT DISTINCT LOWER(insurer) ins FROM rate_cards WHERE status='active' AND effective_from='2026-09-01'`);
  console.log("insurers with a Sept-1 card:",sep.recordset.map(x=>x.ins).join(", "));
  const buf=await buildLucaBuffer(ids,{products:["CAR","TW","GCV"], flatMargin:5, asOfDate:"2026-09-01"});
  const out="C:/Users/ribweb07/AppData/Local/Temp/claude/D--Code-RateExtract/5a8eb4b2-6123-4f1f-8ce4-3c2ebea5d791/scratchpad/luca_all_Sept2026_5pct_v3.xlsx";
  fs.writeFileSync(out, buf);
  console.log("WROTE", out, "("+buf.length+" bytes)");
  process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1);});
