import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQiveClient, QiveError } from '../src/qive.ts';
import { createPool, ingestSnapshot, type InboundSnapshot } from '../src/db.ts';
import { runDiscovery } from '../src/sync.ts';
import { readQiveConfig } from '../src/config.ts';

function keyFor(seed: number) {
  const base = '35260911222333000181550010000001231000001230'.slice(0, 34) + seed.toString().padStart(8, '0') + '3';
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(base[i]) * weight;
  const digit = 11 - sum % 11;
  return base + String(digit >= 10 ? 0 : digit);
}

test('configuração Qive compartilhada mantém CNPJ explícito e recusa valores não configurados', () => {
  const fixture = {
    CONTEI_CNPJ: '11444777000161', QIVE_BASE_URL: 'https://sandbox-api.arquivei.com.br', QIVE_API_ID: 'fixture', QIVE_API_KEY: 'fixture',
    QIVE_RECEIVED_ROLE: 'received', QIVE_PAGE_LIMIT: '1', QIVE_EMISSION_FROM: '2006-01-01',
    QIVE_FIELDS_KEY: 'Fields', QIVE_PAGINATOR_KEY: 'Paginator', QIVE_XML_ENCODING: 'raw', QIVE_EVENT_XML_ENCODING: 'base64',
    QIVE_TIMEOUT_MS: '1000', QIVE_MAX_RESPONSE_BYTES: '4096', QIVE_MAX_XML_BYTES: '1024',
  };
  const previous = Object.fromEntries(Object.keys(fixture).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, fixture);
    const config = readQiveConfig('11222333000181');
    assert.equal(config.cnpj, '11222333000181');
    assert.equal(config.xmlEncoding, 'raw');
    assert.equal(config.eventXmlEncoding, 'base64');
    for (const name of Object.keys(fixture).filter((name) => name !== 'CONTEI_CNPJ')) {
      const valid = process.env[name];
      process.env[name] = '';
      assert.throws(() => readQiveConfig('11222333000181'), new RegExp(name));
      process.env[name] = valid;
    }
    for (const [name, invalid] of Object.entries({ QIVE_FIELDS_KEY: 'unknown', QIVE_PAGINATOR_KEY: 'unknown', QIVE_XML_ENCODING: 'unknown', QIVE_EVENT_XML_ENCODING: 'unknown', QIVE_PAGE_LIMIT: '0', QIVE_TIMEOUT_MS: '-1', QIVE_MAX_RESPONSE_BYTES: '1.5', QIVE_MAX_XML_BYTES: 'NaN' })) {
      const valid = process.env[name];
      process.env[name] = invalid;
      assert.throws(() => readQiveConfig('11222333000181'), new RegExp(name));
      process.env[name] = valid;
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('adaptador pede somente recebidas e preserva lexema numérico desconhecido', async () => {
  const bodies: Record<string, unknown>[] = [];
  const response = '{"Nfes":[{"AccessKey":"35260911222333000181550010000001231000001230","CreatedAt":"2026-09-24T10:00:00Z","OwnerRole":"received","Status":"authorized","Xml":"<x/>","Unknown":900719925474099312345},{"AccessKey":"35260911222333000181550010000001231000001230","CreatedAt":"2026-09-24T10:00:00Z","OwnerRole":"authorized","Status":"authorized","Xml":"<x/>"}],"Paginator":null}';
  const client = createQiveClient({
    baseUrl: 'https://sandbox-api.arquivei.com.br', apiId: 'test', apiKey: 'test',
    cnpj: '11222333000181', receivedRole: 'received', pageLimit: 1,
    emissionFrom: '2006-01-01', fieldsKey: 'Fields', paginatorKey: 'Paginator',
    xmlEncoding: 'raw', eventXmlEncoding: 'raw', timeoutMs: 1000, maxResponseBytes: 4096, maxXmlBytes: 1024,
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(response, { status: 200 }); },
  });
  const page = await client.listPage('2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z');
  assert.deepEqual((bodies[0].Filters as Record<string, unknown>).OwnerRoles, ['received']);
  assert.deepEqual((bodies[0].Filters as Record<string, unknown>).Owners, ['11222333000181']);
  assert.deepEqual((bodies[0].Filters as Record<string, unknown>).EmissionDate, { From: '2006-01-01', To: '2026-09-27' });
  assert.deepEqual((bodies[0].Filters as Record<string, unknown>).CreatedAt, { From: '2026-09-24T00:00:00Z', To: '2026-09-25T00:00:00Z' });
  assert.ok(Array.isArray(bodies[0].Fields));
  assert.equal(page.items.length, 1);
  assert.ok(page.items[0].rawPayload.toString('utf8').includes('900719925474099312345'));
  assert.deepEqual(page.items[0].xmlBytes, Buffer.from('<x/>'));
});

const qiveConfig = {
  baseUrl: 'https://sandbox-api.arquivei.com.br', apiId: 'test', apiKey: 'test', cnpj: '11222333000181', receivedRole: 'received', pageLimit: 1,
  emissionFrom: '2006-01-01', fieldsKey: 'Fields', paginatorKey: 'Paginator', xmlEncoding: 'raw', eventXmlEncoding: 'raw',
  timeoutMs: 1000, maxResponseBytes: 4096, maxXmlBytes: 1024,
} as const;

test('descoberta não admite item sem OwnerRole confirmado', async () => {
  const items = [
    { AccessKey: keyFor(51), CreatedAt: '2026-09-24T10:00:00Z', OwnerRole: 'received', Status: 'authorized' },
    { AccessKey: keyFor(52), CreatedAt: '2026-09-24T10:00:00Z', Status: 'authorized' },
  ];
  const client = createQiveClient({ ...qiveConfig, fetchImpl: async () => new Response(JSON.stringify({ Nfes: items, Paginator: null })) });
  const page = await client.listPage('2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z');
  assert.deepEqual(page.items.map((item) => item.accessKey), [keyFor(51)]);
  assert.equal(page.failedItems, 1);
});

test('item inválido não impede leitura da recebida válida na mesma página', async () => {
  const items = [
    { AccessKey: keyFor(53), CreatedAt: '2026-09-24T10:00:00Z', OwnerRole: 'received', Status: 'unknown' },
    { AccessKey: keyFor(54), CreatedAt: '2026-09-24T10:00:00Z', OwnerRole: 'received', Status: 'authorized' },
  ];
  const client = createQiveClient({ ...qiveConfig, fetchImpl: async () => new Response(JSON.stringify({ Nfes: items, Paginator: null })) });
  const page = await client.listPage('2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z');
  assert.deepEqual(page.items.map((item) => item.accessKey), [keyFor(54)]);
  assert.equal(page.failedItems, 1);
});

test('chave inválida antes de recebida válida preserva a segunda e bloqueia o checkpoint', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const deploy = await createPool('deploy');
  try {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    const validKey = keyFor(Math.floor(Math.random() * 1e8));
    const invalidKey = validKey.slice(0, -1) + String((Number(validKey.at(-1)) + 1) % 10);
    const createdAt = '2026-09-24T10:00:00Z';
    const items = [invalidKey, validKey].map((AccessKey) => ({ AccessKey, CreatedAt: createdAt, OwnerRole: 'received', Status: 'authorized' }));
    const qive = createQiveClient({ ...qiveConfig, fetchImpl: async () => new Response(JSON.stringify({ Nfes: items, Paginator: null })) });
    await assert.rejects(runDiscovery(app, qive, new Date('2026-09-24T14:00:00Z'), 60_000), QiveError);
    const documents = await app.request().input('valid', validKey).input('invalid', invalidKey)
      .query('SELECT accessKey FROM contei.DocumentoEntrada WHERE accessKey IN (@valid,@invalid)');
    assert.deepEqual(documents.recordset.map((row) => row.accessKey), [validKey]);
    const checkpoint = await app.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    assert.equal(checkpoint.recordset.length, 0);
  } finally {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    await deploy.close();
    await app.close();
  }
});

test('sobreposição do checkpoint captura recebida publicada após a janela anterior', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const deploy = await createPool('deploy');
  try {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    await app.request().query("INSERT INTO contei.SyncCheckpoint (empresaId,newRecordsCoveredUntil) VALUES (1,'2026-09-24T15:00:00+00:00')");
    const key = keyFor(Math.floor(Math.random() * 1e8));
    const lateAt = '2026-09-24T14:59:30Z';
    const entry: InboundSnapshot = { accessKey: key, createdAt: lateAt, origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, CreatedAt: lateAt, Status: 'authorized' })) };
    const fromValues: string[] = [];
    const result = await runDiscovery(app, { listPage: async (from) => {
      fromValues.push(from);
      return { items: Date.parse(from) <= Date.parse(lateAt) ? [entry] : [], nextPaginator: null };
    } }, new Date('2026-09-24T15:05:00Z'), 60_000);
    assert.equal(result.processed, 1);
    assert.deepEqual(fromValues, ['2026-09-24T14:59:00.000Z']);
    const document = await app.request().input('key', key).query('SELECT id FROM contei.DocumentoEntrada WHERE accessKey=@key');
    assert.equal(document.recordset.length, 1);
    const checkpoint = await app.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    assert.equal(new Date(checkpoint.recordset[0].newRecordsCoveredUntil).toISOString(), '2026-09-24T15:05:00.000Z');
  } finally {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    await deploy.close();
    await app.close();
  }
});

