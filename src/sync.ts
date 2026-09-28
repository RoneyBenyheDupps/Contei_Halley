import sql from 'mssql';
import { ingestSnapshot, type SqlPool } from './db.ts';
import { QiveError, type createQiveClient } from './qive.ts';

// ponytail: trava local basta para uma instância; réplicas exigirão coordenação pelo SQL Server.
let running = false;

export async function runDiscovery(pool: SqlPool, qive: Pick<ReturnType<typeof createQiveClient>, 'listPage'>, now: Date, overlapMs: number) {
  if (!Number.isSafeInteger(overlapMs) || overlapMs < 1) throw new Error('Sobreposição da descoberta inválida');
  if (running) return { processed: 0, skipped: true };
  running = true;
  try {
    const company = await pool.request().query('SELECT status,activatedAt FROM contei.EmpresaFiscal WHERE id=1');
    if (!company.recordset.length || company.recordset[0].status !== 'ACTIVE') return { processed: 0, skipped: true };
    const checkpoint = await pool.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    const covered = checkpoint.recordset[0]?.newRecordsCoveredUntil;
    const coveredAt = covered == null ? null : new Date(covered).getTime();
    if (coveredAt !== null && coveredAt > now.getTime()) throw new Error('Relógio anterior ao checkpoint');
    const activatedAt = new Date(company.recordset[0].activatedAt).getTime();
    const from = new Date(Math.max(activatedAt, coveredAt === null ? activatedAt : coveredAt - overlapMs)).toISOString();
    if (Date.parse(from) > now.getTime()) throw new Error('Relógio anterior à ativação');
    let paginator: string | undefined;
    const seen = new Set<string>();
    let processed = 0;
    let failedItems = 0;
    do {
      const page = await qive.listPage(from, now.toISOString(), paginator);
      failedItems += page.failedItems ?? 0;
      for (const item of page.items) {
        await ingestSnapshot(pool, item);
        processed++;
      }
      paginator = page.nextPaginator || undefined;
      if (paginator) {
        if (seen.has(paginator)) throw new Error('Paginação Qive repetida');
        seen.add(paginator);
      }
    } while (paginator);
    if (failedItems) throw new QiveError(`${failedItems} item(ns) Qive incompatível(is)`);
    await pool.request().input('until', sql.DateTimeOffset, now).query(`
      IF EXISTS (SELECT 1 FROM contei.SyncCheckpoint WHERE empresaId=1)
        UPDATE contei.SyncCheckpoint SET newRecordsCoveredUntil=@until,lastSuccessfulNewPollAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00') WHERE empresaId=1;
      ELSE
        INSERT INTO contei.SyncCheckpoint (empresaId,newRecordsCoveredUntil,lastSuccessfulNewPollAt)
        VALUES (1,@until,TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'));`);
    return { processed, skipped: false };
  } finally { running = false; }
}
