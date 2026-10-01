import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import sql from 'mssql';
import { createPool, getDocumentDetail, ingestSnapshot, migrate, recordDecision, runMigration, type SqlPool } from '../src/db.ts';
import { inspectXml, isValidAccessKey, isValidCnpj, recommend, validateDecision } from '../src/triagem.ts';
import { activateCompany, deactivateCompany } from '../src/provision.ts';

const databaseReady = Boolean(process.env.MSSQL_DATABASE && process.env.MSSQL_DEPLOY_USER && process.env.MSSQL_APP_USER);

test('migrations são atômicas, reaplicáveis e protegem o histórico com o login de execução', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const deploy = await createPool('deploy');
  const app = await createPool('app');
  try {
    await migrate(deploy);
    await migrate(deploy);
    const versions = await deploy.request().query('SELECT version FROM contei.Migration ORDER BY version');
    assert.deepEqual(versions.recordset.map((r) => r.version), ['000', '001', '002']);
    await assert.rejects(
      runMigration(deploy, 'rollback_probe', "CREATE TABLE contei.RollbackProbe (id int NOT NULL); THROW 51000, 'probe', 1;"),
    );
    const table = await deploy.request().query("SELECT OBJECT_ID('contei.RollbackProbe') AS id");
    assert.equal(table.recordset[0].id, null);
    for (const tableName of ['OcorrenciaDocumental', 'DecisaoTriagem', 'ItensNfeExtraidos']) {
      await assert.rejects(app.request().query(`UPDATE contei.${tableName} SET id = id WHERE 1 = 0`));
      await assert.rejects(app.request().query(`DELETE FROM contei.${tableName} WHERE 1 = 0`));
    }
    const owner = await app.request().query("SELECT IS_ROLEMEMBER('db_owner') AS isOwner");
    assert.equal(owner.recordset[0].isOwner, 0);
    const schemaOwner = await app.request().query("SELECT USER_NAME(principal_id) AS ownerName FROM sys.schemas WHERE name='contei'");
    assert.notEqual(schemaOwner.recordset[0].ownerName, process.env.MSSQL_APP_USER);
    await app.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id = 1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
    const duplicateKey = '1'.repeat(44);
    await app.request().input('key', duplicateKey).query("IF NOT EXISTS (SELECT 1 FROM contei.DocumentoEntrada WHERE accessKey=@key) INSERT INTO contei.DocumentoEntrada (empresaId,accessKey) VALUES (1,@key)");
    await assert.rejects(app.request().input('key', duplicateKey).query('INSERT INTO contei.DocumentoEntrada (empresaId,accessKey) VALUES (1,@key)'));
    const emptyHash = createHash('sha256').update('x').digest();
    await assert.rejects(app.request().input('hash', emptyHash).query("INSERT INTO contei.OcorrenciaDocumental (documentoId,kind,sourceSection,rawPayload,contentType,sha256) VALUES (-1,'XML','NFE',0x78,'application/xml',@hash)"));
    const amountType = await deploy.request().query("SELECT TYPE_NAME(c.user_type_id) AS typeName,c.precision,c.scale FROM sys.columns c WHERE c.object_id=OBJECT_ID('contei.DocumentoEntrada') AND c.name='totalAmount'");
    assert.deepEqual(amountType.recordset[0], { typeName: 'decimal', precision: 15, scale: 2 });
  } finally {
    await app.close();
    await deploy.close();
  }
});