// Qive simulada que aplica todos os filtros juntos e lê `To` só com data como início do dia UTC, a leitura mais restritiva.
function filteringQive(items: Record<string, string>[], bodies: Record<string, any>[]) {
  return async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const { CreatedAt, EmissionDate, DocumentIdentifier } = body.Filters;
    const nfes = items.filter((item) => (!DocumentIdentifier || item.AccessKey === DocumentIdentifier)
      && (!CreatedAt || (Date.parse(item.CreatedAt) >= Date.parse(CreatedAt.From) && Date.parse(item.CreatedAt) <= Date.parse(CreatedAt.To)))
      && Date.parse(item.EmissionDate) >= Date.parse(EmissionDate.From) && Date.parse(item.EmissionDate) < Date.parse(EmissionDate.To));
    return new Response(JSON.stringify({ Nfes: nfes, Paginator: null }), { status: 200 });
  };
}

test('janela de emissão acompanha o fim da consulta, sem data fixa e com margem na virada do dia UTC', async () => {
  const later = { AccessKey: keyFor(1), CreatedAt: '2030-06-01T10:00:00Z', EmissionDate: '2030-06-01T07:00:00-03:00', OwnerRole: 'received', Status: 'authorized' };
  const nearMidnight = { AccessKey: keyFor(2), CreatedAt: '2026-09-24T23:59:10Z', EmissionDate: '2026-09-24T21:04:00-03:00', OwnerRole: 'received', Status: 'authorized' };
  const bodies: Record<string, any>[] = [];
  const client = createQiveClient({ ...qiveConfig, fetchImpl: filteringQive([later, nearMidnight], bodies) });
  const future = await client.listPage('2030-06-01T00:00:00Z', '2030-06-02T00:00:00Z');
  assert.deepEqual(future.items.map((item) => item.accessKey), [later.AccessKey]);
  assert.deepEqual(bodies[0].Filters.EmissionDate, { From: '2006-01-01', To: '2030-06-04' });
  // Emitente com relógio adiantado: dhEmi (00:04Z) posterior ao CreatedAt e ao fim da janela (23:59:30Z).
  const boundary = await client.listPage('2026-09-24T23:00:00Z', '2026-09-24T23:59:30Z');
  assert.deepEqual(boundary.items.map((item) => item.accessKey), [nearMidnight.AccessKey]);
});

