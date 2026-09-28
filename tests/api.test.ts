import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApi } from '../src/api.ts';
import { createPool, ingestSnapshot, type SqlPool } from '../src/db.ts';
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
