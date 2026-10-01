import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDeclaredItems, ItemExtractionError } from '../src/itens.ts';

function xml(items: string) {
  return Buffer.from(`<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe>${items}</infNFe></NFe></nfeProc>`);
}

function det(nItem: number, product: string, taxes = '') {
  return `<det nItem="${nItem}"><prod>${product}</prod><imposto>${taxes}</imposto></det>`;
}

test('extrai todos os itens na ordem do XML com decimais literais e quatro tributos declarados', () => {
  const source = xml(
    det(2, '<cProd>A</cProd><xProd>Produto A</xProd><NCM>12345678</NCM><CFOP>1102</CFOP><CEST>0100100</CEST><cEAN>SEM GTIN</cEAN><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>12.3400000000</vUnCom><vProd>12.34</vProd><vDesc>0.00</vDesc>',
      '<ICMS><ICMS00><CST>00</CST><vBC>12.34</vBC><pICMS>18.0000</pICMS><vICMS>2.22</vICMS></ICMS00></ICMS><IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>12.34</vBC><pIPI>5.00</pIPI><vIPI>0.62</vIPI></IPITrib></IPI><PIS><PISAliq><CST>01</CST><vBC>12.34</vBC><pPIS>1.6500</pPIS><vPIS>0.20</vPIS></PISAliq></PIS><COFINS><COFINSQtde><CST>03</CST><qBCProd>1.0000</qBCProd><vAliqProd>0.2500</vAliqProd><vCOFINS>0.25</vCOFINS></COFINSQtde></COFINS><PISST><vPIS>99.99</vPIS></PISST>') +
    det(1, '<cProd>B</cProd><xProd>Produto B</xProd><uTrib>KG</uTrib><qTrib>0.0000</qTrib><vUnTrib>0.0000000000</vUnTrib><vProd>0.00</vProd>'),
  );
  assert.deepEqual(extractDeclaredItems(source), [
    { nItem: 2, product: { cProd: 'A', xProd: 'Produto A', NCM: '12345678', CFOP: '1102', CEST: '0100100', cEAN: 'SEM GTIN', uCom: 'UN', qCom: '1.0000', vUnCom: '12.3400000000', vProd: '12.34', vDesc: '0.00' }, taxes: {
      ICMS: { variant: 'ICMS00', fields: { CST: '00', vBC: '12.34', pICMS: '18.0000', vICMS: '2.22' } },
      IPI: { variant: 'IPITrib', fields: { CST: '50', vBC: '12.34', pIPI: '5.00', vIPI: '0.62' } },
      PIS: { variant: 'PISAliq', fields: { CST: '01', vBC: '12.34', pPIS: '1.6500', vPIS: '0.20' } },
      COFINS: { variant: 'COFINSQtde', fields: { CST: '03', qBCProd: '1.0000', vAliqProd: '0.2500', vCOFINS: '0.25' } },
    } },
    { nItem: 1, product: { cProd: 'B', xProd: 'Produto B', uTrib: 'KG', qTrib: '0.0000', vUnTrib: '0.0000000000', vProd: '0.00' } },
  ]);
});

test('distingue CST e CSOSN, IPI não tributado e PIS/COFINS por quantidade ou outros', () => {
  const source = xml(det(1, '<cProd>C</cProd><xProd>Produto C</xProd><vProd>1.00</vProd>',
    '<ICMS><ICMSSN101><CSOSN>101</CSOSN><pCredSN>3.00</pCredSN><vCredICMSSN>0.03</vCredICMSSN></ICMSSN101></ICMS><IPI><cEnq>999</cEnq><IPINT><CST>53</CST></IPINT></IPI><PIS><PISOutr><CST>99</CST><qBCProd>1.00</qBCProd><vAliqProd>0.10</vAliqProd><vPIS>0.10</vPIS></PISOutr></PIS><COFINS><COFINSNT><CST>08</CST></COFINSNT></COFINS><COFINSST><vCOFINS>99.99</vCOFINS></COFINSST><ICMSUFDest><vICMSUFDest>99.99</vICMSUFDest></ICMSUFDest>'));
  assert.deepEqual(extractDeclaredItems(source)[0].taxes, {
    ICMS: { variant: 'ICMSSN101', fields: { CSOSN: '101', pCredSN: '3.00', vCredICMSSN: '0.03' } },
    IPI: { variant: 'IPINT', fields: { CST: '53' } },
    PIS: { variant: 'PISOutr', fields: { CST: '99', qBCProd: '1.00', vAliqProd: '0.10', vPIS: '0.10' } },
    COFINS: { variant: 'COFINSNT', fields: { CST: '08' } },
  });
});

