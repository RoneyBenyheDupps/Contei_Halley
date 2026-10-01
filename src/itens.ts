import { SaxesParser } from 'saxes';
import { decodeXml } from './triagem.ts';

export type ItemErrorCode = 'XML_STRUCTURE_UNSUPPORTED' | 'ITEM_STRUCTURE_INCOMPLETE' | 'TAX_MAPPING_UNSUPPORTED';
export class ItemExtractionError extends Error {
  readonly code: ItemErrorCode;
  constructor(code: ItemErrorCode) { super(code); this.code = code; }
}

export type DeclaredTax = { variant: string; fields: Record<string, string> };
export type DeclaredItem = {
  nItem: number;
  product: Record<string, string>;
  taxes?: Partial<Record<'ICMS' | 'IPI' | 'PIS' | 'COFINS', DeclaredTax>>;
};

const namespace = 'http://www.portalfiscal.inf.br/nfe';
const itemPath = 'nfeProc/NFe/infNFe/det';
const productFields = new Set('cProd xProd NCM CFOP CEST cEAN cEANTrib uCom qCom vUnCom vProd uTrib qTrib vUnTrib vFrete vSeg vDesc vOutro'.split(' '));
const taxVariants: Record<string, Set<string>> = {
  ICMS: new Set('ICMS00 ICMS02 ICMS10 ICMS15 ICMS20 ICMS30 ICMS40 ICMS51 ICMS53 ICMS60 ICMS61 ICMS70 ICMS90 ICMSPart ICMSST ICMSSN101 ICMSSN102 ICMSSN201 ICMSSN202 ICMSSN500 ICMSSN900'.split(' ')),
  IPI: new Set('IPITrib IPINT'.split(' ')),
  PIS: new Set('PISAliq PISQtde PISNT PISOutr'.split(' ')),
  COFINS: new Set('COFINSAliq COFINSQtde COFINSNT COFINSOutr'.split(' ')),
};
// Campos reconhecidos no pacote oficial 010f; auxiliares conhecidos ficam no XML.
const taxFields: Record<string, Set<string>> = {
  ICMS: new Set(`orig CST CSOSN modBC vBC pICMS vICMS pFCP vFCP qBCMono adRemICMS vICMSMono vICMSMonoOp vICMSMonoDif vBCFCP modBCST pMVAST pRedBCST vBCST pICMSST vICMSST vBCFCPST pFCPST vFCPST vICMSSTDeson motDesICMSST qBCMonoReten adRemICMSReten vICMSMonoReten pRedAdRem motRedAdRem pRedBC vICMSDeson motDesICMS indDeduzDeson cBenefRBC vICMSOp pDif vICMSDif pFCPDif vFCPDif vFCPEfet qBCMonoDif adRemICMSDif vBCSTRet pST vICMSSubstituto vICMSSTRet vBCFCPSTRet pFCPSTRet vFCPSTRet pRedBCEfet vBCEfet pICMSEfet vICMSEfet qBCMonoRet adRemICMSRet vICMSMonoRet pBCOp UFST vBCSTDest vICMSSTDest pCredSN vCredICMSSN`.split(' ')),
  IPI: new Set('CST vBC pIPI qUnid vUnid vIPI'.split(' ')),
  PIS: new Set('CST vBC pPIS vPIS qBCProd vAliqProd'.split(' ')),
  COFINS: new Set('CST vBC pCOFINS vCOFINS qBCProd vAliqProd'.split(' ')),
};
const ipiAuxiliary = new Set('CNPJProd cSelo qSelo cEnq'.split(' '));
const projectedTaxField = (field: string) => field === 'CST' || field === 'CSOSN' || /^(?:v|p|q(?:BC|Unid)|adRem)/.test(field);

