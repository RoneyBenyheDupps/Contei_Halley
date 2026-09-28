import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPool } from '../src/db.ts';

test('entrypoints TS e compilados: imports, migrate e inicialização da API', async (t) => {
  assert.match(process.env.MSSQL_DATABASE ?? '', /^ConteiTriagemTest_[a-f0-9]+$/, 'Exige base MSSQL isolada');
  assert.equal(process.env.MSSQL_HOST, 'localhost');
  const root = resolve(import.meta.dirname, '..');
  const buildParent = join(root, 'dist');
  await mkdir(buildParent, { recursive: true });
  const build = await mkdtemp(join(buildParent, 'entrypoints-'));
  const withoutCredentials = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MSSQL|HALLEY|CONTEI|QIVE)_/.test(name)));
  const run = (args: string[], env = process.env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const succeeds = (args: string[], env = process.env) => {
    const result = run(args, env);
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  };
  try {
    succeeds(['node_modules/typescript/bin/tsc', '--noEmit', 'false', '--rewriteRelativeImportExtensions', '--rootDir', '.', '--outDir', build]);
    await cp(join(root, 'migrations'), join(build, 'migrations'), { recursive: true });
    for (const [directory, extension] of [[root, 'ts'], [build, 'js']]) {
      const db = join(directory, 'src', `db.${extension}`);
      const modules = ['db', 'main', 'provision'].map((name) => pathToFileURL(join(directory, 'src', `${name}.${extension}`)).href);
      succeeds(['--input-type=module', '-e', modules.map((url) => `await import(${JSON.stringify(url)});`).join('\n'), 'migrate'], withoutCredentials);
      succeeds([db], withoutCredentials);
      for (const [name, args, expectedError] of [
        ['db', ['migrate'], 'Configuração MSSQL deploy incompleta'],
        ['main', [], 'HALLEY_JWT_ALGORITHM'],
        ['provision', [], 'Configuração MSSQL app incompleta'],
      ] as const) {
        const result = run([join(directory, 'src', `${name}.${extension}`), ...args], withoutCredentials);
        assert.equal(result.status, 1, `${name}.${extension} deve executar e recusar configuração ausente`);
        assert.ok(result.stderr.includes(expectedError), result.stderr);
      }
      succeeds([db, 'migrate']);
      succeeds([db, 'migrate']);
      t.diagnostic(`${extension}: imports sem execução, argumento migrate preservado, comandos ativos e migrations reaplicadas na base isolada`);
    }
    const pool = await createPool('deploy');
    try {
      const versions = await pool.request().query('SELECT version FROM contei.Migration ORDER BY version');
      assert.deepEqual(versions.recordset.map((row) => row.version), ['000', '001']);
    } finally { await pool.close(); }
    succeeds(['--test', join(build, 'tests', 'main.test.js')]);
    t.diagnostic('API compilada: inicialização e consulta HTTP com JWT sintético aprovadas');
  } finally {
    assert.equal(dirname(build), buildParent);
    await rm(build, { recursive: true, force: true });
  }
});
