require("dotenv").config();
const fs=require("fs");
const { getPool }=require("./db/connection");
const { buildLucaBuffer }=require("./services/luca-export");
(async()=>{
  const pool=await getPool();
  // cards effective on 2026-09-01 (Sept generation): effective_from <= Sep1 AND (effective_to IS NULL OR > Sep1)
  const r=await pool.request().query(`
    SELECT id, insurer FROM rate_cards
    WHERE status='active'
      AND (effective_from IS NULL OR effective_from <= '2026-09-01')
      AND (effective_to IS NULL OR effective_to > '2026-09-01')`);
  const ids=r.recordset.map(x=>x.id);
  console.log("Sept-effective cards:",ids.length);
  // insurers with a card effective_from >= Sep 1 (genuinely Sept generation)
  const sep=await pool.request().query(`SELECT DISTINCT LOWER(insurer) ins FROM rate_cards WHERE status='active' AND effective_from='2026-09-01'`);
  console.log("insurers with a Sept-1 card:",sep.recordset.map(x=>x.ins).join(", "));
  const buf=await buildLucaBuffer(ids,{products:["CAR","TW","GCV"], flatMargin:5});
  const out="C:/Users/ribweb07/AppData/Local/Temp/claude/D--Code-RateExtract/5a8eb4b2-6123-4f1f-8ce4-3c2ebea5d791/scratchpad/luca_all_Sept2026_5pct.xlsx";
  fs.writeFileSync(out, buf);
  console.log("WROTE", out, "("+buf.length+" bytes)");
  process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1);});
