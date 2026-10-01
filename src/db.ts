import { readFile } from 'node:fs/promises';
import sql from 'mssql';
import { createHash } from 'node:crypto';
import { inspectXml, InvalidFiscalInput, isValidAccessKey, recommend, validateDecision, type DecisionRequest, type XmlEvidence } from './triagem.ts';
import { extractDeclaredItems, ItemExtractionError, type DeclaredItem, type ItemErrorCode } from './itens.ts';

export type SqlPool = sql.ConnectionPool;
export type SqlTransaction = sql.Transaction;

export async function createPool(kind: 'deploy' | 'app'): Promise<SqlPool> {
  const prefix = kind === 'deploy' ? 'MSSQL_DEPLOY_' : 'MSSQL_APP_';
  const user = process.env[`${prefix}USER`];
  const password = process.env[`${prefix}PASSWORD`];
  const database = process.env.MSSQL_DATABASE;
  if (!user || !password || !database) throw new Error(`Configuração MSSQL ${kind} incompleta`);
  return new sql.ConnectionPool({
    server: process.env.MSSQL_HOST || 'localhost',
    port: Number(process.env.MSSQL_PORT || 1433),
    database,
    user,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
      abortTransactionOnError: true,
    },
    pool: {
      // O nível SERIALIZABLE de uma transação permanece na sessão após commit, rollback ou abort.
      // Em vez do SELECT 1 padrão, reset() valida a conexão e reaplica READ COMMITTED antes de cada reuso.
      // O tarn aguarda a Promise, embora o tipo publicado de validate declare boolean.
      validate: (connection) => new Promise<boolean>((resolve) => connection.reset((error) => resolve(!error))) as unknown as boolean,
    },
  }).connect();
}

export async function runMigration(pool: SqlPool, version: string, script: string): Promise<void> {
  if (version !== '000') {
    const existing = await pool.request().input('version', sql.VarChar(32), version)
      .query('SELECT 1 AS found FROM contei.Migration WHERE version = @version');
    if (existing.recordset.length) return;
  } else {
    const existing = await pool.request().query("SELECT OBJECT_ID('contei.Migration') AS id");
    if (existing.recordset[0].id !== null) return;
  }
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction).batch(`SET XACT_ABORT ON;\n${script}`);
    await new sql.Request(transaction).input('version', sql.VarChar(32), version)
      .query('INSERT INTO contei.Migration (version) VALUES (@version)');
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch { /* XACT_ABORT may already have rolled back. */ }
    throw error;
  }
}

export async function migrate(pool: SqlPool): Promise<void> {
  for (const [version, name] of [['000', 'schema_version'], ['001', 'triagem_nfe'], ['002', 'itens_nfe']]) {
    const script = await readFile(new URL(`../migrations/${version}_${name}.sql`, import.meta.url), 'utf8');
    await runMigration(pool, version, script);
  }
  const appUser = process.env.MSSQL_APP_USER;
  if (appUser) {
    const membership = await pool.request().input('name', sql.NVarChar(128), appUser).query(`
      SELECT 1 AS found FROM sys.database_role_members drm
      JOIN sys.database_principals r ON r.principal_id = drm.role_principal_id
      JOIN sys.database_principals m ON m.principal_id = drm.member_principal_id
      WHERE r.name = 'contei_runtime' AND m.name = @name`);
    if (!membership.recordset.length) {
      await pool.request().batch(`ALTER ROLE contei_runtime ADD MEMBER [${appUser.replaceAll(']', ']]')}];`);
    }
  }
}

if (import.meta.main && process.argv[2] === 'migrate') {
  const pool = await createPool('deploy');
  try { await migrate(pool); } finally { await pool.close(); }
}

export type InboundSnapshot = {
  accessKey: string;
  createdAt: string;
  origin: string | null;
  status: string;
  canceled: boolean;
  rawPayload: Buffer;
  xmlBytes?: Buffer;
  events?: Array<{ section: 'EVENTS' | 'MANIFESTATIONS'; rawPayload: Buffer; eventType?: string; eventXmlBytes?: Buffer }>;
};

export type FiscalActor = { id: string; role: string };

export class ConflictError extends Error {
  readonly currentReviewVersion: number;
  constructor(message: string, version: number) { super(message); this.currentReviewVersion = version; }
}
export class NotFoundError extends Error {}

const digest = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();

// Versão XML padrão: última ocorrência válida em (observedAt,id); latestValidXmlOccurrenceId é só projeção.
function selectXmlVersion(request: sql.Request, documentId: number, occurrenceId: string | null = null) {
  return request.input('documentId', sql.BigInt, documentId).input('selectedId', sql.BigInt, occurrenceId)
    .query("SELECT TOP (1) id,observedAt,sha256 FROM contei.OcorrenciaDocumental WHERE documentoId=@documentId AND kind='XML' AND isValidXml=1 AND (@selectedId IS NULL OR id=@selectedId) ORDER BY observedAt DESC,id DESC");
}

