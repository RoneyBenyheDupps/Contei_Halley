import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import sql from 'mssql';
import { SaxesParser } from 'saxes';
import { createPool, ingestSnapshot, migrate } from '../src/db.ts';
import { readQiveConfig } from '../src/config.ts';
import { createQiveClient, QiveError } from '../src/qive.ts';
import { runDiscovery } from '../src/sync.ts';
import { isValidCnpj } from '../src/triagem.ts';

const marker = parseEnv(await readFile(new URL('../.env.qive-discovery', import.meta.url), 'utf8'));
const outputDir = new URL('../dist/qive-discovery/', import.meta.url);
await mkdir(outputDir, { recursive: true });
assert.match(marker.MSSQL_DATABASE || '', /^ConteiQiveDiscovery_[a-f0-9]{12}$/);
assert.equal(process.env.MSSQL_HOST, 'localhost');
assert.equal(process.env.MSSQL_PORT, '1433');
process.env.MSSQL_DATABASE = marker.MSSQL_DATABASE;
process.env.CONTEI_SYNC_ENABLED = 'false';
assert.ok(isValidCnpj(process.env.CONTEI_CNPJ || ''));

const mode = process.argv[2];
const cnpj = process.env.CONTEI_CNPJ;
let qive;
if (mode === 'search' || mode === 'discover' || mode === 'cycle') {
  // Valores temporários para limitar esta prova local; não configuram limites de produção.
  const testValues = {
    QIVE_FIELDS_KEY: 'Fields', QIVE_PAGINATOR_KEY: 'Paginator', QIVE_XML_ENCODING: 'base64', QIVE_EVENT_XML_ENCODING: 'base64',
    QIVE_TIMEOUT_MS: '30000', QIVE_MAX_RESPONSE_BYTES: '16777216', QIVE_MAX_XML_BYTES: '8388608',
  };
  for (const [name, value] of Object.entries(testValues)) if (!process.env[name]) process.env[name] = value;
  assert.equal(process.env.QIVE_RECEIVED_ROLE, 'received');
  assert.ok(['api.arquivei.com.br', 'sandbox-api.arquivei.com.br'].includes(new URL(process.env.QIVE_BASE_URL).hostname));
  const config = readQiveConfig(cnpj);
  let lastStatus = null;
  let lastFilters = null;
  qive = createQiveClient({ ...config, fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init.body));
    lastFilters = {
      Owners: '[CNPJ configurado]', OwnerRoles: body.Filters.OwnerRoles,
      CreatedAt: body.Filters.CreatedAt, EmissionDate: body.Filters.EmissionDate,
      Limit: body.Limit, fieldsKey: config.fieldsKey, paginatorKey: config.paginatorKey,
    };
    const response = await fetch(url, init);
    lastStatus = response.status;
    return response;
  } });
  qive.status = () => ({ httpStatus: lastStatus, filters: lastFilters });
}
if (mode === 'setup') {
  const deploy = await createPool('deploy');
  try { await migrate(deploy); } finally { await deploy.close(); }
  const app = await createPool('app');
  try {
    const before = (await app.request().query('SELECT cnpj,status,halleyCompanyId FROM contei.EmpresaFiscal WHERE id=1')).recordset[0];
    if (!before) {
      await app.request().input('cnpj', sql.Char(14), cnpj).query(`INSERT INTO contei.EmpresaFiscal
        (id,halleyCompanyId,cnpj,status,activatedAt,qiveConnectionRef,qiveValidatedAt,qiveValidationEvidenceRef,certificateEvidenceRef,completeCaptureEvidenceRef)
        VALUES (1,'manual-qive-local',@cnpj,'ACTIVE','2026-01-01T00:00:00+00:00','local-read-test','2026-01-01T00:00:00+00:00',
        'TEST_ONLY_NOT_PILOT','TEST_ONLY_NOT_PILOT','TEST_ONLY_NOT_PILOT')`);
    } else {
      assert.equal(before.cnpj, cnpj, 'Empresa da base isolada diverge da conta configurada');
      assert.equal(before.halleyCompanyId, 'manual-qive-local', 'Base nao pertence ao teste manual Qive');
      assert.equal(before.status, 'ACTIVE');
    }
    const verified = (await app.request().query("SELECT DB_NAME() AS databaseName, IS_ROLEMEMBER('db_owner') AS appIsOwner, status, qiveValidationEvidenceRef FROM contei.EmpresaFiscal WHERE id=1")).recordset[0];
    assert.equal(verified.databaseName, marker.MSSQL_DATABASE);
    assert.equal(verified.appIsOwner, 0);
    assert.equal(verified.qiveValidationEvidenceRef, 'TEST_ONLY_NOT_PILOT');
    console.log(JSON.stringify({ database: verified.databaseName, companyConfigured: true, status: verified.status, fixtureOnly: true, appIsOwner: false }));
  } finally { await app.close(); }
} else if (mode === 'search') {
  assert.equal(process.argv.length, 3, 'Use search sem argumentos');
  const end = new Date();
  let to = end;
  let foundAt = null;
  let searches = 0;
  const windowDays = [1, ...Array(7).fill(1), ...Array(4).fill(7), ...Array(3).fill(30)];
  for (const days of windowDays) {
    const from = new Date(to.getTime() - days * 86_400_000);
    const seen = new Set();
    let paginator;
    let pages = 0;
    let found = 0;
    let failedItems = 0;
    let outsideWindow = 0;
    do {
      let page;
      try { page = await qive.listPage(from.toISOString(), to.toISOString(), paginator); }
      catch (error) {
        console.log(JSON.stringify({ searchFailure: { from: from.toISOString(), to: to.toISOString(),
          httpStatus: error instanceof QiveError ? error.status ?? qive.status().httpStatus : qive.status().httpStatus,
          filters: qive.status().filters, kind: error instanceof QiveError ? 'qive' : 'unexpected' } }));
        process.exitCode = 1;
        break;
      }
      pages++;
      found += page.items.length;
      failedItems += page.failedItems ?? 0;
      for (const item of page.items) {
        const instant = Date.parse(item.createdAt);
        if (!Number.isFinite(instant) || instant < from.getTime() || instant > to.getTime()) outsideWindow++;
        else if (foundAt === null) foundAt = instant;
      }
      paginator = page.nextPaginator || undefined;
      if (paginator) {
        if (seen.has(paginator)) { process.exitCode = 1; break; }
        seen.add(paginator);
      }
    } while (paginator);
    searches++;
    console.log(JSON.stringify({ searchWindow: { from: from.toISOString(), to: to.toISOString(), pages, found,
      failedItems, outsideWindow, httpStatus: qive.status().httpStatus, repeatedPaginator: Boolean(process.exitCode) && Boolean(paginator) } }));
    if (process.exitCode || failedItems || outsideWindow) { process.exitCode = 1; break; }
    if (foundAt !== null) break;
    to = from;
  }
  const hourStart = foundAt === null ? null : new Date(Math.floor(foundAt / 3_600_000) * 3_600_000).toISOString();
  const hourEnd = foundAt === null ? null : new Date(Math.floor(foundAt / 3_600_000) * 3_600_000 + 3_600_000).toISOString();
  const result = { searches, found: foundAt !== null, hourStart, hourEnd, lastHttpStatus: qive.status().httpStatus,
    lastFilters: qive.status().filters, noDatabaseWrites: true, checkpointTouched: false };
  await writeFile(new URL('search-result.json', outputDir), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ searchResult: result }));
} else if (mode === 'discover') {
  assert.equal(Boolean(process.argv[3]), Boolean(process.argv[4]), 'Informe fromISO e toISO juntos');
  const toDate = process.argv[4] ? new Date(process.argv[4]) : new Date();
  const fromDate = process.argv[3] ? new Date(process.argv[3]) : new Date(toDate.getTime() - 3_600_000);
  assert.ok(Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime()));
  assert.ok(fromDate < toDate && toDate.getTime() - fromDate.getTime() <= 3_600_000, 'CreatedAt deve ter ate uma hora');
  assert.ok(process.argv.length <= 5, 'Use discover [fromISO toISO]');
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const app = await createPool('app');
  const counters = async () => (await app.request().query(`SELECT
    (SELECT COUNT(*) FROM contei.DocumentoEntrada WHERE empresaId=1) AS documents,
    (SELECT COUNT(*) FROM contei.OcorrenciaDocumental) AS occurrences,
    (SELECT COUNT(*) FROM contei.OcorrenciaDocumental WHERE kind='XML') AS xmlVersions,
    (SELECT COUNT(*) FROM contei.OcorrenciaDocumental WHERE kind='EVENT') AS events,
    (SELECT COUNT(*) FROM contei.DocumentoEntrada WHERE captureState='XML_VERIFIED') AS xmlVerifiedDocuments`)).recordset[0];
  try {
    const company = (await app.request().query('SELECT cnpj,status,activatedAt,halleyCompanyId,qiveValidationEvidenceRef FROM contei.EmpresaFiscal WHERE id=1')).recordset[0];
    assert.ok(company && company.cnpj === cnpj && company.status === 'ACTIVE');
    assert.equal(company.halleyCompanyId, 'manual-qive-local');
    assert.equal(company.qiveValidationEvidenceRef, 'TEST_ONLY_NOT_PILOT');
    assert.ok(fromDate >= new Date(company.activatedAt));
    const firstPayloads = new Map();
    const cycles = [];
    for (const cycle of [1, 2]) {
      const before = await counters();
      const unique = new Set();
      const withXml = new Set();
      const withEvents = new Set();
      const seenPaginator = new Set();
      const failures = { qiveItems: 0, persistence: 0, outsideWindow: 0, request: 0, pagination: 0 };
      let paginator;
      let pages = 0;
      let found = 0;
      let eventsFound = 0;
      let changedPayloads = 0;
      let httpStatus = null;
      do {
        let page;
        try { page = await qive.listPage(from, to, paginator); }
        catch (error) {
          failures.request++;
          httpStatus = error instanceof QiveError ? error.status ?? null : null;
          break;
        }
        pages++;
        failures.qiveItems += page.failedItems ?? 0;
        found += page.items.length;
        console.log(JSON.stringify({ cycle, page: pages, receivedItems: page.items.length, invalidItems: page.failedItems ?? 0 }));
        for (const item of page.items) {
          unique.add(item.accessKey);
          if (item.xmlBytes) withXml.add(item.accessKey);
          if (item.events?.length) withEvents.add(item.accessKey);
          eventsFound += item.events?.length ?? 0;
          const itemTime = Date.parse(item.createdAt);
          if (!Number.isFinite(itemTime) || itemTime < fromDate.getTime() || itemTime > toDate.getTime()) { failures.outsideWindow++; continue; }
          const hash = createHash('sha256').update(item.rawPayload).digest('hex');
          if (cycle === 1) firstPayloads.set(item.accessKey, hash);
          else if (firstPayloads.has(item.accessKey) && firstPayloads.get(item.accessKey) !== hash) changedPayloads++;
          try { await ingestSnapshot(app, item); }
          catch { failures.persistence++; }
        }
        paginator = page.nextPaginator || undefined;
        if (paginator) {
          if (seenPaginator.has(paginator)) { failures.pagination++; break; }
          seenPaginator.add(paginator);
        }
      } while (paginator);
      const after = await counters();
      const result = {
        cycle, from, to, pages, found, uniqueReceivedNotes: unique.size, notesWithXml: withXml.size,
        notesWithEvents: withEvents.size, eventsFound,
        documentsWritten: after.documents - before.documents,
        occurrencesWritten: after.occurrences - before.occurrences,
        xmlVersionsWritten: after.xmlVersions - before.xmlVersions,
        eventOccurrencesWritten: after.events - before.events,
        xmlVerifiedDocumentsAdded: after.xmlVerifiedDocuments - before.xmlVerifiedDocuments,
        changedPayloadsSinceFirstCycle: cycle === 2 ? changedPayloads : 0,
        failures, httpStatus,
      };
      cycles.push(result);
      console.log(JSON.stringify({ cycleResult: result }));
      if (httpStatus === 429) break;
    }
    const report = { database: marker.MSSQL_DATABASE, schedulerEnabled: false, role: 'received', from, to, cycles,
      replayWithoutNewWrites: cycles.length === 2 && cycles[1].documentsWritten === 0 && cycles[1].occurrencesWritten === 0,
      deduplicationDemonstrated: cycles.length === 2 && cycles[0].uniqueReceivedNotes > 0 &&
        cycles[1].uniqueReceivedNotes === cycles[0].uniqueReceivedNotes && cycles[1].changedPayloadsSinceFirstCycle === 0 &&
        cycles[1].documentsWritten === 0 && cycles[1].occurrencesWritten === 0,
      checkpointTouched: false };
    await writeFile(new URL('result.json', outputDir), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ finalResult: report }));
    if (cycles.length !== 2 || cycles.some((entry) => Object.values(entry.failures).some((count) => count > 0))) process.exitCode = 1;
  } finally { await app.close(); }
} else if (mode === 'cycle') {
  assert.equal(process.argv.length, 6, 'Use cycle fromISO toISO overlapMs');
  const fromDate = new Date(process.argv[3]);
  const toDate = new Date(process.argv[4]);
  const overlapMs = Number(process.argv[5]);
  assert.ok(Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime()));
  assert.ok(Number.isSafeInteger(overlapMs) && overlapMs > 0);
  assert.ok(fromDate < toDate && toDate.getTime() - fromDate.getTime() <= 3_600_000);
  assert.ok(fromDate.getTime() + overlapMs <= toDate.getTime());
  const seedAt = new Date(fromDate.getTime() + overlapMs);
  const app = await createPool('app');
  try {
    const company = (await app.request().query('SELECT cnpj,status,activatedAt,halleyCompanyId,qiveValidationEvidenceRef FROM contei.EmpresaFiscal WHERE id=1')).recordset[0];
    assert.ok(company && company.cnpj === cnpj && company.status === 'ACTIVE');
    assert.equal(company.halleyCompanyId, 'manual-qive-local');
    assert.equal(company.qiveValidationEvidenceRef, 'TEST_ONLY_NOT_PILOT');
    assert.ok(fromDate >= new Date(company.activatedAt));
    const checkpoint = (await app.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1')).recordset[0];
    if (checkpoint) assert.equal(new Date(checkpoint.newRecordsCoveredUntil).toISOString(), seedAt.toISOString(), 'Checkpoint já pertence a outra janela');
    else await app.request().input('seed', sql.DateTimeOffset, seedAt).query('INSERT INTO contei.SyncCheckpoint (empresaId,newRecordsCoveredUntil) VALUES (1,@seed)');
    const counts = async () => (await app.request().query(`SELECT
      (SELECT COUNT(*) FROM contei.DocumentoEntrada WHERE empresaId=1) AS documents,
      (SELECT COUNT(*) FROM contei.OcorrenciaDocumental) AS occurrences,
      (SELECT COUNT(*) FROM contei.OcorrenciaDocumental WHERE kind='XML') AS xmlVersions,
      (SELECT COUNT(*) FROM contei.OcorrenciaDocumental WHERE kind='EVENT') AS events,
      (SELECT COUNT(*) FROM contei.FalhaIntegracao WHERE state='OPEN') AS openFailures`)).recordset[0];
    const before = await counts();
    let result;
    let failure = null;
    try { result = await runDiscovery(app, qive, toDate, overlapMs); }
    catch (error) { failure = { kind: error instanceof QiveError ? 'qive' : 'unexpected', httpStatus: error instanceof QiveError ? error.status ?? qive.status().httpStatus : null }; }
    const after = await counts();
    const covered = (await app.request().query('SELECT newRecordsCoveredUntil,lastSuccessfulNewPollAt FROM contei.SyncCheckpoint WHERE empresaId=1')).recordset[0];
    console.log(JSON.stringify({ database: marker.MSSQL_DATABASE, schedulerEnabled: false, role: 'received',
      requestedFrom: fromDate.toISOString(), requestedTo: toDate.toISOString(), overlapMs,
      processed: result?.processed ?? null, documentsAdded: after.documents - before.documents,
      occurrencesAdded: after.occurrences - before.occurrences, xmlVersionsAdded: after.xmlVersions - before.xmlVersions,
      eventsAdded: after.events - before.events, openFailuresBefore: before.openFailures, openFailuresAfter: after.openFailures,
      checkpoint: new Date(covered.newRecordsCoveredUntil).toISOString(),
      lastSuccessfulNewPollAt: covered.lastSuccessfulNewPollAt ? new Date(covered.lastSuccessfulNewPollAt).toISOString() : null,
      failure }));
    if (failure) process.exitCode = 1;
  } finally { await app.close(); }
} else if (mode === 'verify') {
  assert.equal(process.argv.length, 3, 'Use verify sem argumentos');
  const app = await createPool('app');
  try {
    const states = (await app.request().query('SELECT captureState, COUNT(*) AS documents FROM contei.DocumentoEntrada GROUP BY captureState')).recordset;
    const occurrences = (await app.request().query(`SELECT kind, sourceSection, isValidXml, validationErrorCode,
      COUNT(*) AS occurrences,
      SUM(CASE WHEN HASHBYTES('SHA2_256', rawPayload)=sha256 THEN 1 ELSE 0 END) AS matchingHashes,
      SUM(CASE WHEN eventXmlBytes IS NOT NULL THEN 1 ELSE 0 END) AS eventXmlCount,
      SUM(CASE WHEN eventXmlBytes IS NOT NULL AND HASHBYTES('SHA2_256',eventXmlBytes)=eventXmlSha256 THEN 1 ELSE 0 END) AS matchingEventXmlHashes
      FROM contei.OcorrenciaDocumental GROUP BY kind,sourceSection,isValidXml,validationErrorCode`)).recordset;
    const checkpoint = (await app.request().query('SELECT newRecordsCoveredUntil,lastSuccessfulNewPollAt FROM contei.SyncCheckpoint WHERE empresaId=1')).recordset[0] ?? null;
    const openFailures = (await app.request().query("SELECT COUNT(*) AS openFailures FROM contei.FalhaIntegracao WHERE state='OPEN'")).recordset[0].openFailures;
    const xmlRows = (await app.request().query(`SELECT d.accessKey, o.rawPayload
      FROM contei.OcorrenciaDocumental o JOIN contei.DocumentoEntrada d ON d.id=o.documentoId WHERE o.kind='XML'`)).recordset;
    const xmlStructure = [];
    for (const row of xmlRows) {
      const parser = new SaxesParser({ xmlns: true });
      const stack = [];
      let root = null;
      let infNfeCount = 0;
      let protNfeCount = 0;
      let infIdMatches = false;
      let protKeyMatches = false;
      let protocolNumberPresent = false;
      let protocolKey = '';
      let protocolNumber = '';
      parser.on('opentag', (tag) => {
        stack.push(tag.local);
        if (stack.length === 1) root = tag.local;
        if (tag.local === 'infNFe') { infNfeCount++; infIdMatches ||= String(tag.attributes.Id?.value || '') === `NFe${row.accessKey}`; }
        if (tag.local === 'protNFe') protNfeCount++;
      });
      parser.on('text', (value) => {
        const path = stack.join('/');
        if (path.endsWith('protNFe/infProt/chNFe')) protocolKey += value;
        if (path.endsWith('protNFe/infProt/nProt')) protocolNumber += value;
      });
      parser.on('closetag', () => stack.pop());
      parser.write(new TextDecoder().decode(row.rawPayload)).close();
      protKeyMatches = protocolKey.trim() === row.accessKey;
      protocolNumberPresent = Boolean(protocolNumber.trim());
      xmlStructure.push({ root, infNfeCount, protNfeCount, infIdMatches, protKeyMatches, protocolNumberPresent });
    }
    console.log(JSON.stringify({ database: marker.MSSQL_DATABASE, states, occurrences, openFailures,
      checkpoint: checkpoint ? { newRecordsCoveredUntil: checkpoint.newRecordsCoveredUntil, lastSuccessfulNewPollAt: checkpoint.lastSuccessfulNewPollAt } : null, xmlStructure }));
  } finally { await app.close(); }
} else throw new Error('Use setup, search, discover [fromISO toISO], cycle fromISO toISO overlapMs ou verify');