test('migração 002 grava um conjunto por XML e uma falha aberta por versão', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const deploy = await createPool('deploy');
  const app = await createPool('app');
  const key = String(Date.now()).padStart(44, '0');
  let documentId: number | undefined;
  let occurrenceId: number | undefined;
  try {
    await migrate(deploy);
    const document = await app.request().input('key', key).query("INSERT INTO contei.DocumentoEntrada (empresaId,accessKey,scope) OUTPUT INSERTED.id VALUES (1,@key,'IN')");
    documentId = Number(document.recordset[0].id);
    const payload = Buffer.from('<synthetic/>');
    const occurrence = await app.request().input('id', documentId).input('payload', payload).input('hash', createHash('sha256').update(payload).digest())
      .query("INSERT INTO contei.OcorrenciaDocumental (documentoId,kind,sourceSection,rawPayload,contentType,sha256,isValidXml) OUTPUT INSERTED.id VALUES (@id,'XML','NFE',@payload,'application/xml',@hash,1)");
    occurrenceId = Number(occurrence.recordset[0].id);
    await assert.rejects(app.request().input('id', occurrenceId).query("INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (@id,'invalid',SYSDATETIMEOFFSET())"));
    await assert.rejects(app.request().input('id', occurrenceId).query("INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (@id,'{}',SYSDATETIMEOFFSET())"));
    const items = JSON.stringify([{ nItem: 1, product: { cProd: 'fixture' } }]);
    await app.request().input('id', occurrenceId).input('items', items)
      .query('INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (@id,@items,SYSDATETIMEOFFSET())');
    await assert.rejects(app.request().input('id', occurrenceId).input('items', items)
      .query('INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (@id,@items,SYSDATETIMEOFFSET())'));
    await assert.rejects(app.request().input('items', items)
      .query('INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (-1,@items,SYSDATETIMEOFFSET())'));
    await assert.rejects(app.request().input('id', documentId).query("INSERT INTO contei.FalhaIntegracao (documentoId,kind,firstAt,lastAt,state,safeDetail) VALUES (@id,'ITEM_EXTRACTION',SYSDATETIMEOFFSET(),SYSDATETIMEOFFSET(),'OPEN','ITEM_STRUCTURE_INCOMPLETE')"));
    const failureSql = "INSERT INTO contei.FalhaIntegracao (documentoId,kind,xmlOccurrenceId,firstAt,lastAt,state,safeDetail) VALUES (@documentId,'ITEM_EXTRACTION',@occurrenceId,SYSDATETIMEOFFSET(),SYSDATETIMEOFFSET(),'OPEN','ITEM_STRUCTURE_INCOMPLETE')";
    await app.request().input('documentId', documentId).input('occurrenceId', occurrenceId).query(failureSql);
    await assert.rejects(app.request().input('documentId', documentId).input('occurrenceId', occurrenceId).query(failureSql));
    const rows = await app.request().input('id', occurrenceId).query('SELECT itemsJson FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
    assert.deepEqual(JSON.parse(rows.recordset[0].itemsJson), [{ nItem: 1, product: { cProd: 'fixture' } }]);
  } finally {
    if (documentId !== undefined) {
      await deploy.request().input('id', documentId).query('DELETE FROM contei.FalhaIntegracao WHERE documentoId=@id');
      if (occurrenceId !== undefined) await deploy.request().input('id', occurrenceId).query('DELETE FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
      await deploy.request().input('id', documentId).query('DELETE FROM contei.OcorrenciaDocumental WHERE documentoId=@id');
      await deploy.request().input('id', documentId).query('DELETE FROM contei.DocumentoEntrada WHERE id=@id');
    }
    await app.close();
    await deploy.close();
  }
});

// Duas versões válidas da mesma chave: mudam destinatário e vNF, que não compõem a chave de acesso.
async function ingestTwoVersions(app: SqlPool) {
  const base = accessKey.slice(0, 34) + Math.floor(Math.random() * 1e8).toString().padStart(8, '0') + '3';
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
  const digit = 11 - sum % 11;
  const key = base + String(digit >= 10 ? 0 : digit);
  await app.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
  const oldEntry = { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
    rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Version: 'old' })), xmlBytes: Buffer.from(xml('11222333000181').toString().replaceAll(accessKey, key)) };
  await ingestSnapshot(app, oldEntry);
  await ingestSnapshot(app, { ...oldEntry, rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, Version: 'new' })),
    xmlBytes: Buffer.from(xml('11444777000161', '234.56').toString().replaceAll(accessKey, key)) });
  const [oldVersion, newVersion] = (await getDocumentDetail(app, key)).xmlVersions;
  return { key, oldEntry, oldVersion, newVersion };
}

const pointToVersion = (app: SqlPool, key: string, occurrenceId: string) => app.request().input('key', key).input('id', occurrenceId)
  .query('UPDATE contei.DocumentoEntrada SET latestValidXmlOccurrenceId=@id WHERE accessKey=@key');

