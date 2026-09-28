import { readFile } from 'node:fs/promises';
import { createSecretKey } from 'node:crypto';
import { importSPKI } from 'jose';
import { createApi } from './api.ts';
import { createPool } from './db.ts';
import { createQiveClient } from './qive.ts';
import { runDiscovery } from './sync.ts';
import { oneOf, positive, readQiveConfig, required } from './config.ts';

async function main() {
  const algorithm = required('HALLEY_JWT_ALGORITHM');
  const key = algorithm === 'HS256'
    ? createSecretKey(Buffer.from(required('HALLEY_JWT_SHARED_SECRET'), 'utf8'))
    : await importSPKI(await readFile(required('HALLEY_JWT_PUBLIC_KEY_FILE'), 'utf8'), algorithm);
  const pool = await createPool('app');
  try {
    const company = await pool.request().query('SELECT cnpj FROM contei.EmpresaFiscal WHERE id=1');
    if (!company.recordset.length || company.recordset[0].cnpj !== required('CONTEI_CNPJ')) throw new Error('Empresa fiscal não provisionada para o CNPJ configurado');
    const server = createApi(pool, {
      issuer: required('HALLEY_JWT_ISSUER'), audience: required('HALLEY_JWT_AUDIENCE'), algorithm, key,
      permissionClaim: required('HALLEY_PERMISSION_CLAIM'), fiscalPermission: required('HALLEY_FISCAL_PERMISSION'),
      maxDecisionBytes: positive('CONTEI_MAX_DECISION_BYTES'), defaultPageLimit: positive('CONTEI_DEFAULT_PAGE_LIMIT'),
      maxPageLimit: positive('CONTEI_MAX_PAGE_LIMIT'), iatToleranceSeconds: positive('HALLEY_JWT_IAT_TOLERANCE_SECONDS'),
    });
    let timer: NodeJS.Timeout | undefined;
    if (oneOf('CONTEI_SYNC_ENABLED', ['true', 'false'] as const) === 'true') {
      const qive = createQiveClient(readQiveConfig(required('CONTEI_CNPJ')));
      const interval = positive('CONTEI_SYNC_INTERVAL_MS');
      const overlapMs = positive('CONTEI_SYNC_OVERLAP_MS');
      const cycle = async () => {
        try { await runDiscovery(pool, qive, new Date(), overlapMs); }
        catch { process.stderr.write(JSON.stringify({ code: 'SYNC_FAILURE', message: 'Falha no ciclo de captura' }) + '\n'); }
      };
      timer = setInterval(() => { void cycle(); }, interval);
      void cycle();
    }
    const port = positive('CONTEI_API_PORT');
    await new Promise<void>((resolve) => server.listen(port, required('CONTEI_API_HOST'), resolve));
    const stop = async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.close();
    };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
  } catch (error) {
    await pool.close();
    throw error;
  }
}

if (import.meta.main) await main();