test('consulta por chave deriva o fim da janela de emissão do relógio, uma vez para todas as páginas', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-06-02T23:30:00Z') });
  const known = { AccessKey: keyFor(3), CreatedAt: '2030-06-02T23:00:00Z', EmissionDate: '2030-06-02T20:00:00-03:00', OwnerRole: 'received', Status: 'authorized' };
  const bodies: Record<string, any>[] = [];
  const secondPage = filteringQive([known], bodies);
  const client = createQiveClient({ ...qiveConfig, fetchImpl: async (url, init) => {
    if (JSON.parse(String(init?.body)).Paginator) return secondPage(url, init);
    bodies.push(JSON.parse(String(init?.body)));
    t.mock.timers.tick(3_600_000); // a paginação atravessa a meia-noite UTC
    return new Response(JSON.stringify({ Nfes: [], Paginator: 'next' }), { status: 200 });
  } });
  const found = await client.getKnown(known.AccessKey);
  assert.equal(found?.accessKey, known.AccessKey);
  assert.deepEqual(bodies.map((body) => body.Filters.EmissionDate), [{ From: '2006-01-01', To: '2030-06-04' }, { From: '2006-01-01', To: '2030-06-04' }]);
  assert.ok(bodies.every((body) => body.Filters.CreatedAt === undefined));
});

