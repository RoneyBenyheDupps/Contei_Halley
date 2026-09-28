import { SaxesParser } from 'saxes';

export type Outcome = 'NO_ACTION' | 'TREATMENT_PENDING';
export type DecisionRequest = {
  expectedReviewVersion: number;
  outcome: Outcome;
  reasonCode: string;
  observation?: string;
};

export type XmlEvidence = {
  accessKey: string;
  number: string;
  issuedAt: string;
  emitterCnpj: string;
  emitterName: string;
  receiverCnpj: string;
  receiverName: string;
  totalAmount: string;
  protocol: string;
};

export class InvalidFiscalInput extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function mod11Digit(value: string): number {
  let sum = 0;
  for (let i = value.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(value[i]) * weight;
  const digit = 11 - sum % 11;
  return digit >= 10 ? 0 : digit;
}

export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  return mod11Digit(value.slice(0, 12)) === Number(value[12]) && mod11Digit(value.slice(0, 13)) === Number(value[13]);
}

export function isValidAccessKey(value: string): boolean {
  if (!/^\d{44}$/.test(value)) return false;
  return Number(value[43]) === mod11Digit(value.slice(0, 43));
}

export function inspectXml(bytes: Buffer, expectedKey: string): XmlEvidence {
  if (!isValidAccessKey(expectedKey)) throw new InvalidFiscalInput('INVALID_ACCESS_KEY', 'Chave de acesso inválida');
  const declaration = bytes.subarray(0, 200).toString('ascii');
  const encoding = /<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1] || 'utf-8';
  let content: string;
  try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new InvalidFiscalInput('INVALID_XML_ENCODING', 'Codificação XML inválida'); }
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  const fiscalNamespace: boolean[] = [];
  const fields = new Map<string, string>();
  let infNfeId: string | undefined;
  let infNfeCount = 0;
  let protocolCount = 0;
  parser.on('doctype', () => { throw new InvalidFiscalInput('DOCTYPE_FORBIDDEN', 'DOCTYPE não permitido'); });
  parser.on('error', () => { throw new InvalidFiscalInput('MALFORMED_XML', 'XML malformado'); });
  parser.on('opentag', (tag) => {
    stack.push(tag.local);
    fiscalNamespace.push((fiscalNamespace.at(-1) ?? true) && tag.uri === 'http://www.portalfiscal.inf.br/nfe');
    const path = stack.join('/');
    if (path === 'nfeProc/NFe/infNFe' && fiscalNamespace.at(-1)) { infNfeCount++; infNfeId = String(tag.attributes.Id?.value || ''); }
    if (path === 'nfeProc/protNFe/infProt' && fiscalNamespace.at(-1)) protocolCount++;
  });
  const append = (value: string) => {
    if (!fiscalNamespace.at(-1)) return;
    const path = stack.join('/');
    fields.set(path, (fields.get(path) || '') + value);
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop(); fiscalNamespace.pop(); });
  try { parser.write(content).close(); }
  catch (error) {
    if (error instanceof InvalidFiscalInput) throw error;
    throw new InvalidFiscalInput('MALFORMED_XML', 'XML malformado');
  }
  const get = (path: string) => fields.get(`nfeProc/${path}`)?.trim() || '';
  if (infNfeCount !== 1 || protocolCount !== 1 || infNfeId !== `NFe${expectedKey}` || get('protNFe/infProt/chNFe') !== expectedKey || !get('protNFe/infProt/nProt')) {
    throw new InvalidFiscalInput('INCOHERENT_PROTOCOL', 'Chave ou protocolo incoerente');
  }
  const receiverCnpj = get('NFe/infNFe/dest/CNPJ');
  const emitterCnpj = get('NFe/infNFe/emit/CNPJ');
  if (!isValidCnpj(receiverCnpj) || !isValidCnpj(emitterCnpj)) throw new InvalidFiscalInput('INVALID_CNPJ', 'CNPJ do XML inválido');
  const amount = get('NFe/infNFe/total/ICMSTot/vNF');
  if (!/^\d{1,13}\.\d{2}$/.test(amount)) throw new InvalidFiscalInput('INVALID_AMOUNT', 'vNF inválido');
  const issued = get('NFe/infNFe/ide/dhEmi') || get('NFe/infNFe/ide/dEmi');
  const issuedAt = new Date(issued);
  const number = get('NFe/infNFe/ide/nNF');
  const emitterName = get('NFe/infNFe/emit/xNome');
  const receiverName = get('NFe/infNFe/dest/xNome');
  if (!number || !emitterName || !receiverName || Number.isNaN(issuedAt.getTime())) throw new InvalidFiscalInput('MISSING_XML_DATA', 'Dados mínimos da NF-e ausentes');
  return { accessKey: expectedKey, number, issuedAt: issuedAt.toISOString(), emitterCnpj, emitterName, receiverCnpj, receiverName, totalAmount: amount, protocol: get('protNFe/infProt/nProt') };
}

export function recommend(receiverCnpj: string, companyCnpj: string, canceled: boolean): { outcome: Outcome; reasonCode: string } | null {
  if (receiverCnpj !== companyCnpj) return { outcome: 'TREATMENT_PENDING', reasonCode: 'RECIPIENT_CNPJ_MISMATCH' };
  if (canceled) return null;
  return { outcome: 'NO_ACTION', reasonCode: 'NO_RELEVANT_DIVERGENCE' };
}

export function validateDecision(value: unknown): DecisionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidFiscalInput('INVALID_DECISION', 'Corpo da decisão inválido');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['expectedReviewVersion', 'outcome', 'reasonCode', 'observation'].includes(key)) ||
      !Number.isSafeInteger(data.expectedReviewVersion) || Number(data.expectedReviewVersion) < 0 ||
      typeof data.outcome !== 'string' || typeof data.reasonCode !== 'string' ||
      (data.observation !== undefined && typeof data.observation !== 'string')) {
    throw new InvalidFiscalInput('INVALID_DECISION', 'Corpo da decisão inválido');
  }
  const noAction = ['NO_RELEVANT_DIVERGENCE', 'ACCEPTED_DIVERGENCE_OR_SITUATION'];
  const pending = ['RECIPIENT_CNPJ_MISMATCH', 'CANCELED_NFE', 'OTHER'];
  if (!(data.outcome === 'NO_ACTION' && noAction.includes(data.reasonCode) || data.outcome === 'TREATMENT_PENDING' && pending.includes(data.reasonCode))) {
    throw new InvalidFiscalInput('INVALID_REASON', 'Motivo incompatível com o resultado');
  }
  if (data.reasonCode === 'OTHER' && !String(data.observation || '').trim()) throw new InvalidFiscalInput('OBSERVATION_REQUIRED', 'Observação obrigatória para OTHER');
  return data as DecisionRequest;
}