test('reconhece as demais variantes de PIS e COFINS sem inferir campos ausentes', () => {
  const product = '<cProd>X</cProd><xProd>Produto</xProd>';
  const source = xml(
    det(1, product, '<PIS><PISQtde><CST>03</CST><qBCProd>2.0000</qBCProd><vAliqProd>0.1000</vAliqProd><vPIS>0.20</vPIS></PISQtde></PIS>') +
    det(2, product, '<PIS><PISNT><CST>08</CST></PISNT></PIS>') +
    det(3, product, '<COFINS><COFINSAliq><CST>01</CST><vBC>10.00</vBC><pCOFINS>7.6000</pCOFINS><vCOFINS>0.76</vCOFINS></COFINSAliq></COFINS>') +
    det(4, product, '<COFINS><COFINSOutr><CST>99</CST><vBC>10.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>'),
  );
  const items = extractDeclaredItems(source);
  assert.deepEqual(items.map((item) => item.nItem), [1, 2, 3, 4]);
  assert.deepEqual(items.map((item) => item.taxes), [
    { PIS: { variant: 'PISQtde', fields: { CST: '03', qBCProd: '2.0000', vAliqProd: '0.1000', vPIS: '0.20' } } },
    { PIS: { variant: 'PISNT', fields: { CST: '08' } } },
    { COFINS: { variant: 'COFINSAliq', fields: { CST: '01', vBC: '10.00', pCOFINS: '7.6000', vCOFINS: '0.76' } } },
    { COFINS: { variant: 'COFINSOutr', fields: { CST: '99', vBC: '10.00', pCOFINS: '0.00', vCOFINS: '0.00' } } },
  ]);
});

test('projeta os valores de operação e diferido do ICMS53 monofásico', () => {
  const source = xml(det(1, '<cProd>M</cProd><xProd>Combustível</xProd>',
    '<ICMS><ICMS53><orig>0</orig><CST>53</CST><qBCMono>100.0000</qBCMono><adRemICMS>1.2345</adRemICMS><vICMSMonoOp>123.45</vICMSMonoOp><pDif>50.0000</pDif><vICMSMonoDif>61.72</vICMSMonoDif><vICMSMono>61.73</vICMSMono></ICMS53></ICMS>'));
  assert.deepEqual(extractDeclaredItems(source)[0].taxes, {
    ICMS: { variant: 'ICMS53', fields: { CST: '53', qBCMono: '100.0000', adRemICMS: '1.2345', vICMSMonoOp: '123.45', pDif: '50.0000', vICMSMonoDif: '61.72', vICMSMono: '61.73' } },
  });
});

test('projeta a quantidade tributada do IPI por unidade junto do valor unitário', () => {
  const source = xml(det(1, '<cProd>U</cProd><xProd>Produto por unidade</xProd>',
    '<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><qUnid>10.0000</qUnid><vUnid>0.5000</vUnid><vIPI>5.00</vIPI></IPITrib></IPI>'));
  assert.deepEqual(extractDeclaredItems(source)[0].taxes, {
    IPI: { variant: 'IPITrib', fields: { CST: '50', qUnid: '10.0000', vUnid: '0.5000', vIPI: '5.00' } },
  });
});

