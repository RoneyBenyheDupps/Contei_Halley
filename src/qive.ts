import { isLosslessNumber, parse, stringify } from 'lossless-json';
import type { InboundSnapshot } from './db.ts';
import { isValidAccessKey } from './triagem.ts';

const fields = ['Xml', 'Origin', 'FlagErp', 'Document', 'Events', 'Tags', 'Cfops', 'AccessKey', 'EmissionDate', 'CreatedAt', 'HasCCE', 'Manifestations', 'Number', 'Owner', 'OwnerRole', 'Receiver', 'Emitter', 'Status'];

export class QiveError extends Error {
  readonly status?: number;
  readonly retryAfter?: string;
  constructor(message: string, status?: number, retryAfter?: string) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

export type QiveConfig = {
  baseUrl: string;
  apiId: string;
  apiKey: string;
  cnpj: string;
  receivedRole: string;
  pageLimit: number;
  emissionFrom: string;
  fieldsKey: 'Fields' | 'fields';
  paginatorKey: 'Paginator' | 'paginator';
  xmlEncoding: 'raw' | 'base64';
  eventXmlEncoding: 'raw' | 'base64';
  timeoutMs: number;
  maxResponseBytes: number;
  maxXmlBytes: number;
  fetchImpl?: typeof fetch;
};

function canonical(value: unknown): unknown {
  if (isLosslessNumber(value) || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) sorted[key] = canonical((value as Record<string, unknown>)[key]);
  return sorted;
}

function payload(value: unknown): Buffer {
  const json = stringify(canonical(value));
  if (!json) throw new QiveError('Payload Qive incompatível');
  return Buffer.from(json, 'utf8');
}

function decodeXml(value: unknown, encoding: 'raw' | 'base64', maxBytes: number): Buffer | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new QiveError('XML Qive incompatível');
  if (value.length > maxBytes * 4 + 4) throw new QiveError('XML Qive excede limite configurado');
  if (encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new QiveError('Base64 Qive inválido');
  const bytes = Buffer.from(value, encoding === 'raw' ? 'utf8' : 'base64');
  if (bytes.length > maxBytes) throw new QiveError('XML Qive excede limite configurado');
  return bytes;
}

// EmissionDate.To acompanha o fim da consulta: um To fixo esconderia NF-e emitidas depois dele enquanto o checkpoint de CreatedAt avança.
// Dois dias de margem cobrem fuso -03:00, emitente adiantado e To só com data lido como início do dia; CreatedAt/chave já limitam o resultado.
const emissionUntil = (instant: string | number) => new Date(new Date(instant).getTime() + 2 * 86_400_000).toISOString().slice(0, 10);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QiveError('Resposta Qive incompatível');
  return value as Record<string, unknown>;
}

function normalize(value: unknown, config: QiveConfig, discovery: boolean): InboundSnapshot | null {
  const item = asObject(value);
  if (discovery && typeof item.OwnerRole !== 'string') throw new QiveError('Papel Qive ausente');
  if (discovery && item.OwnerRole !== config.receivedRole) return null;
  if (typeof item.AccessKey !== 'string' || !isValidAccessKey(item.AccessKey) || typeof item.CreatedAt !== 'string' || !Number.isFinite(Date.parse(item.CreatedAt)) || typeof item.Status !== 'string') throw new QiveError('NF-e Qive sem campos obrigatórios válidos');
  if (!['authorized', 'canceled'].includes(item.Status)) throw new QiveError('Status Qive desconhecido');
  const events: NonNullable<InboundSnapshot['events']> = [];
  for (const [section, list] of [['EVENTS', item.Events], ['MANIFESTATIONS', item.Manifestations]] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new QiveError('Eventos Qive incompatíveis');
    for (const event of list) {
      const detail = asObject(event);
      events.push({ section, rawPayload: payload(detail), eventType: typeof (detail.type ?? detail.Type) === 'string' ? String(detail.type ?? detail.Type) : undefined,
        eventXmlBytes: section === 'EVENTS' ? decodeXml(detail.xml, config.eventXmlEncoding, config.maxXmlBytes) : undefined });
    }
  }
  return {
    accessKey: item.AccessKey, createdAt: item.CreatedAt, origin: typeof item.Origin === 'string' ? item.Origin : null,
    status: item.Status, canceled: item.Status === 'canceled', rawPayload: payload(item), xmlBytes: decodeXml(item.Xml, config.xmlEncoding, config.maxXmlBytes), events,
  };
}

