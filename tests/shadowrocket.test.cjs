const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const file of ['location-spoofer.js', 'public/location-spoofer.js']) {
  const api = require(path.join(root, file));
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const p = api.ProtobufEngine;
  const concat = api.ByteUtils.concat;
  const location = concat([p.makeVarintField(1, 100000000), p.makeVarintField(2, 200000000), p.makeVarintField(3, 20), p.makeVarintField(4, 777)]);
  const payload = concat([p.makeLengthDelimitedField(2, p.makeLengthDelimitedField(2, location)), p.makeLengthDelimitedField(22, p.makeLengthDelimitedField(5, location)), p.makeVarintField(33, 42)]);
  const body = api.buildSyntheticResponse(payload);
  function run(options = {}) {
    const calls = [], logs = [], requests = [];
    const headers = { 'cOnTeNt-LeNgTh': '9999', 'CONTENT-ENCODING': 'gzip', 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/octet-stream', 'X-Keep': 'yes' };
    const context = {
      $response: { headers, body: options.body === undefined ? body : options.body },
      $argument: 'latitude=12.5&longitude=-45.25&horizontalAccuracy=8&debug=true' + (options.local ? '' : '&configUrl=https://config.invalid/loc.json?token=TEST_ONLY_SENTINEL') + (options.failClosed ? '&failOpen=false' : ''),
      $done: result => calls.push(result),
      console: { log: msg => logs.push(msg) },
    };
    if (!options.noClient) context.$httpClient = { get: (request, callback) => {
      requests.push(request);
      callback(options.error || null, options.response || { status: 200 }, options.data === undefined ? JSON.stringify({ latitude: 12.5, longitude: -45.25 }) : options.data);
    } };
    const originalHeaders = { ...headers };
    vm.runInNewContext(source, context, { timeout: 1000 });
    assert.equal(calls.length, 1, 'must complete exactly once');
    return { result: calls[0], logs, requests, headers, originalHeaders };
  }
  function passthrough(options) {
    assert.equal(Object.keys(run(options).result).length, 0, 'failed config must pass original response');
  }
  test(file + ': response shape, headers, coordinates, preserved fields, and safe diagnostics', () => {
    const { result, logs, requests, headers, originalHeaders } = run();
    assert.ok(ArrayBuffer.isView(result.body));
    assert.equal(result.response, undefined);
    assert.equal(result.status, undefined);
    assert.equal(result.headers['X-Location-Spoofer-Wifi'], '1');
    assert.equal(result.headers['X-Location-Spoofer-Cell'], '1');
    assert.equal(result.headers['X-Keep'], 'yes');
    assert.equal(result.headers['Content-Type'], 'application/octet-stream');
    assert.ok(!Object.keys(result.headers).some(k => /^(content-length|content-encoding|transfer-encoding)$/i.test(k)));
    assert.deepEqual(headers, originalHeaders, 'must not mutate original headers');
    const fields = p.readFields(api.extractEnvelope(result.body).payload);
    assert.equal(fields.find(f => f.fieldNumber === 33).int64Value, 42);
    for (const entity of fields.filter(f => f.wireType === 2)) {
      const locationBytes = p.readFields(entity.valueBytes).find(f => f.fieldNumber === (entity.fieldNumber === 2 ? 2 : 5)).valueBytes;
      const loc = p.readFields(locationBytes);
      assert.equal(loc.find(f => f.fieldNumber === 1).int64Value, 1250000000);
      assert.equal(loc.find(f => f.fieldNumber === 2).int64Value, -4525000000);
      assert.equal(loc.find(f => f.fieldNumber === 4).int64Value, 777);
    }
    assert.equal(requests[0].timeout, 5);
    assert.ok(logs.length > 0);
    assert.ok(!logs.join('\n').includes('TEST_ONLY_SENTINEL'));
    assert.ok(!logs.join('\n').includes('https://config.invalid'));
  });
  for (const [name, options] of [
    ['network failure', { error: 'unavailable' }],
    ['HTTP status failure', { response: { status: 403 } }],
    ['HTTP statusCode failure', { response: { statusCode: '403' } }],
    ['invalid JSON', { data: '{' }],
    ['empty response', { data: '' }],
    ['JSON null', { data: 'null' }],
    ['missing coordinates', { data: '{}' }],
    ['invalid latitude', { data: '{"latitude":"oops","longitude":2}' }],
    ['latitude out of range', { data: '{"latitude":91,"longitude":2}' }],
    ['longitude out of range', { data: '{"latitude":1,"longitude":181}' }],
    ['missing HTTP client', { noClient: true }],
  ]) test(file + ': ' + name + ' passes through', () => passthrough(options));
  test(file + ': local coordinates work without remote fetch', () => {
    const r = run({ local: true });
    assert.ok(r.result.body);
    assert.equal(r.requests.length, 0);
  });
  test(file + ': empty binary response passes through', () => passthrough({ local: true, body: new Uint8Array(0) }));
  test(file + ': malformed binary response passes through in fail-open mode', () => passthrough({ local: true, body: new Uint8Array([255, 255, 255]) }));
  test(file + ': fail-closed error uses top-level response', () => {
    const { result } = run({ local: true, failClosed: true, body: new Uint8Array([255, 255, 255]) });
    assert.equal(result.status, 500);
    assert.equal(result.response, undefined);
    assert.equal(result.headers['Content-Type'], 'text/plain');
    assert.match(result.body, /^Location spoofing failed:/);
  });
}
test('root/public scripts remain byte-identical', () => {
  assert.deepEqual(fs.readFileSync(path.join(root, 'location-spoofer.js')), fs.readFileSync(path.join(root, 'public/location-spoofer.js')));
});
test('static module enables diagnostics', () => {
  assert.match(fs.readFileSync(path.join(root, 'public/ios-location-spoofer.sgmodule'), 'utf8'), /&debug=true/);
});
