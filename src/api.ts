import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { KeyObject } from 'node:crypto';
import { jwtVerify } from 'jose';
import { ConflictError, getDocumentDetail, getDocumentItems, getOccurrenceContent, listDocuments, NotFoundError, recordDecision, type SqlPool } from './db.ts';
import { InvalidFiscalInput } from './triagem.ts';

export type ApiConfig = {
  issuer: string;
  audience: string;
  algorithm: string;
  key: Uint8Array | KeyObject | CryptoKey;
  permissionClaim: string;
  fiscalPermission: string;
  maxDecisionBytes: number;
  defaultPageLimit: number;
  maxPageLimit: number;
  iatToleranceSeconds: number;
};

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function authorize(request: IncomingMessage, config: ApiConfig) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw { status: 401, code: 'UNAUTHORIZED', message: 'Credencial ausente ou inválida' };
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(authorization.slice(7), config.key, {
      issuer: config.issuer, audience: config.audience, algorithms: [config.algorithm], requiredClaims: ['sub', 'iat', 'exp'],
    });
    claims = verified.payload as Record<string, unknown>;
    // exp segue estrito no jose; iat aceita a tolerância configurada para diferença de relógio com o Halley e iat fracionário.
    if (typeof claims.sub !== 'string' || !claims.sub.trim() || typeof claims.iat !== 'number' || claims.iat > Math.floor(Date.now() / 1000) + config.iatToleranceSeconds) throw new Error('claims inválidas');
  } catch { throw { status: 401, code: 'UNAUTHORIZED', message: 'Credencial ausente ou inválida' }; }
  if (claims[config.permissionClaim] !== config.fiscalPermission) throw { status: 403, code: 'FORBIDDEN', message: 'Permissão fiscal ausente' };
  return { id: claims.sub as string, role: config.fiscalPermission };
}

async function bodyJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new InvalidFiscalInput('INVALID_BODY_SIZE', 'Corpo da decisão excede o limite configurado');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InvalidFiscalInput('INVALID_JSON', 'JSON inválido'); }
}

function date(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InvalidFiscalInput('INVALID_FILTER', 'Data de filtro inválida');
  return new Date(value).toISOString();
}

function cursor(value: string | null): { createdAt: string; accessKey: string } | undefined {
  if (!value) return undefined;
  try {
    const result = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt)) || !/^\d{44}$/.test(result.accessKey)) throw new Error('cursor');
    return result;
  } catch { throw new InvalidFiscalInput('INVALID_CURSOR', 'Cursor inválido'); }
}

export function createApi(pool: SqlPool, config: ApiConfig) {
  if (!config.issuer || !config.audience || !config.algorithm || !config.permissionClaim || !config.fiscalPermission ||
      !Number.isSafeInteger(config.maxDecisionBytes) || config.maxDecisionBytes < 1 ||
      !Number.isSafeInteger(config.defaultPageLimit) || config.defaultPageLimit < 1 ||
      !Number.isSafeInteger(config.maxPageLimit) || config.maxPageLimit < config.defaultPageLimit ||
      !Number.isSafeInteger(config.iatToleranceSeconds) || config.iatToleranceSeconds < 1) throw new Error('Configuração API incompleta');
  return createServer(async (request, response) => {
    try {
      const actor = await authorize(request, config);
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/v1/triagem/nfe') {
        const limitText = url.searchParams.get('limit');
        const limit = limitText === null ? config.defaultPageLimit : Number(limitText);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.maxPageLimit) throw new InvalidFiscalInput('INVALID_FILTER', 'Limite de página inválido');
        const decision = url.searchParams.get('decision') || undefined;
        if (decision && !['UNDECIDED', 'NO_ACTION', 'TREATMENT_PENDING'].includes(decision)) throw new InvalidFiscalInput('INVALID_FILTER', 'Filtro de decisão inválido');
        const from = date(url.searchParams.get('from'));
        const to = date(url.searchParams.get('to'));
        if (from && to && from >= to) throw new InvalidFiscalInput('INVALID_FILTER', 'Período inválido');
        const page = await listDocuments(pool, { from, to, decision, query: url.searchParams.get('query') || undefined, cursor: cursor(url.searchParams.get('cursor')), limit });
        json(response, 200, { items: page.items, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null });
        return;
      }
      const match = /^\/api\/v1\/triagem\/nfe\/(\d{44})(?:\/(.*))?$/.exec(url.pathname);
      if (!match) { json(response, 404, { code: 'NOT_FOUND', message: 'Rota não encontrada' }); return; }
      const [, accessKey, suffix] = match;
      if (request.method === 'GET' && !suffix) { json(response, 200, await getDocumentDetail(pool, accessKey)); return; }
      if (request.method === 'GET' && suffix === 'items') {
        const versions = url.searchParams.getAll('xmlOccurrenceId');
        if (versions.length > 1 || versions.length === 1 && (!/^[1-9][0-9]*$/.test(versions[0]) || BigInt(versions[0]) > 9223372036854775807n)) {
          throw new InvalidFiscalInput('INVALID_FILTER', 'Versão XML inválida');
        }
        const result = await getDocumentItems(pool, accessKey, versions[0]);
        if ('errorCode' in result && result.xmlVersion) console.warn(JSON.stringify({ event: 'ITEM_EXTRACTION_FAILED', xmlOccurrenceId: result.xmlVersion.occurrenceId, errorCode: result.errorCode }));
        json(response, 200, result);
        return;
      }
      const xmlMatch = /^xml\/(\d+)$/.exec(suffix || '');
      const eventMatch = /^events\/(\d+)\/content$/.exec(suffix || '');
      if (request.method === 'GET' && (xmlMatch || eventMatch)) {
        const content = await getOccurrenceContent(pool, accessKey, (xmlMatch || eventMatch)![1], xmlMatch ? 'XML' : 'EVENT');
        response.writeHead(200, { 'Content-Type': xmlMatch ? 'application/xml' : 'application/json', ETag: `"${content.sha256}"`, 'Cache-Control': 'no-store' });
        response.end(content.bytes);
        return;
      }
      if (request.method === 'POST' && suffix === 'decisions') {
        const idempotencyKey = request.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string') throw new InvalidFiscalInput('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key obrigatória');
        json(response, 201, await recordDecision(pool, accessKey, actor, idempotencyKey, await bodyJson(request, config.maxDecisionBytes)));
        return;
      }
      json(response, 404, { code: 'NOT_FOUND', message: 'Rota não encontrada' });
    } catch (error) {
      if (error instanceof ConflictError) { json(response, 409, { code: 'CONFLICT', message: error.message, currentReviewVersion: error.currentReviewVersion }); return; }
      if (error instanceof NotFoundError) { json(response, 404, { code: 'NOT_FOUND', message: error.message }); return; }
      if (error instanceof InvalidFiscalInput) { json(response, ['INVALID_REASON', 'OBSERVATION_REQUIRED', 'NOT_TRIAGEABLE'].includes(error.code) ? 422 : 400, { code: error.code, message: error.message }); return; }
      if (error && typeof error === 'object' && 'status' in error) { const problem = error as { status: number; code: string; message: string }; json(response, problem.status, { code: problem.code, message: problem.message }); return; }
      json(response, 500, { code: 'INTERNAL_ERROR', message: 'Falha interna' });
    }
  });
}
