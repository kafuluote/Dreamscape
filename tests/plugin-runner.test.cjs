const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function run(input) {
  const output = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/plugin-runner.cjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  return JSON.parse(output.stdout).result;
}
const request = () => ({
  id: 'request',
  url: 'http://localhost',
  name: 'Test',
  method: 'GET',
  headers: [],
  parameters: [],
  body: { text: '', mimeType: '', params: [] },
  authentication: { type: 'none' },
  settings: {},
  preRequestScript: '',
  afterResponseScript: '',
});
test('request scripts modify headers and environment before native execution', () => {
  const r = request();
  r.preRequestScript =
    "insomnia.environment.set('nonce', 123); insomnia.request.addHeader({key:'X-Nonce',value:'123'}); console.log('ran');";
  const result = run({ request: r, phase: 'request', scriptsEnabled: true, environment: {}, plugins: [] });
  assert.equal(result.environment.nonce, 123);
  assert.equal(result.request.headers[0].value, '123');
  assert.deepEqual(result.logs, ['ran']);
});
test('response scripts report assertion failures without discarding the HTTP response', () => {
  const r = request();
  r.afterResponseScript =
    "insomnia.test('status',()=>insomnia.expect(insomnia.response.code).to.equal(200)); insomnia.test('json',()=>insomnia.expect(insomnia.response.json()).to.deep.equal({ok:true}));";
  const response = {
    status: 201,
    statusText: 'Created',
    body: '{"ok":true}',
    bodyBase64: Buffer.from('{"ok":true}').toString('base64'),
    headers: [],
  };
  const result = run({ request: r, response, phase: 'response', scriptsEnabled: true });
  assert.equal(result.tests[0].passed, false);
  assert.equal(result.tests[1].passed, true);
  assert.equal(result.response.status, 201);
});
test('CommonJS Insomnia hooks and store survive across worker invocations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-plugin-test-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'test-plugin', main: 'index.cjs' }),
    );
    fs.writeFileSync(
      path.join(dir, 'index.cjs'),
      "module.exports.requestHooks=[async context=>{const count=(await context.store.getItem('count')||0)+1;await context.store.setItem('count',count);context.request.setHeader('X-Count',String(count));}];",
    );
    const first = run({ request: request(), phase: 'request', plugins: [dir] });
    const second = run({ request: request(), phase: 'request', plugins: [dir], stores: first.stores });
    assert.equal(second.request.headers[0].value, '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