test('rejeita nItem duplicado antes de apresentar uma lista aparentemente completa', () => {
  const product = '<cProd>X</cProd><xProd>Produto</xProd>';
  assert.throws(() => extractDeclaredItems(xml(det(1, product) + det(1, product))),
    (error: unknown) => error instanceof ItemExtractionError && error.code === 'ITEM_STRUCTURE_INCOMPLETE');
});

test('rejeita segundo grupo imposto no mesmo item sem devolver os itens válidos da versão', () => {
  const product = '<cProd>X</cProd><xProd>Produto</xProd>';
  const icms = '<imposto><ICMS><ICMS00><CST>00</CST><vBC>1.00</vBC><pICMS>18.00</pICMS><vICMS>0.18</vICMS></ICMS00></ICMS></imposto>';
  for (const repeated of ['<imposto><IPI><cEnq>999</cEnq><IPINT><CST>53</CST></IPINT></IPI></imposto>', '<imposto/>']) {
    assert.throws(() => extractDeclaredItems(xml(det(1, product) + `<det nItem="2"><prod>${product}</prod>${icms}${repeated}</det>`)),
      (error: unknown) => error instanceof ItemExtractionError && error.code === 'ITEM_STRUCTURE_INCOMPLETE');
  }
});

test('não confunde estrutura ausente com lista válida de itens', () => {
  assert.throws(() => extractDeclaredItems(xml('')), (error: unknown) => error instanceof ItemExtractionError && error.code === 'ITEM_STRUCTURE_INCOMPLETE');
});

test('classifica estrutura XML, item incompleto e mapeamento tributário sem expor conteúdo', () => {
  const product = '<cProd>X</cProd><xProd>Produto</xProd>';
  const cases: Array<[Buffer, ItemExtractionError['code']]> = [
    [Buffer.from(xml(det(1, product)).toString().replace('<nfeProc', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///private">]><nfeProc')), 'XML_STRUCTURE_UNSUPPORTED'],
    [xml(det(1, product)).subarray(0, -12), 'XML_STRUCTURE_UNSUPPORTED'],
    [Buffer.from(xml(det(1, product)).toString().replace('http://www.portalfiscal.inf.br/nfe', 'urn:foreign')), 'XML_STRUCTURE_UNSUPPORTED'],
    [Buffer.from([0xff]), 'XML_STRUCTURE_UNSUPPORTED'],
    [xml(`<det><prod>${product}</prod></det>`), 'ITEM_STRUCTURE_INCOMPLETE'],
    [xml(`<det nItem="1"><imposto/></det>`), 'ITEM_STRUCTURE_INCOMPLETE'],
    [xml(det(1, product, '<ICMS><ICMS999><CST>99</CST></ICMS999></ICMS>')), 'TAX_MAPPING_UNSUPPORTED'],
    [xml(det(1, product, '<ICMS><ICMS00><CST>00</CST><vNovo>1.00</vNovo></ICMS00></ICMS>')), 'TAX_MAPPING_UNSUPPORTED'],
    [xml(det(1, product, '<PIS><PISAliq><vBC>1.00</vBC></PISAliq></PIS>')), 'TAX_MAPPING_UNSUPPORTED'],
  ];
  for (const [source, code] of cases) assert.throws(() => extractDeclaredItems(source),
    (error: unknown) => error instanceof ItemExtractionError && error.code === code && error.message === code);
});

test('ignora grupos irmãos fora do escopo mesmo quando o nome coincide com propriedade de objeto JavaScript', () => {
  const source = xml(det(1, '<cProd>X</cProd><xProd>Produto</xProd>', '<constructor><vExtra>1.00</vExtra></constructor>'));
  assert.deepEqual(extractDeclaredItems(source), [{ nItem: 1, product: { cProd: 'X', xProd: 'Produto' } }]);
});