async function insertOccurrence(transaction: SqlTransaction, documentId: number, kind: 'SNAPSHOT' | 'XML' | 'EVENT', section: 'NFE' | 'EVENTS' | 'MANIFESTATIONS', payload: Buffer, extra: { valid?: boolean | null; errorCode?: string | null; origin?: string | null; eventType?: string | null; eventXmlBytes?: Buffer } = {}): Promise<{ id: number; fresh: boolean }> {
  const hash = digest(payload);
  const matching = await new sql.Request(transaction)
    .input('documentId', sql.BigInt, documentId).input('kind', sql.VarChar(8), kind)
    .input('section', sql.VarChar(14), section).input('hash', sql.VarBinary(32), hash)
    .query(`SELECT id, collisionOrdinal, rawPayload FROM contei.OcorrenciaDocumental WITH (UPDLOCK, HOLDLOCK)
      WHERE documentoId=@documentId AND kind=@kind AND sourceSection=@section AND sha256=@hash ORDER BY collisionOrdinal`);
  for (const row of matching.recordset) if (Buffer.compare(row.rawPayload, payload) === 0) return { id: Number(row.id), fresh: false };
  const ordinal = matching.recordset.length ? Number(matching.recordset.at(-1).collisionOrdinal) + 1 : 0;
  const inserted = await new sql.Request(transaction)
    .input('documentId', sql.BigInt, documentId).input('kind', sql.VarChar(8), kind)
    .input('section', sql.VarChar(14), section).input('payload', sql.VarBinary(sql.MAX), payload)
    .input('hash', sql.VarBinary(32), hash).input('ordinal', sql.Int, ordinal)
    .input('contentType', sql.VarChar(32), kind === 'XML' ? 'application/xml' : 'application/json')
    .input('valid', sql.Bit, extra.valid ?? null).input('errorCode', sql.VarChar(80), extra.errorCode ?? null)
    .input('origin', sql.NVarChar(100), extra.origin ?? null).input('eventType', sql.NVarChar(100), extra.eventType ?? null)
    .input('eventXml', sql.VarBinary(sql.MAX), extra.eventXmlBytes ?? null)
    .input('eventXmlHash', sql.VarBinary(32), extra.eventXmlBytes ? digest(extra.eventXmlBytes) : null)
    .query(`INSERT INTO contei.OcorrenciaDocumental
      (documentoId, kind, sourceSection, rawPayload, sha256, collisionOrdinal, contentType, isValidXml, validationErrorCode, origin, eventType, eventXmlBytes, eventXmlSha256)
      OUTPUT INSERTED.id VALUES (@documentId,@kind,@section,@payload,@hash,@ordinal,@contentType,@valid,@errorCode,@origin,@eventType,@eventXml,@eventXmlHash)`);
  return { id: Number(inserted.recordset[0].id), fresh: true };
}

