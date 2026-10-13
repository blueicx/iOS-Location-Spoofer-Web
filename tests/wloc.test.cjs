const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Independent test encoder/decoder. These unit fixtures are generated, NOT captures.
function varint(n) {
  n = BigInt.asUintN(64, BigInt(n));
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
const int = (tag, n) => Buffer.concat([varint(tag * 8), varint(n)]);
const msg = (tag, bytes) => Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes]);
function read(bytes) {
  let i = 0;
  function v() { let n = 0n, shift = 0n; while (true) { const b = bytes[i++]; n |= BigInt(b & 127) << shift; if (!(b & 128)) return n; shift += 7n; } }
  const out = [];
  while (i < bytes.length) {
    const tag = Number(v()), wire = tag & 7;
    let value;
    if (wire === 0) value = Number(BigInt.asIntN(64, v()));
    else if (wire === 2) { const len = Number(v()); value = bytes.subarray(i, i + len); i += len; }
    else if (wire === 1 || wire === 5) { const len = wire === 1 ? 8 : 4; value = bytes.subarray(i, i + len); i += len; }
    else throw new Error('Unsupported test wire type');
    out.push({ tag: tag >>> 3, wire, value });
  }
  return out;
}
const target = { latitude: -12.5, longitude: 145.25, horizontalAccuracy: 8 };
const loc = () => Buffer.concat([int(1, 100000000), int(2, -200000000), int(3, 20), int(4, 777)]);
const valid = () => Buffer.concat([msg(2, Buffer.concat([int(1, 123), msg(2, loc())])), msg(22, msg(5, loc())), int(33, 42)]);
function synthetic(payload, suffix = Buffer.alloc(0)) {
  const header = Buffer.from('00010000000100000000', 'hex');
  header.writeUInt16BE(payload.length, 8);
  return Buffer.concat([header, payload, suffix]);
}

