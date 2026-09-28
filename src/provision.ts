import { readFile } from 'node:fs/promises';
import sql from 'mssql';
import { createPool, type SqlPool } from './db.ts';
import { createQiveClient } from './qive.ts';
import { isValidAccessKey, isValidCnpj } from './triagem.ts';
import { readQiveConfig } from './config.ts';

export type ActivationProof = {
  cnpj: string;
  knownReceivedAccessKey: string;
  validatedAt: string;
  qiveValidationEvidenceRef: string;
  certificateEvidenceRef: string;
  completeCaptureEvidenceRef: string;
};

export async function provisionCompany(pool: SqlPool, company: { halleyCompanyId: string; cnpj: string; qiveConnectionRef: string }) {
  if (!company.halleyCompanyId || !isValidCnpj(company.cnpj) || !company.qiveConnectionRef) throw new Error('Cadastro fiscal incompleto');
  const existing = await pool.request().query('SELECT * FROM contei.EmpresaFiscal WHERE id=1');
  if (existing.recordset.length) {
    if (existing.recordset[0].halleyCompanyId !== company.halleyCompanyId || existing.recordset[0].cnpj !== company.cnpj || existing.recordset[0].qiveConnectionRef !== company.qiveConnectionRef) throw new Error('Empresa fiscal já cadastrada com dados diferentes');
    return;
  }
  await pool.request().input('halley', sql.NVarChar(100), company.halleyCompanyId).input('cnpj', sql.Char(14), company.cnpj)
    .input('qive', sql.NVarChar(200), company.qiveConnectionRef)
    .query("INSERT INTO contei.EmpresaFiscal (id,halleyCompanyId,cnpj,status,qiveConnectionRef) VALUES (1,@halley,@cnpj,'INACTIVE',@qive)");
}

export async function activateCompany(pool: SqlPool, proof: ActivationProof, verifyReceivedAccess: (key: string) => Promise<boolean>) {
  if (!isValidCnpj(proof.cnpj) || !isValidAccessKey(proof.knownReceivedAccessKey) || !Number.isFinite(Date.parse(proof.validatedAt)) ||
      !proof.qiveValidationEvidenceRef?.trim() || !proof.certificateEvidenceRef?.trim() || !proof.completeCaptureEvidenceRef?.trim()) {
    throw new Error('Ativação exige prova de conta/CNPJ, certificado apto e captura completa');
  }
  const company = await pool.request().query('SELECT cnpj,status FROM contei.EmpresaFiscal WHERE id=1');
  if (!company.recordset.length || company.recordset[0].cnpj !== proof.cnpj) throw new Error('CNPJ de ativação não corresponde à empresa');
  if (company.recordset[0].status === 'ACTIVE') return;
  if (!await verifyReceivedAccess(proof.knownReceivedAccessKey)) throw new Error('Acesso a NF-e recebida na conta Qive não comprovado');
  await pool.request().input('validatedAt', sql.DateTimeOffset, new Date(proof.validatedAt))
    .input('qiveEvidence', sql.NVarChar(500), proof.qiveValidationEvidenceRef)
    .input('certificateEvidence', sql.NVarChar(500), proof.certificateEvidenceRef)
    .input('captureEvidence', sql.NVarChar(500), proof.completeCaptureEvidenceRef)
    .query(`UPDATE contei.EmpresaFiscal SET status='ACTIVE', activatedAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),
      qiveValidatedAt=@validatedAt, qiveValidationEvidenceRef=@qiveEvidence,
      certificateEvidenceRef=@certificateEvidence, completeCaptureEvidenceRef=@captureEvidence WHERE id=1 AND status='INACTIVE'`);
}

export async function deactivateCompany(pool: SqlPool) {
  await pool.request().query("UPDATE contei.EmpresaFiscal SET status='INACTIVE' WHERE id=1");
}

if (import.meta.main) {
  const pool = await createPool('app');
  try {
    await provisionCompany(pool, { halleyCompanyId: process.env.HALLEY_COMPANY_ID || '', cnpj: process.env.CONTEI_CNPJ || '', qiveConnectionRef: process.env.QIVE_CONNECTION_REF || '' });
    if (process.argv.includes('--activate')) {
      const evidencePath = process.env.CONTEI_ACTIVATION_EVIDENCE_FILE;
      if (!evidencePath) throw new Error('Arquivo de evidência de ativação obrigatório');
      const proof = JSON.parse(await readFile(evidencePath, 'utf8')) as ActivationProof;
      const qive = createQiveClient(readQiveConfig(proof.cnpj));
      await activateCompany(pool, proof, async (key) => {
        const item = await qive.getKnown(key);
        if (!item) return false;
        const raw = JSON.parse(item.rawPayload.toString('utf8')) as Record<string, unknown>;
        return raw.Owner === proof.cnpj && raw.OwnerRole === process.env.QIVE_RECEIVED_ROLE;
      });
    }
  } finally { await pool.close(); }
}