test('fronteira inclusiva, página repetida e captura concorrente convergem no SQL', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const deploy = await createPool('deploy');
  try {
    const company = await app.request().query('SELECT activatedAt FROM contei.EmpresaFiscal WHERE id=1');
    const activatedAt = new Date(company.recordset[0].activatedAt);
    const key = keyFor(Math.floor(Math.random() * 1e8));
    const earlyKey = keyFor(Math.floor(Math.random() * 1e8));
    const entry: InboundSnapshot = { accessKey: key, createdAt: activatedAt.toISOString(), origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, EmissionDate: '2020-01-01', CreatedAt: activatedAt.toISOString(), Status: 'authorized' })) };
    const early: InboundSnapshot = { ...entry, accessKey: earlyKey, createdAt: new Date(activatedAt.getTime() - 1).toISOString(),
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: earlyKey, CreatedAt: new Date(activatedAt.getTime() - 1).toISOString() })) };
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    const fromValues: string[] = [];
    const toValues: string[] = [];
    const qive = { listPage: async (from: string, to: string, paginator?: string) => {
      fromValues.push(from);
      toValues.push(to);
      return { items: paginator ? [entry] : [entry, early], nextPaginator: paginator ? null : 'second' };
    } };
    const result = await runDiscovery(app, qive, new Date('2026-09-24T14:00:00Z'), 60_000);
    assert.equal(result.processed, 3);
    // Mesmo fim de janela em todas as páginas: o adaptador deriva dele o EmissionDate.To enviado com o mesmo Paginator.
    assert.deepEqual(toValues, ['2026-09-24T14:00:00.000Z', '2026-09-24T14:00:00.000Z']);
    assert.deepEqual(fromValues, [activatedAt.toISOString(), activatedAt.toISOString()]);
    await Promise.all([ingestSnapshot(app, entry), ingestSnapshot(app, entry)]);
    const document = await app.request().input('key', key).query('SELECT id,scope,reviewVersion FROM contei.DocumentoEntrada WHERE accessKey=@key');
    assert.equal(document.recordset.length, 1);
    assert.equal(document.recordset[0].scope, 'IN');
    assert.equal(document.recordset[0].reviewVersion, 1);
    const occurrences = await app.request().input('id', document.recordset[0].id).query('SELECT id FROM contei.OcorrenciaDocumental WHERE documentoId=@id');
    assert.equal(occurrences.recordset.length, 1);
    const before = await app.request().input('key', earlyKey).query('SELECT scope FROM contei.DocumentoEntrada WHERE accessKey=@key');
    assert.equal(before.recordset[0].scope, 'OUT');
  } finally { await deploy.close(); await app.close(); }
});

test('adaptador tipa 429 e preserva Retry-After sem expor credenciais', async () => {
  const client = createQiveClient({ baseUrl: 'https://sandbox-api.arquivei.com.br', apiId: 'test', apiKey: 'test', cnpj: '11222333000181',
    receivedRole: 'received', pageLimit: 1, emissionFrom: '2006-01-01', fieldsKey: 'Fields', paginatorKey: 'Paginator', xmlEncoding: 'base64', eventXmlEncoding: 'base64', timeoutMs: 1000, maxResponseBytes: 4096, maxXmlBytes: 1024,
    fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }),
  });
  await assert.rejects(client.listPage('2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z'), (error: unknown) => error instanceof QiveError && error.status === 429 && error.retryAfter === '60' && !error.message.includes('test'));
});

