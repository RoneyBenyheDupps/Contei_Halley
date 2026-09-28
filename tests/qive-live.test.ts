import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQiveClient } from '../src/qive.ts';
import { inspectXml } from '../src/triagem.ts';
import { readQiveConfig } from '../src/config.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Gate Qive pendente: ${name} ausente`);
  return value;
}

test('conta Qive controlada: recebida disponível e citada excluída da descoberta', async () => {
  const cnpj = required('CONTEI_CNPJ');
  const receivedKey = required('QIVE_TEST_RECEIVED_KEY');
  const citedKey = required('QIVE_TEST_CITED_KEY');
  const client = createQiveClient(readQiveConfig(cnpj));
  const received = await client.getKnown(receivedKey);
  const cited = await client.getKnown(citedKey);
  assert.ok(received, 'NF-e recebida não encontrada na conta controlada');
  assert.ok(cited, 'NF-e citada não encontrada na conta controlada');
  assert.ok(received.xmlBytes, 'XML completo da recebida não disponível');
  inspectXml(received.xmlBytes, receivedKey);
  const returned = new Set<string>();
  let paginator: string | undefined;
  do {
    const page = await client.listPage(required('QIVE_TEST_FROM'), required('QIVE_TEST_TO'), paginator);
    for (const item of page.items) returned.add(item.accessKey);
    paginator = page.nextPaginator || undefined;
  } while (paginator);
  assert.ok(returned.has(receivedKey), 'Recebida ausente do filtro operacional');
  assert.ok(!returned.has(citedKey), 'Citada incluída no filtro operacional');
});