export async function ingestSnapshot(pool: SqlPool, snapshot: InboundSnapshot): Promise<number> {
  if (!isValidAccessKey(snapshot.accessKey) || !Number.isFinite(Date.parse(snapshot.createdAt)) || !snapshot.rawPayload.length) throw new InvalidFiscalInput('INVALID_QIVE_ITEM', 'Item Qive incompatível');
  let xml: XmlEvidence | null = null;
  let xmlError: string | null = null;
  if (snapshot.xmlBytes) {
    try { xml = inspectXml(snapshot.xmlBytes, snapshot.accessKey); }
    catch (error) { xmlError = error instanceof InvalidFiscalInput ? error.code : 'MALFORMED_XML'; }
  }
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await new sql.Request(transaction).query('SET XACT_ABORT ON');
    const company = await new sql.Request(transaction).query('SELECT id, status, activatedAt FROM contei.EmpresaFiscal WHERE id=1');
    if (!company.recordset.length || company.recordset[0].status !== 'ACTIVE') throw new InvalidFiscalInput('COMPANY_INACTIVE', 'Empresa fiscal não ativa');
    const inScope = new Date(snapshot.createdAt).getTime() >= new Date(company.recordset[0].activatedAt).getTime();
    let selected = await new sql.Request(transaction).input('key', sql.Char(44), snapshot.accessKey)
      .query('SELECT id,captureState FROM contei.DocumentoEntrada WITH (UPDLOCK, HOLDLOCK) WHERE empresaId=1 AND accessKey=@key');
    if (!selected.recordset.length) {
      selected = await new sql.Request(transaction).input('key', sql.Char(44), snapshot.accessKey)
        .input('createdAt', sql.DateTimeOffset, new Date(snapshot.createdAt))
        .input('scope', sql.VarChar(11), inScope ? 'IN' : 'OUT')
        .query("INSERT INTO contei.DocumentoEntrada (empresaId,accessKey,qiveCreatedAt,scope,captureState) OUTPUT INSERTED.id,INSERTED.captureState VALUES (1,@key,@createdAt,@scope,'AWAITING_XML')");
    }
    const document = selected.recordset[0];
    const documentId = Number(document.id);
    const snapshotOccurrence = await insertOccurrence(transaction, documentId, 'SNAPSHOT', 'NFE', snapshot.rawPayload, { origin: snapshot.origin });
    let xmlOccurrence: { id: number; fresh: boolean } | null = null;
    if (snapshot.xmlBytes) xmlOccurrence = await insertOccurrence(transaction, documentId, 'XML', 'NFE', snapshot.xmlBytes, { valid: !!xml, errorCode: xmlError, origin: snapshot.origin });
    let changed = snapshotOccurrence.fresh || !!xmlOccurrence?.fresh;
    for (const event of snapshot.events || []) {
      const inserted = await insertOccurrence(transaction, documentId, 'EVENT', event.section, event.rawPayload, { eventType: event.eventType, eventXmlBytes: event.eventXmlBytes, origin: snapshot.origin });
      changed ||= inserted.fresh;
    }
    const validXmlId = xml ? xmlOccurrence?.id : null;
    const latestValid = await selectXmlVersion(new sql.Request(transaction), documentId);
    const latestValidXmlId = latestValid.recordset[0]?.id ?? null;
    // Replay de XML antigo não sobrescreve o cabeçalho projetado da versão mais recente.
    const header = validXmlId && String(validXmlId) === String(latestValidXmlId) ? xml : null;
    const isVerified = !!validXmlId || document.captureState === 'XML_VERIFIED';
    const state = isVerified ? 'XML_VERIFIED' : xmlError ? 'TECHNICAL_BLOCKED' : 'AWAITING_XML';
    await new sql.Request(transaction)
      .input('id', sql.BigInt, documentId).input('state', sql.VarChar(20), state)
      .input('status', sql.NVarChar(100), snapshot.status).input('canceled', sql.Bit, snapshot.canceled)
      .input('changed', sql.Bit, changed).input('xmlId', sql.BigInt, validXmlId ?? null)
      .input('latestXmlId', sql.BigInt, latestValidXmlId)
      .input('number', sql.NVarChar(30), header?.number ?? null)
      .input('emitterName', sql.NVarChar(300), header?.emitterName ?? null)
      .input('emitterCnpj', sql.Char(14), header?.emitterCnpj ?? null)
      .input('receiverName', sql.NVarChar(300), header?.receiverName ?? null)
      .input('receiverCnpj', sql.Char(14), header?.receiverCnpj ?? null)
      .input('amount', sql.VarChar(16), header?.totalAmount ?? null)
      .input('issuedAt', sql.DateTimeOffset, header ? new Date(header.issuedAt) : null)
      .input('origin', sql.NVarChar(100), snapshot.origin)
      .query(`UPDATE contei.DocumentoEntrada SET
        lastCheckedAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),
        captureState=@state, qiveStatusRaw=@status, canceled=@canceled,
        firstXmlOccurrenceId=COALESCE(firstXmlOccurrenceId,@xmlId),
        latestValidXmlOccurrenceId=COALESCE(@latestXmlId,latestValidXmlOccurrenceId),
        triageEnteredAt=CASE WHEN @xmlId IS NOT NULL AND triageEnteredAt IS NULL AND scope='IN' THEN TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00') ELSE triageEnteredAt END,
        number=COALESCE(@number,number), emitterName=COALESCE(@emitterName,emitterName), emitterCnpj=COALESCE(@emitterCnpj,emitterCnpj),
        receiverName=COALESCE(@receiverName,receiverName), receiverCnpj=COALESCE(@receiverCnpj,receiverCnpj),
        totalAmount=COALESCE(CONVERT(decimal(15,2),@amount),totalAmount), issuedAt=COALESCE(@issuedAt,issuedAt), origin=COALESCE(@origin,origin),
        reviewVersion=reviewVersion+CASE WHEN @changed=1 THEN 1 ELSE 0 END,
        documentRevision=documentRevision+CASE WHEN @changed=1 THEN 1 ELSE 0 END,
        lastDocumentChangeAt=CASE WHEN @changed=1 THEN TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00') ELSE lastDocumentChangeAt END
        WHERE id=@id`);
    await transaction.commit();
    return documentId;
  } catch (error) {
    try { await transaction.rollback(); } catch { /* XACT_ABORT may have rolled back. */ }
    throw error;
  }
}

function decisionFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id), sequence: Number(row.sequence), outcome: row.outcome,
    reasonCode: row.reasonCode, observation: row.observation,
    actorId: row.actorId, actorRole: row.actorRole,
    decidedAt: new Date(row.decidedAt as string).toISOString(),
    basisReviewVersion: Number(row.basisReviewVersion), basisDocumentRevision: Number(row.basisDocumentRevision),
    evidenceSnapshot: JSON.parse(String(row.evidenceSnapshot)),
  };
}

async function readExistingDecision(pool: SqlPool, documentId: number, key: string, actor: FiscalActor, requestHash: Buffer) {
  const existing = await pool.request().input('id', sql.BigInt, documentId).input('key', sql.UniqueIdentifier, key)
    .query('SELECT t.*, d.reviewVersion AS currentReviewVersion FROM contei.DecisaoTriagem t JOIN contei.DocumentoEntrada d ON d.id=t.documentoId WHERE t.documentoId=@id AND t.idempotencyKey=@key');
  if (!existing.recordset.length) return null;
  const row = existing.recordset[0];
  if (row.actorId !== actor.id || Buffer.compare(row.requestHash, requestHash) !== 0) throw new ConflictError('Chave de idempotência reutilizada', Number(row.currentReviewVersion));
  return { reviewVersion: Number(row.basisReviewVersion) + 1, decision: decisionFromRow(row) };
}

export async function recordDecision(pool: SqlPool, accessKey: string, actor: FiscalActor, idempotencyKey: string, body: unknown) {
  const request: DecisionRequest = validateDecision(body);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new InvalidFiscalInput('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key inválida');
  const requestHash = digest(Buffer.from(JSON.stringify({ expectedReviewVersion: request.expectedReviewVersion, outcome: request.outcome, reasonCode: request.reasonCode, observation: request.observation ?? null })));
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let documentId: number | undefined;
  try {
    await new sql.Request(transaction).query('SET XACT_ABORT ON');
    const selected = await new sql.Request(transaction).input('key', sql.Char(44), accessKey)
      .query("SELECT * FROM contei.DocumentoEntrada WITH (UPDLOCK, HOLDLOCK) WHERE empresaId=1 AND accessKey=@key AND scope='IN'");
    if (!selected.recordset.length) throw new NotFoundError('NF-e não encontrada');
    const document = selected.recordset[0];
    documentId = Number(document.id);
    const existing = await new sql.Request(transaction).input('id', sql.BigInt, documentId).input('key', sql.UniqueIdentifier, idempotencyKey)
      .query('SELECT * FROM contei.DecisaoTriagem WHERE documentoId=@id AND idempotencyKey=@key');
    if (existing.recordset.length) {
      const row = existing.recordset[0];
      if (row.actorId !== actor.id || Buffer.compare(row.requestHash, requestHash) !== 0) throw new ConflictError('Chave de idempotência reutilizada', Number(document.reviewVersion));
      await transaction.commit();
      return { reviewVersion: Number(row.basisReviewVersion) + 1, decision: decisionFromRow(row) };
    }
    if (!document.triageEnteredAt || document.captureState !== 'XML_VERIFIED') throw new InvalidFiscalInput('NOT_TRIAGEABLE', 'Documento fora da triagem');
    if (Number(document.reviewVersion) !== request.expectedReviewVersion) throw new ConflictError('Revisão desatualizada', Number(document.reviewVersion));
    const occurrences = await new sql.Request(transaction).input('id', sql.BigInt, documentId)
      .query('SELECT id,kind,sourceSection,sha256 FROM contei.OcorrenciaDocumental WHERE documentoId=@id ORDER BY id');
    const xmlOccurrence = (await selectXmlVersion(new sql.Request(transaction), documentId)).recordset[0];
    const company = await new sql.Request(transaction).query('SELECT cnpj FROM contei.EmpresaFiscal WHERE id=1');
    const companyCnpj = String(company.recordset[0].cnpj);
    const evidence = {
      companyCnpj,
      receiverCnpj: document.receiverCnpj,
      recipientCnpjMismatch: document.receiverCnpj !== companyCnpj,
      canceled: !!document.canceled,
      documentRevision: Number(document.documentRevision),
      xmlSha256: xmlOccurrence?.sha256?.toString('hex') ?? null,
      xmlOccurrenceId: xmlOccurrence ? String(xmlOccurrence.id) : null,
      qiveStatus: document.qiveStatusRaw, origin: document.origin,
      consideredOccurrenceIds: occurrences.recordset.map((row) => String(row.id)),
      consideredOccurrences: occurrences.recordset.map((row) => ({ id: String(row.id), kind: row.kind, sourceSection: row.sourceSection, sha256: row.sha256.toString('hex') })),
      recommendation: recommend(String(document.receiverCnpj), companyCnpj, !!document.canceled),
    };
    const latest = await new sql.Request(transaction).input('id', sql.BigInt, documentId)
      .query('SELECT ISNULL(MAX(sequence),0) AS sequence FROM contei.DecisaoTriagem WHERE documentoId=@id');
    const sequence = Number(latest.recordset[0].sequence) + 1;
    const updated = await new sql.Request(transaction).input('id', sql.BigInt, documentId).input('version', sql.Int, request.expectedReviewVersion)
      .query('UPDATE contei.DocumentoEntrada SET reviewVersion=reviewVersion+1 WHERE id=@id AND reviewVersion=@version');
    if (updated.rowsAffected[0] !== 1) throw new ConflictError('Revisão desatualizada', Number(document.reviewVersion));
    const inserted = await new sql.Request(transaction)
      .input('id', sql.BigInt, documentId).input('sequence', sql.Int, sequence)
      .input('outcome', sql.VarChar(18), request.outcome).input('reason', sql.VarChar(48), request.reasonCode)
      .input('observation', sql.NVarChar(sql.MAX), request.observation ?? null)
      .input('actor', sql.NVarChar(200), actor.id).input('role', sql.NVarChar(100), actor.role)
      .input('basisReview', sql.Int, request.expectedReviewVersion).input('basisDocument', sql.Int, Number(document.documentRevision))
      .input('evidence', sql.NVarChar(sql.MAX), JSON.stringify(evidence))
      .input('key', sql.UniqueIdentifier, idempotencyKey).input('requestHash', sql.VarBinary(32), requestHash)
      .query(`INSERT INTO contei.DecisaoTriagem (documentoId,sequence,outcome,reasonCode,observation,actorId,actorRole,basisReviewVersion,basisDocumentRevision,evidenceSnapshot,idempotencyKey,requestHash)
        OUTPUT INSERTED.* VALUES (@id,@sequence,@outcome,@reason,@observation,@actor,@role,@basisReview,@basisDocument,@evidence,@key,@requestHash)`);
    await transaction.commit();
    return { reviewVersion: request.expectedReviewVersion + 1, decision: decisionFromRow(inserted.recordset[0]) };
  } catch (error) {
    try { await transaction.rollback(); } catch { /* XACT_ABORT may have rolled back. */ }
    if (documentId !== undefined && !(error instanceof InvalidFiscalInput) && !(error instanceof NotFoundError)) {
      const replay = await readExistingDecision(pool, documentId, idempotencyKey, actor, requestHash);
      if (replay) return replay;
    }
    throw error;
  }
}