test('adaptador interrompe resposta maior que o limite configurado', async () => {
  const client = createQiveClient({ baseUrl: 'https://sandbox-api.arquivei.com.br', apiId: 'test', apiKey: 'test', cnpj: '11222333000181',
    receivedRole: 'received', pageLimit: 1, emissionFrom: '2006-01-01', fieldsKey: 'Fields', paginatorKey: 'Paginator',
    xmlEncoding: 'raw', eventXmlEncoding: 'raw', timeoutMs: 1000, maxResponseBytes: 5, maxXmlBytes: 5,
    fetchImpl: async () => new Response('{"Nfes":[]}', { status: 200 }),
  });
  await assert.rejects(client.listPage('2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z'), (error: unknown) => error instanceof QiveError && error.message.includes('limite'));
});

test('falha de item preserva recebidas válidas e impede avanço do checkpoint', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const app = await createPool('app');
  const deploy = await createPool('deploy');
  try {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    const key = keyFor(Math.floor(Math.random() * 1e8));
    const entry: InboundSnapshot = { accessKey: key, createdAt: '2026-09-24T10:00:00Z', origin: 'fixture', status: 'authorized', canceled: false,
      rawPayload: Buffer.from(JSON.stringify({ AccessKey: key, CreatedAt: '2026-09-24T10:00:00Z', Status: 'authorized' })) };
    await assert.rejects(runDiscovery(app, { listPage: async () => ({ items: [entry], nextPaginator: null, failedItems: 1 }) }, new Date('2026-09-24T14:00:00Z'), 60_000), QiveError);
    const document = await app.request().input('key', key).query('SELECT id FROM contei.DocumentoEntrada WHERE accessKey=@key');
    assert.equal(document.recordset.length, 1);
    const checkpoint = await app.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    assert.equal(checkpoint.recordset.length, 0);
  } finally {
    await deploy.request().query('DELETE FROM contei.SyncCheckpoint WHERE empresaId=1');
    await deploy.close();
    await app.close();
  }
});

test('descoberta só avança checkpoint após todas as páginas e para ao desativar', { skip: !process.env.MSSQL_DATABASE && 'MSSQL de teste não configurado' }, async () => {
  const pool = await createPool('app');
  const calls: string[] = [];
  const client = { listPage: async (_from: string, _to: string, paginator?: string) => {
    calls.push(paginator || 'first');
    return { items: [], nextPaginator: paginator ? null : 'next' };
  } };
  try {
    await pool.request().query("IF NOT EXISTS (SELECT 1 FROM contei.EmpresaFiscal WHERE id=1) INSERT INTO contei.EmpresaFiscal (id, halleyCompanyId, cnpj, status, activatedAt, qiveConnectionRef, qiveValidatedAt, qiveValidationEvidenceRef, certificateEvidenceRef, completeCaptureEvidenceRef) VALUES (1, 'fixture-halley', '11222333000181', 'ACTIVE', '2026-01-01T00:00:00+00:00', 'fixture-qive', '2026-01-01T00:00:00+00:00', 'fixture-only', 'fixture-only', 'fixture-only')");
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    const result = await runDiscovery(pool, client, new Date('2026-09-24T15:00:00Z'), 60_000);
    assert.equal(result.processed, 0);
    assert.deepEqual(calls, ['first', 'next']);
    const checkpoint = await pool.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    assert.equal(new Date(checkpoint.recordset[0].newRecordsCoveredUntil).toISOString(), '2026-09-24T15:00:00.000Z');
    await assert.rejects(runDiscovery(pool, { listPage: async (_from, _to, paginator) => {
      if (paginator) throw new QiveError('Falha de comunicação Qive');
      return { items: [], nextPaginator: 'next' };
    } }, new Date('2026-09-24T15:30:00Z'), 60_000));
    const afterFailure = await pool.request().query('SELECT newRecordsCoveredUntil FROM contei.SyncCheckpoint WHERE empresaId=1');
    assert.equal(new Date(afterFailure.recordset[0].newRecordsCoveredUntil).toISOString(), '2026-09-24T15:00:00.000Z');
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='INACTIVE' WHERE id=1");
    await runDiscovery(pool, client, new Date('2026-09-24T16:00:00Z'), 60_000);
    assert.deepEqual(calls, ['first', 'next']);
  } finally {
    await pool.request().query("UPDATE contei.EmpresaFiscal SET status='ACTIVE' WHERE id=1");
    await pool.close();
  }
});