export function createQiveClient(config: QiveConfig) {
  if (!config.baseUrl.startsWith('https://') || !config.apiId || !config.apiKey || !/^\d{14}$/.test(config.cnpj) || !config.receivedRole || !Number.isSafeInteger(config.pageLimit) || config.pageLimit < 1 || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || !Number.isSafeInteger(config.maxXmlBytes) || config.maxXmlBytes < 1) throw new Error('Configuração Qive incompleta');
  const fetcher = config.fetchImpl ?? fetch;
  async function request(filters: Record<string, unknown>, emissionTo: string, paginator?: string, discovery = true): Promise<{ items: InboundSnapshot[]; nextPaginator: string | null | undefined; failedItems?: number }> {
    const body: Record<string, unknown> = { Filters: { ...filters, EmissionDate: { From: config.emissionFrom, To: emissionTo } }, [config.fieldsKey]: fields, Limit: config.pageLimit };
    if (paginator) body[config.paginatorKey] = paginator;
    let response: Response;
    try {
      response = await fetcher(new URL('/v2/dfe/nfe', config.baseUrl), { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-API-ID': config.apiId, 'X-API-KEY': config.apiKey, 'X-Use-ApiGateway': 'always',
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs) });
    } catch { throw new QiveError('Falha de comunicação Qive'); }
    if (!response.ok) throw new QiveError('Resposta HTTP Qive não aceita', response.status, response.headers.get('Retry-After') ?? undefined);
    let envelope: Record<string, unknown>;
    let responseText = '';
    try {
      const declaredLength = Number(response.headers.get('Content-Length'));
      if (declaredLength > config.maxResponseBytes) throw new QiveError('Resposta Qive excede limite configurado');
      if (!response.body) throw new QiveError('Resposta Qive vazia');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > config.maxResponseBytes) throw new QiveError('Resposta Qive excede limite configurado');
        chunks.push(Buffer.from(chunk));
      }
      responseText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      envelope = asObject(parse(responseText));
    }
    catch (error) { if (error instanceof QiveError) throw error; throw new QiveError('JSON Qive incompatível'); }
    const nextPaginator = envelope.Paginator ?? envelope.paginator;
    if (!Array.isArray(envelope.Nfes) || (nextPaginator !== null && nextPaginator !== undefined && typeof nextPaginator !== 'string')) throw new QiveError('Envelope Qive incompatível');
    const items: InboundSnapshot[] = [];
    let failedItems = 0;
    for (const value of envelope.Nfes) {
      try {
        const item = normalize(value, config, discovery);
        if (item) items.push(item);
      } catch (error) {
        if (!discovery || !(error instanceof QiveError)) throw error;
        failedItems++;
      }
    }
    return { items, nextPaginator: nextPaginator as string | null | undefined, failedItems };
  }
  return {
    listPage: (fromInclusive: string, to: string, paginator?: string) => request({ Owners: [config.cnpj], OwnerRoles: [config.receivedRole], CreatedAt: { From: fromInclusive, To: to } }, emissionUntil(to), paginator, true),
    getKnown: async (accessKey: string) => {
      let paginator: string | undefined;
      const seen = new Set<string>();
      const emissionTo = emissionUntil(Date.now());
      do {
        const page = await request({ Owners: [config.cnpj], DocumentIdentifier: accessKey }, emissionTo, paginator, false);
        const found = page.items.find((item) => item.accessKey === accessKey);
        if (found) return found;
        paginator = page.nextPaginator || undefined;
        if (paginator) {
          if (seen.has(paginator)) throw new QiveError('Paginação Qive repetida');
          seen.add(paginator);
        }
      } while (paginator);
      return null;
    },
  };
}
