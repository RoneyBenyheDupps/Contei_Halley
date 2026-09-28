import type { QiveConfig } from './qive.ts';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Configuração obrigatória ausente: ${name}`);
  return value;
}

export function positive(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Configuração inválida: ${name}`);
  return value;
}

export function oneOf<T extends string>(name: string, values: readonly T[]): T {
  const value = required(name);
  if (!values.includes(value as T)) throw new Error(`Configuração inválida: ${name}`);
  return value as T;
}

export function readQiveConfig(cnpj: string): QiveConfig {
  return {
    baseUrl: required('QIVE_BASE_URL'), apiId: required('QIVE_API_ID'), apiKey: required('QIVE_API_KEY'),
    cnpj, receivedRole: required('QIVE_RECEIVED_ROLE'), pageLimit: positive('QIVE_PAGE_LIMIT'),
    emissionFrom: required('QIVE_EMISSION_FROM'),
    fieldsKey: oneOf('QIVE_FIELDS_KEY', ['Fields', 'fields'] as const),
    paginatorKey: oneOf('QIVE_PAGINATOR_KEY', ['Paginator', 'paginator'] as const),
    xmlEncoding: oneOf('QIVE_XML_ENCODING', ['raw', 'base64'] as const),
    eventXmlEncoding: oneOf('QIVE_EVENT_XML_ENCODING', ['raw', 'base64'] as const),
    timeoutMs: positive('QIVE_TIMEOUT_MS'),
    maxResponseBytes: positive('QIVE_MAX_RESPONSE_BYTES'), maxXmlBytes: positive('QIVE_MAX_XML_BYTES'),
  };
}