const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;

export async function listDocuments(pool: SqlPool, filters: { from?: string; to?: string; decision?: string; query?: string; cursor?: { createdAt: string; accessKey: string }; limit: number }) {
  const result = await pool.request()
    .input('from', sql.DateTimeOffset, filters.from ? new Date(filters.from) : null)
    .input('to', sql.DateTimeOffset, filters.to ? new Date(filters.to) : null)
    .input('decision', sql.VarChar(18), filters.decision ?? null)
    .input('search', sql.NVarChar(44), filters.query ?? null)
    .input('cursorDate', sql.DateTimeOffset, filters.cursor ? new Date(filters.cursor.createdAt) : null)
    .input('cursorKey', sql.Char(44), filters.cursor?.accessKey ?? null)
    .input('limit', sql.Int, filters.limit + 1)
    .query(`SELECT TOP (@limit) d.*, CONVERT(varchar(16),d.totalAmount) AS amount, latest.outcome AS currentOutcome,
      latest.basisDocumentRevision, latest.id AS currentDecisionId, latest.sequence AS currentDecisionSequence,
      latest.reasonCode AS currentDecisionReason, latest.observation AS currentDecisionObservation,
      latest.actorId AS currentDecisionActor, latest.actorRole AS currentDecisionRole,
      latest.decidedAt AS currentDecisionAt, latest.basisReviewVersion AS currentDecisionBasisReview,
      latest.evidenceSnapshot AS currentDecisionEvidence
      FROM contei.DocumentoEntrada d
      OUTER APPLY (SELECT TOP (1) id,sequence,outcome,reasonCode,observation,actorId,actorRole,decidedAt,basisReviewVersion,basisDocumentRevision,evidenceSnapshot FROM contei.DecisaoTriagem WHERE documentoId=d.id ORDER BY sequence DESC) latest
      WHERE d.empresaId=1 AND d.scope='IN'
        AND (@from IS NULL OR d.qiveCreatedAt>=@from) AND (@to IS NULL OR d.qiveCreatedAt<@to)
        AND (@search IS NULL OR d.accessKey=@search OR d.number=@search)
        AND (@decision IS NULL OR (@decision='UNDECIDED' AND latest.id IS NULL) OR latest.outcome=@decision)
        AND (@cursorDate IS NULL OR d.qiveCreatedAt>@cursorDate OR (d.qiveCreatedAt=@cursorDate AND d.accessKey>@cursorKey))
      ORDER BY d.qiveCreatedAt,d.accessKey`);
  const rows = result.recordset.slice(0, filters.limit);
  return { items: rows.map(summaryFromRow), nextCursor: result.recordset.length > filters.limit && rows.length ? { createdAt: iso(rows.at(-1).qiveCreatedAt)!, accessKey: String(rows.at(-1).accessKey) } : null };
}