for (const filename of ['location-spoofer.js', 'public/location-spoofer.js']) {
  const api = require('../' + filename);
  const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  test(filename + ': scanned entries are separate from actual changed coordinate fields', () => {
    const noLocation = msg(2, int(1, 123));
    const patched = api.patchWlocPayload(Buffer.concat([valid(), noLocation]), target);
    assert.equal(patched.wifiCount, 2);
    assert.equal(patched.cellCount, 1);
    assert.equal(patched.diagnostics.modifiedLatitudeFields, 2);
    assert.equal(patched.diagnostics.modifiedLongitudeFields, 2);
    assert.equal(patched.diagnostics.modifiedWifiRecords, 1);
    assert.equal(patched.diagnostics.modifiedCellRecords, 1);
    assert.equal(patched.diagnostics.unsupportedRecords, 1);
    assert.equal(patched.diagnostics.beforeTargetRecords, 0);
    assert.equal(patched.diagnostics.afterTargetRecords, 2);
    assert.equal(patched.diagnostics.verified, true);
    // Decode the emitted bytes independently from the production decoder.
    const fields = read(Buffer.from(patched.payload));
    assert.equal(fields.find(f => f.tag === 33).value, 42);
    for (const f of fields.filter(f => f.tag === 22 || (f.tag === 2 && read(f.value).some(x => x.tag === 2)))) {
      const locations = read(f.value).filter(x => x.tag === (f.tag === 2 ? 2 : 5));
      for (const location of locations) {
        const decoded = read(location.value);
        assert.equal(decoded.find(x => x.tag === 1).value, -1250000000);
        assert.equal(decoded.find(x => x.tag === 2).value, 14525000000);
        assert.equal(decoded.find(x => x.tag === 4).value, 777);
      }
    }
  });
  test(filename + ': synthetic suffix is byte-preserved and emitted coordinates verified', () => {
    const suffix = Buffer.from('deadbeef010203', 'hex');
    const result = api.spoofAppleResponse(synthetic(valid(), suffix), target);
    assert.deepEqual(Buffer.from(result.response).subarray(-suffix.length), suffix);
    assert.equal(result.diagnostics.outputVerified, true);
    assert.equal(result.diagnostics.afterTargetRecords, 2);
    assert.equal(result.changed, true);
    const output = Buffer.from(result.response);
    assert.equal(output.readUInt16BE(8), result.payload.length);
    assert.equal(output.length, 10 + result.payload.length + suffix.length);
  });
  test(filename + ': already-target records report zero coordinate modifications', () => {
    const first = api.patchWlocPayload(valid(), target);
    const second = api.patchWlocPayload(first.payload, target);
    assert.equal(second.diagnostics.modifiedLatitudeFields, 0);
    assert.equal(second.diagnostics.modifiedLongitudeFields, 0);
    assert.equal(second.diagnostics.beforeTargetRecords, 2);
    assert.equal(second.diagnostics.afterTargetRecords, 2);
  });
  test(filename + ': generated 400/114 entry responses cannot confuse scan and modification counts', () => {
    for (const count of [400, 114]) {
      const unknown = Buffer.concat(Array.from({ length: count }, () => msg(2, int(1, 123))));
      const unchanged = api.spoofAppleResponse(synthetic(unknown), target);
      assert.equal(unchanged.wifiCount, count);
      assert.equal(unchanged.diagnostics.modifiedLatitudeFields, 0);
      assert.equal(unchanged.diagnostics.modifiedLongitudeFields, 0);
      assert.equal(unchanged.diagnostics.outputVerified, false);
      assert.equal(unchanged.changed, false);
      const supported = Buffer.concat(Array.from({ length: count }, () => msg(2, msg(2, loc()))));
      const changed = api.spoofAppleResponse(synthetic(supported), target);
      assert.equal(changed.wifiCount, count);
      assert.equal(changed.diagnostics.modifiedLatitudeFields, count);
      assert.equal(changed.diagnostics.modifiedLongitudeFields, count);
      assert.equal(changed.diagnostics.afterTargetRecords, count);
      assert.equal(changed.diagnostics.outputVerified, true);
    }
  });
  test(filename + ': corrupt output length is rejected by final envelope verification', () => {
    const input = synthetic(valid());
    const original = api.ArpcCodec.writeUInt16BE;
    api.ArpcCodec.writeUInt16BE = n => original(n - 1);
    try {
      assert.throws(() => api.spoofAppleResponse(input, target), /Output envelope verification failed/);
    } finally { api.ArpcCodec.writeUInt16BE = original; }
  });
  test(filename + ': unknown coordinate wire type remains unchanged and is diagnosed', () => {
    const fixed = Buffer.from('09000000000000f03f110000000000000040', 'hex');
    const payload = msg(2, msg(2, fixed));
    const input = synthetic(payload);
    const result = api.spoofAppleResponse(input, target);
    assert.deepEqual(Buffer.from(result.response), input);
    assert.equal(result.changed, false);
    assert.equal(result.diagnostics.modifiedLatitudeFields, 0);
    assert.equal(result.diagnostics.coordinateWireTypes.fixed64, 2);
    assert.equal(result.diagnostics.unsupportedRecords, 1);
    assert.equal(result.diagnostics.outputVerified, false);
  });
  test(filename + ': unrelated nested coordinates are not guessed as location records', () => {
    const input = synthetic(msg(2, msg(9, loc())));
    const result = api.spoofAppleResponse(input, target);
    assert.equal(result.changed, false);
    assert.deepEqual(Buffer.from(result.response), input);
  });
  test(filename + ': duplicate coordinate fields are ambiguous and left untouched', () => {
    const payload = msg(2, msg(2, Buffer.concat([loc(), int(1, 300000000)])));
    const result = api.patchWlocPayload(payload, target);
    assert.deepEqual(Buffer.from(result.payload), payload);
    assert.equal(result.diagnostics.unsupportedRecords, 1);
  });
  test(filename + ': bare protobuf retains its framing', () => {
    const result = api.spoofAppleResponse(valid(), target);
    assert.equal(result.kind, 'bare');
    assert.deepEqual(Buffer.from(result.response), Buffer.from(result.payload));
    assert.equal(result.diagnostics.outputVerified, true);
  });
  test(filename + ': two-byte synthetic length must not silently overflow', () => {
    assert.throws(() => api.buildSyntheticResponse(new Uint8Array(65536)), /length|large|65535/i);
  });
  test(filename + ': a malformed ten-byte int64 is rejected rather than truncated', () => {
    const invalid = Buffer.concat([Buffer.from([8]), Buffer.from('80808080808080808002', 'hex'), int(2, 100000000)]);
    const payload = msg(2, msg(2, invalid));
    const result = api.patchWlocPayload(payload, target);
    assert.deepEqual(Buffer.from(result.payload), payload);
    assert.equal(result.diagnostics.malformedRecords, 1);
    assert.equal(result.diagnostics.modifiedLatitudeFields, 0);
  });
  test(filename + ': partial schema coverage is explicit', () => {
    const patched = api.patchWlocPayload(Buffer.concat([valid(), msg(2, int(1, 123))]), target);
    assert.equal(patched.diagnostics.coverageComplete, false);
    assert.equal(api.patchWlocPayload(valid(), target).diagnostics.coverageComplete, true);
  });
  test(filename + ': latitude/longitude int64 boundaries and negative encoding round-trip independently', () => {
    for (const coords of [{ latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 }, { latitude: 0, longitude: 0 }]) {
      const patched = api.patchWlocPayload(valid(), { ...coords, horizontalAccuracy: 8 });
      const location = read(read(read(Buffer.from(patched.payload))[0].value).find(x => x.tag === 2).value);
      assert.equal(location.find(x => x.tag === 1).value, Math.round(coords.latitude * 1e8));
      assert.equal(location.find(x => x.tag === 2).value, Math.round(coords.longitude * 1e8));
      assert.equal(patched.diagnostics.afterTargetRecords, 2);
    }
  });
  test(filename + ': marker prefix and suffix survive length-changing rewrite', () => {
    const payload = valid();
    const prefix = Buffer.from('aabbcc', 'hex'), suffix = Buffer.from('feedcafe', 'hex');
    const len = Buffer.alloc(2); len.writeUInt16BE(payload.length);
    const input = Buffer.concat([prefix, Buffer.from('000000010000', 'hex'), len, payload, suffix]);
    const result = api.spoofAppleResponse(input, target);
    assert.equal(result.kind, 'marker');
    assert.deepEqual(Buffer.from(result.response).subarray(0, prefix.length), prefix);
    assert.deepEqual(Buffer.from(result.response).subarray(-suffix.length), suffix);
    assert.equal(result.diagnostics.outputVerified, true);
  });
  test(filename + ': ARPC suffix and metadata are preserved', () => {
    const original = api.ArpcCodec.serialize({ version: 1, locale: 'en', appIdentifier: 'unit-test', osVersion: 'test', functionId: 1, payload: valid() });
    const suffix = Buffer.from('fffe0102', 'hex');
    const result = api.spoofAppleResponse(Buffer.concat([Buffer.from(original), suffix]), target);
    assert.equal(result.kind, 'arpc');
    assert.deepEqual(Buffer.from(result.response).subarray(-suffix.length), suffix);
    assert.equal(api.ArpcCodec.parse(result.response).appIdentifier, 'unit-test');
  });
  test(filename + ': unknown raw framing is never sent as a guessed synthetic envelope', () => {
    const done = [], logs = [];
    vm.runInNewContext(source, {
      $response: { body: Buffer.concat([Buffer.from('fffeffff', 'hex'), valid()]) },
      $argument: 'latitude=-12.5&longitude=145.25&debug=true',
      $done: r => done.push(r), console: { log: s => logs.push(s) },
    }, { timeout: 1000 });
    assert.equal(Object.keys(done[0]).length, 0);
    assert.match(logs.join('\n'), /framing|envelope/i);
    assert.match(logs.join('\n'), /modified Wi-Fi=0 Cell=0 latitude=0 longitude=0/);
    assert.match(logs.join('\n'), /outputVerified=false/);
  });
  test(filename + ': null or empty remote coordinates cannot fall back to defaults', () => {
    for (const value of [null, '']) {
      const done = [];
      vm.runInNewContext(source, {
        $response: { body: synthetic(valid()) },
        $argument: 'configUrl=https://private.invalid/loc.json?token=PRIVATE_SENTINEL&debug=true',
        $httpClient: { get: (_, cb) => cb(null, { status: 200 }, JSON.stringify({ latitude: value, longitude: value })) },
        $done: r => done.push(r), console: { log: () => {} },
      }, { timeout: 1000 });
      assert.equal(Object.keys(done[0]).length, 0);
    }
  });
  test(filename + ': runtime logs only aggregate scanned/modified/verified counts', () => {
    const logs = [], done = [];
    vm.runInNewContext(source, {
      $response: { body: synthetic(valid()), headers: {} },
      $argument: 'configUrl=https://private.invalid/loc.json?token=PRIVATE_SENTINEL&debug=true',
      $httpClient: { get: (_, cb) => cb(null, { status: 200 }, JSON.stringify(target)) },
      $done: r => done.push(r), console: { log: s => logs.push(s) },
    }, { timeout: 1000 });
    assert.equal(done.length, 1);
    assert.ok(done[0].body);
    assert.match(logs.join('\n'), /scanned/i);
    assert.match(logs.join('\n'), /modified/i);
    assert.match(logs.join('\n'), /verified/i);
    for (const secret of ['PRIVATE_SENTINEL', 'private.invalid', '-12.5', '145.25']) assert.ok(!logs.join('\n').includes(secret));
  });
}
test('both shipped scripts are identical', () => {
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../location-spoofer.js')), fs.readFileSync(path.join(__dirname, '../public/location-spoofer.js')));
});
