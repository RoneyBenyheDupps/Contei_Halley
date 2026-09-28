import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createPool } from '../src/db.ts';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('processo único inicia API com configuração obrigatória e JWT sintético', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const pool = await createPool('app');
  try {
    await pool.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id=1) INSERT INTO contei.EmpresaFiscal (id,halleyCompanyId,cnpj,status,activatedAt,qiveConnectionRef,qiveValidatedAt,qiveValidationEvidenceRef,certificateEvidenceRef,completeCaptureEvidenceRef) VALUES (1,'fixture-halley','11222333000181','ACTIVE','2026-01-01T00:00:00+00:00','fixture-qive','2026-01-01T00:00:00+00:00','fixture-only','fixture-only','fixture-only')");
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
  } finally { await pool.close(); }
  const port = 40000 + Math.floor(Math.random() * 20000);
  const secret = 'segredo-sintetico-para-processo-local';
  const entrypoint = fileURLToPath(new URL(`../src/main${extname(import.meta.filename)}`, import.meta.url));
  const child = spawn(process.execPath, [entrypoint], { cwd: process.cwd(), env: {
    ...process.env, CONTEI_CNPJ: '11222333000181', CONTEI_SYNC_ENABLED: 'false', CONTEI_API_PORT: String(port), CONTEI_API_HOST: '127.0.0.1',
    CONTEI_MAX_DECISION_BYTES: '4096', CONTEI_DEFAULT_PAGE_LIMIT: '10', CONTEI_MAX_PAGE_LIMIT: '20',
    HALLEY_JWT_ISSUER: 'halley-fixture', HALLEY_JWT_AUDIENCE: 'contei-fixture', HALLEY_JWT_ALGORITHM: 'HS256',
    HALLEY_JWT_SHARED_SECRET: secret, HALLEY_PERMISSION_CLAIM: 'permission', HALLEY_FISCAL_PERMISSION: 'fiscal', HALLEY_JWT_IAT_TOLERANCE_SECONDS: '5',
  }, stdio: 'ignore' });
  try {
    const token = await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
      .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(new TextEncoder().encode(secret));
    let response: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) throw new Error('Processo Contei encerrou antes de iniciar');
      try { response = await fetch(`http://127.0.0.1:${port}/api/v1/triagem/nfe`, { headers: { Authorization: `Bearer ${token}` } }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(response, 'API não iniciou');
    assert.equal(response.status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await ended;
    }
  }
});