function summaryFromRow(row: Record<string, any>) {
  const decided = row.currentDecisionId !== null && row.currentDecisionId !== undefined;
  return {
    accessKey: String(row.accessKey), number: row.number ?? null,
    emitterName: row.emitterName ?? null, emitterCnpj: row.emitterCnpj ?? null,
    receiverName: row.receiverName ?? null, receiverCnpj: row.receiverCnpj ?? null,
    totalAmount: row.amount ?? null, issuedAt: iso(row.issuedAt), qiveCreatedAt: iso(row.qiveCreatedAt),
    origin: row.origin ?? null, qiveStatus: row.qiveStatusRaw ?? null,
    captureState: row.captureState === 'XML_VERIFIED' ? 'XML_VERIFIED' : row.canceled ? 'CANCELED_XML_UNAVAILABLE' : row.captureState === 'TECHNICAL_BLOCKED' ? 'TECHNICAL_FOLLOWUP' : 'AWAITING_XML',
    triageState: !row.triageEnteredAt ? 'NOT_ELIGIBLE' : decided ? 'DECIDED' : 'AWAITING_TRIAGE',
    canceled: !!row.canceled, reviewVersion: Number(row.reviewVersion), documentRevision: Number(row.documentRevision),
    hasDocumentUpdate: Number(row.documentRevision) > 1,
    hasDocumentUpdateAfterDecision: decided && Number(row.documentRevision) > Number(row.basisDocumentRevision),
    technicalIssueActive: false,
    currentDecision: decided && row.currentDecisionEvidence ? decisionFromRow({
      id: row.currentDecisionId, sequence: row.currentDecisionSequence, outcome: row.currentOutcome,
      reasonCode: row.currentDecisionReason, observation: row.currentDecisionObservation,
      actorId: row.currentDecisionActor, actorRole: row.currentDecisionRole, decidedAt: row.currentDecisionAt,
      basisReviewVersion: row.currentDecisionBasisReview, basisDocumentRevision: row.basisDocumentRevision,
      evidenceSnapshot: row.currentDecisionEvidence,
    }) : null as ReturnType<typeof decisionFromRow> | null,
  };
}