test('replay de XML antigo não regride ponteiro nem cabeçalho da versão mais recente', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  try {
    const { key, oldEntry, oldVersion, newVersion } = await ingestTwoVersions(app);
    const before = await getDocumentDetail(app, key);
    assert.equal(before.evidence.xmlOccurrenceId, newVersion.occurrenceId);
    assert.deepEqual([before.receiverCnpj, before.totalAmount], ['11444777000161', '234.56']);
    await ingestSnapshot(app, oldEntry);
    const pointer = await app.request().input('key', key).query('SELECT latestValidXmlOccurrenceId FROM contei.DocumentoEntrada WHERE accessKey=@key');
    assert.equal(String(pointer.recordset[0].latestValidXmlOccurrenceId), newVersion.occurrenceId);
    const after = await getDocumentDetail(app, key);
    assert.equal(after.evidence.xmlOccurrenceId, newVersion.occurrenceId);
    assert.deepEqual([after.receiverCnpj, after.totalAmount, after.evidence.recipientCnpjMismatch, after.recommendation?.reasonCode],
      ['11444777000161', '234.56', true, 'RECIPIENT_CNPJ_MISMATCH']);
    assert.deepEqual(after.xmlVersions.map((version) => version.occurrenceId), [oldVersion.occurrenceId, newVersion.occurrenceId]);
    await pointToVersion(app, key, oldVersion.occurrenceId);
    const withHistoricalStalePointer = await getDocumentDetail(app, key);
    assert.equal(withHistoricalStalePointer.evidence.xmlOccurrenceId, newVersion.occurrenceId);
  } finally { await app.close(); }
});

test('nova decisão registra XML e SHA-256 da versão mais recente mesmo com ponteiro desatualizado', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  try {
    const { key, oldVersion, newVersion } = await ingestTwoVersions(app);
    await pointToVersion(app, key, oldVersion.occurrenceId);
    const { reviewVersion } = await getDocumentDetail(app, key);
    const decision = await recordDecision(app, key, { id: 'fiscal-fixture', role: 'fiscal' }, '23692598-b1c8-4516-9325-6e63c4eb7129',
      { expectedReviewVersion: reviewVersion, outcome: 'TREATMENT_PENDING', reasonCode: 'RECIPIENT_CNPJ_MISMATCH' });
    const evidence = decision.decision.evidenceSnapshot;
    assert.deepEqual([evidence.xmlOccurrenceId, evidence.xmlSha256], [newVersion.occurrenceId, newVersion.sha256]);
  } finally { await app.close(); }
});

test('conexão reutilizada volta a READ COMMITTED após transação SERIALIZABLE confirmada, desfeita ou abortada', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const session = async () => (await app.request()
    .query('SELECT @@SPID AS spid, transaction_isolation_level AS isolation FROM sys.dm_exec_sessions WHERE session_id=@@SPID')).recordset[0];
  const serializable = async (end: (transaction: sql.Transaction) => Promise<unknown>) => {
    const transaction = new sql.Transaction(app);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    await end(transaction);
    // O abort por XACT_ABORT devolve a conexão ao pool no ciclo seguinte.
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const initial = await session();
    assert.equal(initial.isolation, 2);
    await serializable((transaction) => transaction.commit());
    assert.deepEqual(await session(), initial, 'após commit');
    await serializable((transaction) => transaction.rollback());
    assert.deepEqual(await session(), initial, 'após rollback');
    await serializable(async (transaction) => {
      await assert.rejects(new sql.Request(transaction).query('SET XACT_ABORT ON; SELECT 1/0'));
      await assert.rejects(transaction.rollback());
    });
    assert.deepEqual(await session(), initial, 'após abort do servidor');
    assert.equal(app.size, 1, 'todas as etapas usaram a mesma conexão do pool');
  } finally { await app.close(); }
});

const accessKey = '3526091122233300018155001000000123100000123' + '0';
const xml = (receiverCnpj: string, amount = '123.45') => Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${accessKey}"><ide><nNF>123</nNF><dhEmi>2026-09-24T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Emitente</xNome></emit><dest><CNPJ>${receiverCnpj}</CNPJ><xNome>Destinatário</xNome></dest><total><ICMSTot><vNF>${amount}</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>${accessKey}</chNFe><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`,
  'utf8',
);

