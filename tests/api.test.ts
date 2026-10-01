import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApi } from '../src/api.ts';
import { createPool, ingestSnapshot, migrate, recordDecision, type SqlPool } from '../src/db.ts';
import { createHash } from 'node:crypto';

function keyFor(seed: number) {
  const base = '35260911222333000181550010000001231000001230'.slice(0, 34) + seed.toString().padStart(8, '0') + '3';
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
  const digit = 11 - sum % 11;
  return base + String(digit >= 10 ? 0 : digit);
}

function xmlFor(accessKey: string, receiverCnpj: string) {
  return Buffer.from(`<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${accessKey}"><ide><nNF>123</nNF><dhEmi>2026-09-24T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Emitente</xNome></emit><dest><CNPJ>${receiverCnpj}</CNPJ><xNome>Destinatário</xNome></dest><total><ICMSTot><vNF>9007199254740.99</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>${accessKey}</chNFe><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`);
}

function itemXmlFor(accessKey: string, productCode = 'ITEM-1') {
  return Buffer.from(xmlFor(accessKey, '11222333000181').toString().replace('<total>',
    `<det nItem="1"><prod><cProd>${productCode}</cProd><xProd>Produto sintético</xProd><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.0000000000</vUnCom><vProd>10.00</vProd></prod><imposto><ICMS><ICMS00><CST>00</CST><vBC>10.00</vBC><pICMS>18.00</pICMS><vICMS>1.80</vICMS></ICMS00></ICMS></imposto></det><total>`));
}

test('API fiscal persiste itens por versão e reutiliza o conjunto completo', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const deploy = await createPool('deploy');
  const pool = await createPool('app');
  await migrate(deploy);
  const jwtKey = new TextEncoder().encode('segredo-sintetico-para-teste-de-itens');
  const server = createApi(pool, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key: jwtKey,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const auth = async (permission: string) => ({ Authorization: `Bearer ${await new SignJWT({ permission }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
    .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(jwtKey)}` });
  const key = keyFor(Math.floor(Math.random() * 1e8));
  const source = itemXmlFor(key);
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${key}/items`;
  try {
    await pool.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id=1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    await ingestSnapshot(pool, { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Status: 'authorized' })), xmlBytes: source });
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: await auth('other') })).status, 403);
    const headers = await auth('fiscal');
    const first = await fetch(endpoint, { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const body = await first.json() as any;
    assert.equal(body.status, 'AVAILABLE');
    assert.deepEqual(body.items, [{ nItem: 1, product: { cProd: 'ITEM-1', xProd: 'Produto sintético', uCom: 'UN', qCom: '1.0000', vUnCom: '10.0000000000', vProd: '10.00' }, taxes: {
      ICMS: { variant: 'ICMS00', fields: { CST: '00', vBC: '10.00', pICMS: '18.00', vICMS: '1.80' } },
    } }]);
    assert.equal(body.xmlVersion.sha256, createHash('sha256').update(source).digest('hex'));
    const downloaded = await fetch(`http://127.0.0.1:${address.port}${body.xmlVersion.downloadPath}`, { headers });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), source);
    const persisted = await pool.request().input('id', body.xmlVersion.occurrenceId).query('SELECT itemsJson,extractedAt FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.equal(persisted.recordset.length, 1);
    assert.deepEqual(JSON.parse(persisted.recordset[0].itemsJson), body.items);
    const again = await (await fetch(endpoint, { headers })).json() as any;
    assert.deepEqual(again.items, body.items);
    const after = await pool.request().input('id', body.xmlVersion.occurrenceId).query('SELECT extractedAt FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.deepEqual(after.recordset[0].extractedAt, persisted.recordset[0].extractedAt);

    const concurrentKey = keyFor(Math.floor(Math.random() * 1e8));
    await ingestSnapshot(pool, { accessKey: concurrentKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: concurrentKey })), xmlBytes: itemXmlFor(concurrentKey, 'CONCURRENT') });
    const concurrentUrl = `http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${concurrentKey}/items`;
    const simultaneous = await Promise.all([fetch(concurrentUrl, { headers }), fetch(concurrentUrl, { headers })]);
    assert.deepEqual(simultaneous.map((response) => response.status), [200, 200]);
    const concurrentBodies = await Promise.all(simultaneous.map((response) => response.json())) as any[];
    assert.deepEqual(concurrentBodies[0].items, concurrentBodies[1].items);
    const count = await pool.request().input('id', concurrentBodies[0].xmlVersion.occurrenceId)
      .query('SELECT COUNT(*) AS count FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.equal(count.recordset[0].count, 1);

    const corruptKey = keyFor(Math.floor(Math.random() * 1e8));
    const corruptSource = itemXmlFor(corruptKey, 'INTEGRITY');
    await ingestSnapshot(pool, { accessKey: corruptKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: corruptKey })), xmlBytes: corruptSource });
    const corrupt = await deploy.request().input('key', corruptKey)
      .query("SELECT o.id FROM contei.OcorrenciaDocumental o JOIN contei.DocumentoEntrada d ON d.id=o.documentoId WHERE d.accessKey=@key AND o.kind='XML'");
    const corruptId = String(corrupt.recordset[0].id);
    await deploy.request().input('id', corruptId).input('hash', Buffer.alloc(32)).query('UPDATE contei.OcorrenciaDocumental SET sha256=@hash WHERE id=@id');
    try {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${corruptKey}/items`, { headers })).status, 500);
      const missing = await pool.request().input('id', corruptId).query('SELECT COUNT(*) AS count FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
      assert.equal(missing.recordset[0].count, 0);
    } finally {
      await deploy.request().input('id', corruptId).input('hash', createHash('sha256').update(corruptSource).digest())
        .query('UPDATE contei.OcorrenciaDocumental SET sha256=@hash WHERE id=@id');
    }

    const rejectedKey = keyFor(Math.floor(Math.random() * 1e8));
    await ingestSnapshot(pool, { accessKey: rejectedKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: rejectedKey })), xmlBytes: itemXmlFor(rejectedKey, 'REJECTED') });
    const rejected = await deploy.request().input('key', rejectedKey)
      .query("SELECT o.id FROM contei.OcorrenciaDocumental o JOIN contei.DocumentoEntrada d ON d.id=o.documentoId WHERE d.accessKey=@key AND o.kind='XML'");
    const rejectedId = Number(rejected.recordset[0].id);
    await deploy.request().batch(`CREATE OR ALTER TRIGGER contei.TestRejectItems ON contei.ItensNfeExtraidos AFTER INSERT AS BEGIN IF EXISTS (SELECT 1 FROM inserted WHERE xmlOccurrenceId=${rejectedId}) THROW 51000, 'fixture', 1; END`);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${rejectedKey}/items`, { headers })).status, 500);
      const missing = await pool.request().input('id', rejectedId).query('SELECT COUNT(*) AS count FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
      assert.equal(missing.recordset[0].count, 0);
    } finally {
      await deploy.request().query('DROP TRIGGER IF EXISTS contei.TestRejectItems');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.close();
    await deploy.close();
  }
});