export async function getDocumentDetail(pool: SqlPool, accessKey: string) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let row: Record<string, any>;
  let occurrences: sql.IResult<any>;
  let decisions: sql.IResult<any>;
  try {
    const selected = await new sql.Request(transaction).input('key', sql.Char(44), accessKey).query(`SELECT d.*, CONVERT(varchar(16),d.totalAmount) AS amount, e.cnpj AS companyCnpj
      FROM contei.DocumentoEntrada d JOIN contei.EmpresaFiscal e ON e.id=d.empresaId
      WHERE d.empresaId=1 AND d.scope='IN' AND d.accessKey=@key`);
    if (!selected.recordset.length) throw new NotFoundError('NF-e não encontrada');
    row = selected.recordset[0];
    occurrences = await new sql.Request(transaction).input('id', sql.BigInt, row.id).query(`SELECT id,kind,sourceSection,sourceName,eventType,eventAt,observedAt,origin,sha256,isValidXml,validationErrorCode
      FROM contei.OcorrenciaDocumental WHERE documentoId=@id ORDER BY observedAt,id`);
    decisions = await new sql.Request(transaction).input('id', sql.BigInt, row.id).query('SELECT * FROM contei.DecisaoTriagem WHERE documentoId=@id ORDER BY sequence');
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch { /* Transaction already ended. */ }
    throw error;
  }
  const current = decisions.recordset.at(-1);
  const latestXml = occurrences.recordset.filter((occurrence) => occurrence.kind === 'XML' && occurrence.isValidXml).at(-1);
  const summary = summaryFromRow({ ...row, currentDecisionId: current?.id ?? null, basisDocumentRevision: current?.basisDocumentRevision ?? null });
  summary.currentDecision = current ? decisionFromRow(current) : null;
  const companyCnpj = String(row.companyCnpj);
  const evidence = {
    companyCnpj, receiverCnpj: row.receiverCnpj ?? null,
    recipientCnpjMismatch: row.receiverCnpj ? row.receiverCnpj !== companyCnpj : null,
    canceled: !!row.canceled, documentRevision: Number(row.documentRevision),
    xmlSha256: latestXml?.sha256?.toString('hex') ?? null,
    xmlOccurrenceId: latestXml ? String(latestXml.id) : null,
    qiveStatus: row.qiveStatusRaw ?? null, origin: row.origin ?? null,
    consideredOccurrenceIds: occurrences.recordset.map((occurrence) => String(occurrence.id)),
    consideredOccurrences: occurrences.recordset.map((occurrence) => ({ id: String(occurrence.id), kind: occurrence.kind, sourceSection: occurrence.sourceSection, sha256: occurrence.sha256.toString('hex') })),
  };
  const base = `/api/v1/triagem/nfe/${accessKey}`;
  const occurrenceList = occurrences.recordset.map((occurrence) => ({
    id: String(occurrence.id), kind: occurrence.kind, eventType: occurrence.eventType ?? null,
    eventAt: iso(occurrence.eventAt), observedAt: iso(occurrence.observedAt)!, source: occurrence.sourceName,
    sourceSection: occurrence.sourceSection, origin: occurrence.origin ?? null, qiveStatus: null,
    sha256: occurrence.sha256.toString('hex'),
    contentPath: occurrence.kind === 'EVENT' ? `${base}/events/${occurrence.id}/content` : null,
    xmlValid: occurrence.isValidXml === null ? null : !!occurrence.isValidXml,
  }));
  return {
    ...summary, evidence,
    recommendation: row.triageEnteredAt ? recommend(String(row.receiverCnpj), companyCnpj, !!row.canceled) : null,
    occurrences: occurrenceList,
    decisions: decisions.recordset.map(decisionFromRow),
    xmlVersions: occurrenceList.filter((occurrence) => occurrence.kind === 'XML' && occurrence.xmlValid).map((occurrence) => ({ occurrenceId: occurrence.id, observedAt: occurrence.observedAt, sha256: occurrence.sha256, downloadPath: `${base}/xml/${occurrence.id}`, isOriginal: Number(occurrence.id) === Number(row.firstXmlOccurrenceId) })),
  };
}

export async function getOccurrenceContent(pool: SqlPool, accessKey: string, occurrenceId: string, kind: 'XML' | 'EVENT') {
  const selected = await pool.request().input('key', sql.Char(44), accessKey).input('id', sql.BigInt, occurrenceId).input('kind', sql.VarChar(8), kind)
    .query(`SELECT o.rawPayload,o.sha256 FROM contei.OcorrenciaDocumental o
      JOIN contei.DocumentoEntrada d ON d.id=o.documentoId
      WHERE d.empresaId=1 AND d.scope='IN' AND d.accessKey=@key AND o.id=@id AND o.kind=@kind
        AND (@kind='EVENT' OR o.isValidXml=1)`);
  if (!selected.recordset.length) throw new NotFoundError('Ocorrência não encontrada');
  return { bytes: selected.recordset[0].rawPayload as Buffer, sha256: selected.recordset[0].sha256.toString('hex') as string };
}