export function extractDeclaredItems(bytes: Buffer): DeclaredItem[] {
  let content: string;
  try { content = decodeXml(bytes); }
  catch { throw new ItemExtractionError('XML_STRUCTURE_UNSUPPORTED'); }
  const parser = new SaxesParser({ xmlns: true });
  const stack: Array<{ name: string; official: boolean; text: string; children: boolean }> = [];
  const items: DeclaredItem[] = [];
  const numbers = new Set<number>();
  let current: DeclaredItem | null = null;
  let productSeen = false;
  let taxesSeen = false;
  let rootSeen = false;
  let infNfeCount = 0;
  const path = () => stack.map((part) => part.name).join('/');
  const fail = (code: ItemErrorCode): never => { throw new ItemExtractionError(code); };
  parser.on('doctype', () => fail('XML_STRUCTURE_UNSUPPORTED'));
  parser.on('error', () => fail('XML_STRUCTURE_UNSUPPORTED'));
  parser.on('opentag', (tag) => {
    const parent = stack.at(-1);
    if (parent) parent.children = true;
    const official = (parent?.official ?? true) && tag.uri === namespace;
    stack.push({ name: tag.local, official, text: '', children: false });
    const at = path();
    if (stack.length === 1) {
      if (at !== 'nfeProc' || !official) fail('XML_STRUCTURE_UNSUPPORTED');
      rootSeen = true;
    }
    if (at === 'nfeProc/NFe/infNFe' && official) infNfeCount++;
    if (at === itemPath) {
      if (!official) fail('XML_STRUCTURE_UNSUPPORTED');
      const rawNumber = String(tag.attributes.nItem?.value ?? '');
      const nItem = Number(rawNumber);
      if (!/^[1-9][0-9]*$/.test(rawNumber) || nItem > 990 || numbers.has(nItem)) fail('ITEM_STRUCTURE_INCOMPLETE');
      numbers.add(nItem);
      current = { nItem, product: {} };
      productSeen = false;
      taxesSeen = false;
    }
    if (!current) return;
    if (at === `${itemPath}/prod`) {
      if (!official || productSeen) fail('ITEM_STRUCTURE_INCOMPLETE');
      productSeen = true;
    }
    if (at === `${itemPath}/imposto`) {
      if (taxesSeen) fail('ITEM_STRUCTURE_INCOMPLETE');
      taxesSeen = true;
    }
    if (at.startsWith(`${itemPath}/imposto/`)) {
      const parts = at.split('/');
      const group = parts[5];
      if (!Object.hasOwn(taxVariants, group)) return;
      if (!official) fail('TAX_MAPPING_UNSUPPORTED');
      if (parts.length === 6) {
        if (current.taxes?.[group as keyof NonNullable<DeclaredItem['taxes']>]) fail('TAX_MAPPING_UNSUPPORTED');
      } else if (parts.length === 7) {
        if (group === 'IPI' && ipiAuxiliary.has(parts[6])) return;
        if (!taxVariants[group].has(parts[6])) fail('TAX_MAPPING_UNSUPPORTED');
        current.taxes ??= {};
        if (current.taxes[group as keyof NonNullable<DeclaredItem['taxes']>]) fail('TAX_MAPPING_UNSUPPORTED');
        current.taxes[group as keyof NonNullable<DeclaredItem['taxes']>] = { variant: parts[6], fields: {} };
      } else if (parts.length === 8) {
        const field = parts[7];
        if (group === 'IPI' && ipiAuxiliary.has(parts[6])) fail('TAX_MAPPING_UNSUPPORTED');
        if (!taxFields[group].has(field)) fail('TAX_MAPPING_UNSUPPORTED');
      } else if (parts.length > 8) fail('TAX_MAPPING_UNSUPPORTED');
    }
  });
  const append = (value: string) => { const node = stack.at(-1); if (node) node.text += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const at = path();
    const node = stack.at(-1)!;
    if (current && at.startsWith(`${itemPath}/`)) {
      const parts = at.split('/');
      if (parts.length === 6 && parts[4] === 'prod' && productFields.has(parts[5])) {
        if (!node.official || node.children || Object.hasOwn(current.product, parts[5])) fail('ITEM_STRUCTURE_INCOMPLETE');
        current.product[parts[5]] = node.text;
      }
      if (parts.length === 8 && parts[4] === 'imposto' && Object.hasOwn(taxVariants, parts[5])) {
        const group = parts[5] as keyof NonNullable<DeclaredItem['taxes']>;
        const tax = current.taxes?.[group];
        if (!tax || node.children || !node.official) throw new ItemExtractionError('TAX_MAPPING_UNSUPPORTED');
        if (projectedTaxField(parts[7])) {
          if (Object.hasOwn(tax.fields, parts[7])) fail('TAX_MAPPING_UNSUPPORTED');
          tax.fields[parts[7]] = node.text;
        }
      }
      if (parts.length === 6 && parts[4] === 'imposto' && Object.hasOwn(taxVariants, parts[5]) && !current.taxes?.[parts[5] as keyof NonNullable<DeclaredItem['taxes']>]) fail('TAX_MAPPING_UNSUPPORTED');
      if (parts.length === 7 && parts[4] === 'imposto' && Object.hasOwn(taxVariants, parts[5]) && taxVariants[parts[5]].has(parts[6])) {
        const tax = current.taxes?.[parts[5] as keyof NonNullable<DeclaredItem['taxes']>];
        if (!tax?.fields[parts[6].startsWith('ICMSSN') ? 'CSOSN' : 'CST']) fail('TAX_MAPPING_UNSUPPORTED');
      }
    }
    if (at === itemPath) {
      if (!current || !productSeen) throw new ItemExtractionError('ITEM_STRUCTURE_INCOMPLETE');
      if (current.taxes && !Object.keys(current.taxes).length) delete current.taxes;
      items.push(current);
      current = null;
    }
    stack.pop();
  });
  try { parser.write(content).close(); }
  catch (error) {
    if (error instanceof ItemExtractionError) throw error;
    throw new ItemExtractionError('XML_STRUCTURE_UNSUPPORTED');
  }
  if (!rootSeen || infNfeCount !== 1) fail('XML_STRUCTURE_UNSUPPORTED');
  if (!items.length) fail('ITEM_STRUCTURE_INCOMPLETE');
  return items;
}
