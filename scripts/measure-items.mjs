import { performance } from 'node:perf_hooks';
import { SignJWT } from 'jose';
import { createApi } from '../src/api.ts';
import { createPool, ingestSnapshot, migrate } from '../src/db.ts';

function keyFor(seed) {
  const base = '35260911222333000181550010000001231000001230'.slice(0, 34) + String(seed).padStart(8, '0') + '3';
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
  const digit = 11 - sum % 11;
  return base + String(digit >= 10 ? 0 : digit);
}

function xmlFor(key, count, broken = false) {
  const items = Array.from({ length: count }, (_, index) => `<det nItem="${index + 1}"><prod><cProd>ITEM-${index + 1}</cProd><xProd>Produto sintético ${index + 1}</xProd><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.0000000000</vUnCom><vProd>10.00</vProd></prod><imposto><ICMS><ICMS00><CST>00</CST><vBC>10.00</vBC><pICMS>18.00</pICMS><vICMS>1.80</vICMS>${broken ? '<vNovo>9.99</vNovo>' : ''}</ICMS00></ICMS></imposto></det>`).join('');
  return Buffer.from(`<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${key}"><ide><nNF>123</nNF><dhEmi>2026-09-24T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Emitente</xNome></emit><dest><CNPJ>11222333000181</CNPJ><xNome>Destinatário</xNome></dest>${items}<total><ICMSTot><vNF>1000.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>${key}</chNFe><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`);
}

function summary(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return { count: sorted.length, within3s: sorted.filter((time) => time <= 3000).length,
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: Math.round(sorted.at(-1)) };
}

if (!process.env.MSSQL_DATABASE?.startsWith('ConteiTriagemTest_')) throw new Error('A medição só pode usar o MSSQL isolado de testes');

const deploy = await createPool('deploy');
const app = await createPool('app');
const ids = [];
async function cleanup(documentIds) {
  const exactIds = [...new Set(documentIds)].filter((id) => Number.isSafeInteger(id) && id > 0).join(',');
  if (!exactIds) return;
  await deploy.request().query(`DELETE FROM contei.FalhaIntegracao WHERE documentoId IN (${exactIds})`);
  await deploy.request().query(`DELETE FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId IN (SELECT id FROM contei.OcorrenciaDocumental WHERE documentoId IN (${exactIds}))`);
  await deploy.request().query(`UPDATE contei.DocumentoEntrada SET firstXmlOccurrenceId=NULL,latestValidXmlOccurrenceId=NULL WHERE id IN (${exactIds})`);
  await deploy.request().query(`DELETE FROM contei.OcorrenciaDocumental WHERE documentoId IN (${exactIds})`);
  await deploy.request().query(`DELETE FROM contei.DocumentoEntrada WHERE id IN (${exactIds})`);
}
let server;
try {
  await migrate(deploy);
  const leftovers = await deploy.request().query(`SELECT DISTINCT d.id FROM contei.DocumentoEntrada d JOIN contei.OcorrenciaDocumental o ON o.documentoId=d.id
    WHERE o.kind='SNAPSHOT' AND CONVERT(varchar(max),o.rawPayload) LIKE '%"Marker":"measure-items"%'`);
  await cleanup(leftovers.recordset.map((row) => Number(row.id)));
  await app.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id=1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
  await app.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
  const jwtKey = new TextEncoder().encode('segredo-sintetico-para-medicao-local');
  server = createApi(app, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key: jwtKey,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const headers = { Authorization: `Bearer ${await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
    .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('30m').sign(jwtKey)}` };
  const call = async (key, expected) => {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/triagem/nfe/${key}/items`, { headers });
    const result = await response.json();
    const elapsed = performance.now() - start;
    if (response.status !== 200 || result.status !== expected || expected === 'AVAILABLE' && result.items.length !== 100) throw new Error(`Medição inválida: ${response.status}/${result.status}`);
    return elapsed;
  };
  let seed = Math.floor(Math.random() * 9e7);
  const nextKey = () => keyFor(seed++);
  const ingest = async (key, xmlBytes) => {
    const existing = await app.request().input('key', key).query('SELECT 1 AS found FROM contei.DocumentoEntrada WHERE empresaId=1 AND accessKey=@key');
    if (existing.recordset.length) throw new Error('Colisão de chave sintética da medição');
    ids.push(await ingestSnapshot(app, { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Marker: 'measure-items' })), xmlBytes }));
  };
  const available = [];
  for (let index = 0; index < 100; index++) { const key = nextKey(); await ingest(key, xmlFor(key, 100)); available.push(key); }
  const awaiting = [];
  for (let index = 0; index < 50; index++) { const key = nextKey(); await ingest(key); awaiting.push(key); }
  const failed = [];
  for (let index = 0; index < 50; index++) { const key = nextKey(); await ingest(key, xmlFor(key, 1, true)); failed.push(key); }
  for (const key of failed) await call(key, 'EXTRACTION_FAILED');
  const cold = []; for (const key of available) cold.push(await call(key, 'AVAILABLE'));
  const warm = []; for (const key of available) warm.push(await call(key, 'AVAILABLE'));
  const unavailable = [];
  for (const key of awaiting) unavailable.push(await call(key, 'AWAITING_XML'));
  for (const key of failed) unavailable.push(await call(key, 'EXTRACTION_FAILED'));
  const serverVersion = await app.request().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(40)) AS version");
  console.log(JSON.stringify({ node: process.version, sqlServer: serverVersion.recordset[0].version, mode: 'localhost sequential synthetic isolated MSSQL', cold: summary(cold), warm: summary(warm), unavailable: summary(unavailable) }));
} finally {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await cleanup(ids);
  await app.close();
  await deploy.close();
}