test('XML estrutural preserva valor exato e recomenda conforme CNPJ e cancelamento', () => {
  assert.equal(isValidAccessKey(accessKey), true);
  for (const invalid of [accessKey.slice(0, -1), accessKey + '0', accessKey.slice(0, -1) + '1', 'x' + accessKey.slice(1)]) assert.equal(isValidAccessKey(invalid), false);
  for (const valid of ['11222333000181', '11444777000161']) assert.equal(isValidCnpj(valid), true);
  for (const invalid of ['00000000000000', '11111111111111', '11222333000191', '11222333000182', '1122233300018', '112223330001810', 'x1222333000181']) assert.equal(isValidCnpj(invalid), false);
  const data = inspectXml(xml('11222333000181'), accessKey);
  assert.equal(data.totalAmount, '123.45');
  assert.equal(data.receiverCnpj, '11222333000181');
  assert.deepEqual(recommend(data.receiverCnpj, '11222333000181', false), { outcome: 'NO_ACTION', reasonCode: 'NO_RELEVANT_DIVERGENCE' });
  assert.equal(recommend(data.receiverCnpj, '11222333000181', true), null);
  assert.deepEqual(recommend(data.receiverCnpj, '11444777000161', true), { outcome: 'TREATMENT_PENDING', reasonCode: 'RECIPIENT_CNPJ_MISMATCH' });
  assert.throws(() => inspectXml(xml('11222333000181').subarray(0, -10), accessKey));
  assert.throws(() => inspectXml(xml('00000000000000'), accessKey));
  assert.throws(() => inspectXml(xml('11222333000181', '123.456'), accessKey));
  assert.throws(() => inspectXml(Buffer.from(xml('11222333000181').toString().replace('<nfeProc', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><nfeProc')), accessKey));
  assert.throws(() => inspectXml(Buffer.from(xml('11222333000181').toString().replace(`<chNFe>${accessKey}</chNFe>`, '<chNFe>wrong</chNFe>')), accessKey));
  assert.equal(inspectXml(xml('11444777000161'), accessKey).receiverCnpj, '11444777000161');
  const signed = Buffer.from(xml('11222333000181').toString().replace('</NFe>', '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature></NFe>'));
  assert.equal(inspectXml(signed, accessKey).receiverCnpj, '11222333000181');
});

test('decisão exige motivo compatível e observação para OTHER', () => {
  assert.equal(validateDecision({ expectedReviewVersion: 1, outcome: 'NO_ACTION', reasonCode: 'ACCEPTED_DIVERGENCE_OR_SITUATION' }).outcome, 'NO_ACTION');
  assert.throws(() => validateDecision({ expectedReviewVersion: 1, outcome: 'TREATMENT_PENDING', reasonCode: 'OTHER' }));
  assert.throws(() => validateDecision({ expectedReviewVersion: 1, outcome: 'NO_ACTION', reasonCode: 'RECIPIENT_CNPJ_MISMATCH' }));
});

test('ativação nega ausência de prova e acesso Qive não comprovado', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const proof = { cnpj: '11222333000181', knownReceivedAccessKey: accessKey, validatedAt: '2026-09-24T10:00:00Z', qiveValidationEvidenceRef: 'fixture-access', certificateEvidenceRef: 'fixture-certificate', completeCaptureEvidenceRef: 'fixture-capture' };
  try {
    await deactivateCompany(app);
    await assert.rejects(activateCompany(app, { ...proof, certificateEvidenceRef: '' }, async () => true));
    await assert.rejects(activateCompany(app, { ...proof, completeCaptureEvidenceRef: '' }, async () => true));
    await assert.rejects(activateCompany(app, proof, async () => false));
    const state = await app.request().query('SELECT status FROM contei.EmpresaFiscal WHERE id=1');
    assert.equal(state.recordset[0].status, 'INACTIVE');
  } finally {
    await app.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    await app.close();
  }
});

test('duas capturas e duas decisões simultâneas convergem sem duplicar histórico', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  try {
    await app.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id = 1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
    const base = accessKey.slice(0, 34) + Math.floor(Math.random() * 1e8).toString().padStart(8, '0') + accessKey.slice(42, 43);
    let sum = 0;
    for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
    const digit = 11 - sum % 11;
    const key = base + String(digit >= 10 ? 0 : digit);
    const rawPayload = Buffer.from(JSON.stringify({ AccessKey: key, Xml: 'synthetic', Unknown: 9007199254740993n.toString() }));
    const entry = { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'qive', status: 'authorized', canceled: false, rawPayload, xmlBytes: Buffer.from(xml('11222333000181').toString('utf8').replaceAll(accessKey, key)) };
    await Promise.all([ingestSnapshot(app, entry), ingestSnapshot(app, entry)]);
    const document = await app.request().input('key', key).query('SELECT id, reviewVersion, triageEnteredAt, CONVERT(varchar(16), totalAmount) AS amount FROM contei.DocumentoEntrada WHERE accessKey = @key');
    assert.equal(document.recordset.length, 1);
    assert.equal(document.recordset[0].reviewVersion, 1);
    assert.equal(document.recordset[0].amount, '123.45');
    assert.ok(document.recordset[0].triageEnteredAt);
    const occurrences = await app.request().input('id', document.recordset[0].id).query('SELECT id, kind, rawPayload, sha256 FROM contei.OcorrenciaDocumental WHERE documentoId = @id');
    assert.deepEqual(occurrences.recordset.map((r) => r.kind).sort(), ['SNAPSHOT', 'XML']);
    const storedXml = occurrences.recordset.find((r) => r.kind === 'XML');
    assert.deepEqual(storedXml.rawPayload, entry.xmlBytes);
    assert.equal(storedXml.sha256.toString('hex'), createHash('sha256').update(entry.xmlBytes).digest('hex'));
    const keyIdempotent = '1e46b931-67df-42af-b0a1-10e49e4a572e';
    const request = { expectedReviewVersion: 1, outcome: 'NO_ACTION' as const, reasonCode: 'NO_RELEVANT_DIVERGENCE' };
    const [first, replay] = await Promise.all([
      recordDecision(app, key, { id: 'fiscal-1', role: 'fiscal' }, keyIdempotent, request),
      recordDecision(app, key, { id: 'fiscal-1', role: 'fiscal' }, keyIdempotent, request),
    ]);
    assert.equal(first.decision.id, replay.decision.id);
    assert.equal(first.decision.evidenceSnapshot.xmlOccurrenceId, String(storedXml.id));
    assert.equal(first.decision.evidenceSnapshot.xmlSha256, storedXml.sha256.toString('hex'));
    assert.deepEqual(first, replay);
    const decisions = await app.request().input('id', document.recordset[0].id).query('SELECT id FROM contei.DecisaoTriagem WHERE documentoId = @id');
    assert.equal(decisions.recordset.length, 1);
    const withEvents = { ...entry, events: [
      { section: 'EVENTS' as const, eventType: 'CCe', rawPayload: Buffer.from('{"type":"CCe","protocol":"1","seq":"1","extra":900719925474099312345}') },
      { section: 'EVENTS' as const, eventType: 'CCe', rawPayload: Buffer.from('{"type":"CCe","protocol":"1","seq":"1","extra":900719925474099312346}') },
    ] };
    await ingestSnapshot(app, withEvents);
    await ingestSnapshot(app, withEvents);
    const preservedEvents = await app.request().input('id', document.recordset[0].id).query("SELECT rawPayload FROM contei.OcorrenciaDocumental WHERE documentoId=@id AND kind='EVENT' ORDER BY id");
    assert.equal(preservedEvents.recordset.length, 2);
    assert.notDeepEqual(preservedEvents.recordset[0].rawPayload, preservedEvents.recordset[1].rawPayload);
  } finally { await app.close(); }
});

test('colisão de digest simulada preserva ambos os payloads com ordinais distintos', { skip: !databaseReady && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const deploy = await createPool('deploy');
  let documentId: number | undefined;
  try {
    const base = accessKey.slice(0, 34) + Math.floor(Math.random() * 1e8).toString().padStart(8, '0') + accessKey.slice(42, 43);
    let sum = 0;
    for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
    const digit = 11 - sum % 11;
    const key = base + String(digit >= 10 ? 0 : digit);
    const entry = { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false, rawPayload: Buffer.from(JSON.stringify({ AccessKey: key })) };
    documentId = await ingestSnapshot(app, entry);
    const existingBytes = Buffer.from('{"Type":"CCe","extra":"A"}');
    const newBytes = Buffer.from('{"Type":"CCe","extra":"B"}');
    const sameHash = createHash('sha256').update(newBytes).digest();
    await app.request().input('id', documentId).input('payload', existingBytes).input('hash', sameHash)
      .query("INSERT INTO contei.OcorrenciaDocumental (documentoId,kind,sourceSection,rawPayload,contentType,sha256,collisionOrdinal) VALUES (@id,'EVENT','MANIFESTATIONS',@payload,'application/json',@hash,0)");
    await ingestSnapshot(app, { ...entry, events: [{ section: 'MANIFESTATIONS', rawPayload: newBytes }] });
    const rows = await app.request().input('id', documentId).query("SELECT collisionOrdinal,rawPayload FROM contei.OcorrenciaDocumental WHERE documentoId=@id AND kind='EVENT' ORDER BY collisionOrdinal");
    assert.deepEqual(rows.recordset.map((row) => row.collisionOrdinal), [0, 1]);
    assert.deepEqual(rows.recordset.map((row) => row.rawPayload), [existingBytes, newBytes]);
  } finally {
    if (documentId !== undefined) {
      await deploy.request().input('id', documentId).query('DELETE FROM contei.OcorrenciaDocumental WHERE documentoId=@id');
      await deploy.request().input('id', documentId).query('DELETE FROM contei.DocumentoEntrada WHERE id=@id');
    }
    await deploy.close();
    await app.close();
  }
});