export async function getDocumentItems(pool: SqlPool, accessKey: string, selectedOccurrenceId?: string) {
  const document = await pool.request().input('key', sql.Char(44), accessKey)
    .query("SELECT id,captureState,canceled FROM contei.DocumentoEntrada WHERE empresaId=1 AND scope='IN' AND accessKey=@key");
  if (!document.recordset.length) throw new NotFoundError('NF-e não encontrada');
  const note = document.recordset[0];
  const source = await selectXmlVersion(pool.request(), Number(note.id), selectedOccurrenceId ?? null);
  if (!source.recordset.length) {
    if (selectedOccurrenceId) throw new NotFoundError('XML não encontrado');
    const status = note.canceled ? 'CANCELED_XML_UNAVAILABLE' : note.captureState === 'TECHNICAL_BLOCKED' ? 'TECHNICAL_FOLLOWUP' : 'AWAITING_XML';
    return { status, accessKey };
  }
  const xml = source.recordset[0];
  const xmlOccurrenceId = String(xml.id);
  const xmlVersion = { occurrenceId: xmlOccurrenceId, observedAt: iso(xml.observedAt)!, sha256: (xml.sha256 as Buffer).toString('hex'),
    downloadPath: `/api/v1/triagem/nfe/${accessKey}/xml/${xmlOccurrenceId}` };
  const stored = await pool.request().input('id', sql.BigInt, xmlOccurrenceId)
    .query('SELECT itemsJson FROM contei.ItensNfeExtraidos WHERE xmlOccurrenceId=@id');
  if (stored.recordset.length) return { status: 'AVAILABLE', accessKey, xmlVersion, items: storedItems(stored.recordset[0].itemsJson) };
  const payload = await pool.request().input('id', sql.BigInt, xmlOccurrenceId)
    .query('SELECT rawPayload,sha256 FROM contei.OcorrenciaDocumental WHERE id=@id');
  if (!payload.recordset.length || !digest(payload.recordset[0].rawPayload).equals(payload.recordset[0].sha256)) throw new Error('XML_INTEGRITY_FAILURE');
  let items: DeclaredItem[];
  try { items = extractDeclaredItems(payload.recordset[0].rawPayload); }
  catch (error) {
    if (!(error instanceof ItemExtractionError)) throw error;
    await recordItemExtractionFailure(pool, Number(note.id), xmlOccurrenceId, error.code);
    return { status: 'EXTRACTION_FAILED', accessKey, xmlVersion, errorCode: error.code };
  }
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await new sql.Request(transaction).query('SET XACT_ABORT ON');
    const winner = await new sql.Request(transaction).input('id', sql.BigInt, xmlOccurrenceId)
      .query('SELECT itemsJson FROM contei.ItensNfeExtraidos WITH (UPDLOCK,HOLDLOCK) WHERE xmlOccurrenceId=@id');
    let result: DeclaredItem[];
    if (winner.recordset.length) result = storedItems(winner.recordset[0].itemsJson);
    else {
      await new sql.Request(transaction).input('id', sql.BigInt, xmlOccurrenceId).input('items', sql.NVarChar(sql.MAX), JSON.stringify(items))
        .query('INSERT INTO contei.ItensNfeExtraidos (xmlOccurrenceId,itemsJson,extractedAt) VALUES (@id,@items,TODATETIMEOFFSET(SYSUTCDATETIME(), \'+00:00\'))');
      result = items;
    }
    await new sql.Request(transaction).input('id', sql.BigInt, xmlOccurrenceId)
      .query("UPDATE contei.FalhaIntegracao SET state='RESOLVED',resolvedAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),lastAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00') WHERE xmlOccurrenceId=@id AND kind='ITEM_EXTRACTION' AND state='OPEN'");
    await transaction.commit();
    return { status: 'AVAILABLE', accessKey, xmlVersion, items: result };
  } catch (error) {
    try { await transaction.rollback(); } catch { /* XACT_ABORT may already have rolled back. */ }
    throw error;
  }
}

async function recordItemExtractionFailure(pool: SqlPool, documentId: number, xmlOccurrenceId: string, code: ItemErrorCode) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await new sql.Request(transaction).query('SET XACT_ABORT ON');
    const source = await new sql.Request(transaction).input('documentId', sql.BigInt, documentId).input('id', sql.BigInt, xmlOccurrenceId)
      .query("SELECT id FROM contei.OcorrenciaDocumental WHERE id=@id AND documentoId=@documentId AND kind='XML' AND isValidXml=1");
    if (!source.recordset.length) throw new NotFoundError('XML não encontrado');
    const open = await new sql.Request(transaction).input('id', sql.BigInt, xmlOccurrenceId)
      .query("SELECT id FROM contei.FalhaIntegracao WITH (UPDLOCK,HOLDLOCK) WHERE xmlOccurrenceId=@id AND kind='ITEM_EXTRACTION' AND state='OPEN'");
    if (open.recordset.length) {
      await new sql.Request(transaction).input('id', sql.BigInt, open.recordset[0].id).input('code', sql.NVarChar(500), code)
        .query("UPDATE contei.FalhaIntegracao SET lastAt=TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),attempts=attempts+1,safeDetail=@code WHERE id=@id");
    } else {
      await new sql.Request(transaction).input('documentId', sql.BigInt, documentId).input('id', sql.BigInt, xmlOccurrenceId).input('code', sql.NVarChar(500), code)
        .query("INSERT INTO contei.FalhaIntegracao (documentoId,kind,xmlOccurrenceId,firstAt,lastAt,attempts,state,safeDetail) VALUES (@documentId,'ITEM_EXTRACTION',@id,TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),1,'OPEN',@code)");
    }
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch { /* XACT_ABORT may already have rolled back. */ }
    throw error;
  }
}

function storedItems(value: string): DeclaredItem[] {
  const items: unknown = JSON.parse(value);
  if (!Array.isArray(items) || !items.length) throw new Error('ITEM_STORAGE_INTEGRITY_FAILURE');
  return items as DeclaredItem[];
}