test('API seleciona a versão mais recente e permite consultar uma versão válida anterior', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const pool = await createPool('app');
  const jwtKey = new TextEncoder().encode('segredo-sintetico-para-teste-de-versoes');
  const server = createApi(pool, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key: jwtKey,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const headers = { Authorization: `Bearer ${await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
    .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(jwtKey)}` };
  const key = keyFor(Math.floor(Math.random() * 1e8));
  const otherKey = keyFor(Math.floor(Math.random() * 1e8));
  const url = `http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${key}`;
  try {
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    for (const code of ['OLD', 'NEW']) await ingestSnapshot(pool, { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Code: code })), xmlBytes: itemXmlFor(key, code) });
    await ingestSnapshot(pool, { accessKey: otherKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: otherKey })), xmlBytes: itemXmlFor(otherKey) });
    await ingestSnapshot(pool, { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Code: 'BROKEN' })), xmlBytes: Buffer.from('<broken>') });
    const detail = await (await fetch(url, { headers })).json() as any;
    assert.equal(detail.xmlVersions.length, 2);
    const [oldVersion, newVersion] = detail.xmlVersions;
    const defaultResult = await (await fetch(`${url}/items`, { headers })).json() as any;
    assert.equal(defaultResult.xmlVersion.occurrenceId, newVersion.occurrenceId);
    assert.equal(defaultResult.items[0].product.cProd, 'NEW');
    const oldResult = await (await fetch(`${url}/items?xmlOccurrenceId=${oldVersion.occurrenceId}`, { headers })).json() as any;
    assert.equal(oldResult.xmlVersion.occurrenceId, oldVersion.occurrenceId);
    assert.equal(oldResult.items[0].product.cProd, 'OLD');
    assert.equal(oldResult.xmlVersion.sha256, oldVersion.sha256);
    const otherDetail = await (await fetch(`http://127.0.0.1:${address.port}/api/v1/triagem/nfe/${otherKey}`, { headers })).json() as any;
    const invalid = await pool.request().input('key', key).query("SELECT TOP (1) o.id FROM contei.OcorrenciaDocumental o JOIN contei.DocumentoEntrada d ON d.id=o.documentoId WHERE d.accessKey=@key AND o.kind='XML' AND o.isValidXml=0 ORDER BY o.id DESC");
    assert.equal((await fetch(`${url}/items?xmlOccurrenceId=abc`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/items?xmlOccurrenceId=0`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/items?xmlOccurrenceId=${otherDetail.xmlVersions[0].occurrenceId}`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/items?xmlOccurrenceId=${invalid.recordset[0].id}`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.close();
  }
});

test('API distingue ausência de XML, falha por versão e recuperação sem mudar a triagem', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const pool = await createPool('app');
  const jwtKey = new TextEncoder().encode('segredo-sintetico-para-teste-de-falha');
  const server = createApi(pool, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key: jwtKey,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const headers = { Authorization: `Bearer ${await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
    .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(jwtKey)}` };
  const base = `http://127.0.0.1:${address.port}/api/v1/triagem/nfe`;
  let seed = Math.floor(Math.random() * 1e8);
  const nextKey = () => keyFor(seed++);
  const capture = (accessKey: string, canceled: boolean, xmlBytes?: Buffer, state = 'authorized') => ingestSnapshot(pool, {
    accessKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: state, canceled,
    rawPayload: Buffer.from(JSON.stringify({ AccessKey: accessKey, State: state })), xmlBytes,
  });
  const get = async (accessKey: string, suffix = 'items') => {
    const response = await fetch(`${base}/${accessKey}/${suffix}`, { headers });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  try {
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    const waitingKey = nextKey();
    await capture(waitingKey, false);
    const waiting = await get(waitingKey);
    assert.equal(waiting.status, 'AWAITING_XML');
    assert.equal(Object.hasOwn(waiting, 'items'), false);
    assert.equal(Object.hasOwn(waiting, 'xmlVersion'), false);
    await capture(waitingKey, false, itemXmlFor(waitingKey), 'xml-received');
    assert.equal((await get(waitingKey)).status, 'AVAILABLE');

    const canceledWithoutXmlKey = nextKey();
    await capture(canceledWithoutXmlKey, true);
    const canceledWithoutXml = await get(canceledWithoutXmlKey);
    assert.equal(canceledWithoutXml.status, 'CANCELED_XML_UNAVAILABLE');
    assert.equal(Object.hasOwn(canceledWithoutXml, 'items'), false);
    const canceledWithXmlKey = nextKey();
    await capture(canceledWithXmlKey, true, itemXmlFor(canceledWithXmlKey));
    assert.equal((await get(canceledWithXmlKey)).status, 'AVAILABLE');
    assert.equal((await get(canceledWithXmlKey, '')).canceled, true);

    const decidedKey = nextKey();
    await capture(decidedKey, false, itemXmlFor(decidedKey));
    const beforeDecision = await get(decidedKey, '');
    const decision = await recordDecision(pool, decidedKey, { id: 'fiscal-fixture', role: 'fiscal' }, '1efbf8f8-6fae-4b0a-9a0b-c365cefe7892',
      { expectedReviewVersion: beforeDecision.reviewVersion, outcome: 'NO_ACTION', reasonCode: 'NO_RELEVANT_DIVERGENCE' });
    assert.equal((await get(decidedKey)).status, 'AVAILABLE');
    assert.equal((await get(decidedKey, '')).currentDecision.id, decision.decision.id);

    const invalidKey = nextKey();
    await capture(invalidKey, false, Buffer.from('<broken>'));
    const invalid = await get(invalidKey);
    assert.equal(invalid.status, 'TECHNICAL_FOLLOWUP');
    assert.equal(Object.hasOwn(invalid, 'items'), false);

    const failureKey = nextKey();
    const oldXml = itemXmlFor(failureKey, 'OLD');
    await capture(failureKey, false, oldXml, 'old');
    const old = await get(failureKey);
    const failedXml = Buffer.from(itemXmlFor(failureKey, 'NEW').toString().replace('</ICMS00>', '<vNovo>9.99</vNovo></ICMS00>'));
    await capture(failureKey, false, failedXml, 'new');
    const failed = await get(failureKey);
    assert.equal(failed.status, 'EXTRACTION_FAILED');
    assert.equal(failed.errorCode, 'TAX_MAPPING_UNSUPPORTED');
    assert.equal(Object.hasOwn(failed, 'items'), false);
    assert.notEqual(failed.xmlVersion.occurrenceId, old.xmlVersion.occurrenceId);
    const downloaded = await fetch(`http://127.0.0.1:${address.port}${failed.xmlVersion.downloadPath}`, { headers });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), failedXml);
    const again = await get(failureKey);
    assert.equal(again.status, 'EXTRACTION_FAILED');
    const failure = await pool.request().input('id', failed.xmlVersion.occurrenceId)
      .query("SELECT state,attempts,safeDetail FROM contei.FalhaIntegracao WHERE xmlOccurrenceId=@id AND kind='ITEM_EXTRACTION'");
    assert.deepEqual(failure.recordset.map((row) => [row.state, row.attempts, row.safeDetail]), [['OPEN', 2, 'TAX_MAPPING_UNSUPPORTED']]);
    const partial = await pool.request().input('id', failed.xmlVersion.occurrenceId).query('SELECT COUNT(*) AS count FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.equal(partial.recordset[0].count, 0);
    const earlier = await get(failureKey, `items?xmlOccurrenceId=${old.xmlVersion.occurrenceId}`);
    assert.equal(earlier.status, 'AVAILABLE');
    assert.equal(earlier.items[0].product.cProd, 'OLD');
    const detail = await get(failureKey, '');
    assert.equal(detail.technicalIssueActive, false);
    assert.equal(detail.currentDecision, null);

    const repeatedTaxKey = nextKey();
    await capture(repeatedTaxKey, false, Buffer.from(itemXmlFor(repeatedTaxKey).toString()
      .replace('</imposto>', '</imposto><imposto><IPI><cEnq>999</cEnq><IPINT><CST>53</CST></IPINT></IPI></imposto>')));
    const repeatedTax = await get(repeatedTaxKey);
    assert.deepEqual([repeatedTax.status, repeatedTax.errorCode, Object.hasOwn(repeatedTax, 'items')], ['EXTRACTION_FAILED', 'ITEM_STRUCTURE_INCOMPLETE', false]);
    const repeatedStored = await pool.request().input('id', repeatedTax.xmlVersion.occurrenceId).query('SELECT COUNT(*) AS count FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.equal(repeatedStored.recordset[0].count, 0);

    const recoveredKey = nextKey();
    await capture(recoveredKey, false, itemXmlFor(recoveredKey));
    const recoveredSource = await pool.request().input('key', recoveredKey)
      .query("SELECT d.id AS documentId,o.id AS occurrenceId FROM contei.DocumentoEntrada d JOIN contei.OcorrenciaDocumental o ON o.documentoId=d.id WHERE d.accessKey=@key AND o.kind='XML'");
    const source = recoveredSource.recordset[0];
    await pool.request().input('documentId', source.documentId).input('occurrenceId', source.occurrenceId)
      .query("INSERT INTO contei.FalhaIntegracao (documentoId,kind,xmlOccurrenceId,firstAt,lastAt,attempts,state,safeDetail) VALUES (@documentId,'ITEM_EXTRACTION',@occurrenceId,SYSDATETIMEOFFSET(),SYSDATETIMEOFFSET(),1,'OPEN','ITEM_STRUCTURE_INCOMPLETE')");
    assert.equal((await get(recoveredKey)).status, 'AVAILABLE');
    const resolved = await pool.request().input('id', source.occurrenceId)
      .query("SELECT state,resolvedAt FROM contei.FalhaIntegracao WHERE xmlOccurrenceId=@id AND kind='ITEM_EXTRACTION'");
    assert.equal(resolved.recordset[0].state, 'RESOLVED');
    assert.ok(resolved.recordset[0].resolvedAt);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.close();
  }
});

test('JWT aceita iat pouco adiantado ou fracionário dentro da tolerância e mantém exp estrito', async () => {
  const key = new TextEncoder().encode('segredo-sintetico-para-teste-de-relogio');
  const server = createApi({} as SqlPool, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // A autorização roda antes do roteamento e esta rota não toca o banco: 404 = credencial aceita, 401 = recusada.
  const status = async (iat: number, exp: number) => (await fetch(`http://127.0.0.1:${address.port}/api/v1/rota-inexistente`, { headers: {
    Authorization: `Bearer ${await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture')
      .setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt(iat).setExpirationTime(exp).sign(key)}`,
  } })).status;
  const now = Math.floor(Date.now() / 1000);
  try {
    assert.equal(await status(now, now + 120), 404);
    assert.equal(await status(now + 4, now + 120), 404, 'relógio do Halley 4 s adiantado');
    assert.equal(await status(Date.now() / 1000, now + 120), 404, 'iat fracionário emitido agora');
    assert.equal(await status(now + 65, now + 120), 401, 'iat além da tolerância');
    assert.equal(await status(now - 60, now), 401, 'exp continua sem tolerância');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('API exige JWT fiscal e entrega lista sem converter vNF em número', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const pool: SqlPool = await createPool('app');
  const key = new TextEncoder().encode('segredo-sintetico-para-teste-da-api');
  const server = createApi(pool, { issuer: 'halley-fixture', audience: 'contei-fixture', algorithm: 'HS256', key,
    permissionClaim: 'permission', fiscalPermission: 'fiscal', maxDecisionBytes: 4096, defaultPageLimit: 10, maxPageLimit: 20, iatToleranceSeconds: 5 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/triagem/nfe`;
  const sign = (permission: string, exp = '2m') => new SignJWT({ permission }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('fiscal-fixture').setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime(exp).sign(key);
  try {
    await pool.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id=1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    const matchingKey = keyFor(Math.floor(Math.random() * 1e8));
    const divergentKey = keyFor(Math.floor(Math.random() * 1e8));
    const canceledKey = keyFor(Math.floor(Math.random() * 1e8));
    for (const [accessKey, receiver, status] of [[matchingKey, '11222333000181', 'authorized'], [divergentKey, '11444777000161', 'authorized'], [canceledKey, '11222333000181', 'canceled']]) {
      await ingestSnapshot(pool, { accessKey, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status, canceled: status === 'canceled',
        rawPayload: Buffer.from(JSON.stringify({ AccessKey: accessKey, Status: status, Xml: 'synthetic' })), xmlBytes: xmlFor(accessKey, receiver),
        events: accessKey === matchingKey ? [{ section: 'EVENTS', rawPayload: Buffer.from('{"type":"CCe","extra":900719925474099312345}') }] : [] });
    }
    assert.equal((await fetch(url)).status, 401);
    const denied = { Authorization: `Bearer ${await sign('other')}` };
    assert.equal((await fetch(url, { headers: denied })).status, 403);
    assert.equal((await fetch(`${url}/${matchingKey}`, { headers: denied })).status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${await sign('fiscal', '-2m')}` } })).status, 401);
    const wrongSignature = await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture').setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(new TextEncoder().encode('outra-chave-sintetica-de-teste'));
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${wrongSignature}` } })).status, 401);
    const wrongIssuer = await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture').setIssuer('outro-emissor').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(key);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${wrongIssuer}` } })).status, 401);
    const wrongAudience = await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS256' }).setSubject('fiscal-fixture').setIssuer('halley-fixture').setAudience('outra-audiencia').setIssuedAt().setExpirationTime('2m').sign(key);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${wrongAudience}` } })).status, 401);
    const wrongAlgorithm = await new SignJWT({ permission: 'fiscal' }).setProtectedHeader({ alg: 'HS384' }).setSubject('fiscal-fixture').setIssuer('halley-fixture').setAudience('contei-fixture').setIssuedAt().setExpirationTime('2m').sign(key);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${wrongAlgorithm}` } })).status, 401);
    const allowed = { Authorization: `Bearer ${await sign('fiscal')}` };
    const response = await fetch(url, { headers: allowed });
    assert.equal(response.status, 200);
    const page = await response.json() as { items: Array<{ totalAmount: unknown }> };
    assert.ok(Array.isArray(page.items));
    for (const item of page.items) if (item.totalAmount !== null) assert.equal(typeof item.totalAmount, 'string');
    const matching = await (await fetch(`${url}/${matchingKey}`, { headers: allowed })).json() as any;
    assert.equal(matching.totalAmount, '9007199254740.99');
    assert.equal(matching.recommendation.outcome, 'NO_ACTION');
    assert.equal(matching.evidence.recipientCnpjMismatch, false);
    const xmlVersion = matching.xmlVersions[0];
    const downloaded = await fetch(`http://127.0.0.1:${address.port}${xmlVersion.downloadPath}`, { headers: allowed });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), xmlFor(matchingKey, '11222333000181'));
    assert.equal(downloaded.headers.get('etag'), `"${createHash('sha256').update(xmlFor(matchingKey, '11222333000181')).digest('hex')}"`);
    const eventOccurrence = matching.occurrences.find((occurrence: { kind: string }) => occurrence.kind === 'EVENT');
    const eventContent = await fetch(`http://127.0.0.1:${address.port}${eventOccurrence.contentPath}`, { headers: allowed });
    assert.equal(eventContent.status, 200);
    assert.equal(await eventContent.text(), '{"type":"CCe","extra":900719925474099312345}');
    assert.equal(eventContent.headers.get('etag'), `"${eventOccurrence.sha256}"`);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${eventOccurrence.contentPath}`, { headers: denied })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${eventOccurrence.contentPath}`, { headers: { Authorization: `Bearer ${await sign('fiscal', '-2m')}` } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${xmlVersion.downloadPath}`, { headers: denied })).status, 403);
    const divergent = await (await fetch(`${url}/${divergentKey}`, { headers: allowed })).json() as any;
    assert.equal(divergent.recommendation.outcome, 'TREATMENT_PENDING');
    assert.equal(divergent.evidence.recipientCnpjMismatch, true);
    const canceled = await (await fetch(`${url}/${canceledKey}`, { headers: allowed })).json() as any;
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.recommendation, null);
    const decisionUrl = `${url}/${divergentKey}/decisions`;
    const idem = '7f782488-0b93-4c40-9686-120dd22b1111';
    const decisionBody = { expectedReviewVersion: divergent.reviewVersion, outcome: 'NO_ACTION', reasonCode: 'ACCEPTED_DIVERGENCE_OR_SITUATION', observation: 'Conferido pelo fiscal' };
    const decide = (body: unknown, headers = allowed) => fetch(decisionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': idem }, body: JSON.stringify(body) });
    assert.equal((await decide({ ...decisionBody, reasonCode: 'OTHER' })).status, 422);
    assert.equal((await decide(decisionBody, denied)).status, 403);
    const first = await decide(decisionBody);
    assert.equal(first.status, 201);
    const receipt = await first.json() as any;
    assert.equal(receipt.decision.actorId, 'fiscal-fixture');
    assert.equal(receipt.decision.evidenceSnapshot.recipientCnpjMismatch, true);
    const replay = await decide(decisionBody);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as any).decision.id, receipt.decision.id);
    assert.equal((await decide({ ...decisionBody, observation: 'outro conteúdo' })).status, 409);
    const decidedPage = await (await fetch(`${url}?decision=NO_ACTION&query=${divergentKey}`, { headers: allowed })).json() as any;
    assert.equal(decidedPage.items[0].currentDecision.id, receipt.decision.id);
    const matchingDecisionUrl = `${url}/${matchingKey}/decisions`;
    const matchingBody = { expectedReviewVersion: matching.reviewVersion, outcome: 'NO_ACTION', reasonCode: 'NO_RELEVANT_DIVERGENCE' };
    const sameHeaders = { ...allowed, 'Content-Type': 'application/json', 'Idempotency-Key': '9e9ac449-dacb-4f44-965c-33bd3484bf7f' };
    const [concurrentA, concurrentB] = await Promise.all([
      fetch(matchingDecisionUrl, { method: 'POST', headers: sameHeaders, body: JSON.stringify(matchingBody) }),
      fetch(matchingDecisionUrl, { method: 'POST', headers: sameHeaders, body: JSON.stringify(matchingBody) }),
    ]);
    assert.deepEqual([concurrentA.status, concurrentB.status], [201, 201]);
    assert.equal((await concurrentA.json() as any).decision.id, (await concurrentB.json() as any).decision.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.close();
  }
});
