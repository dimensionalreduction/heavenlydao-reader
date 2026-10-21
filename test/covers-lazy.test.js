// Covers are not all held in memory (library.js): a cover record is kept by its head, its whole record read from the adapter when it is sent,
// and its picture read and opened when asked for (the last 30 kept). Run: node test/covers-lazy.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");

const png = (n) => { const b = new Uint8Array(2000 + n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[100] = n % 256; return b; };
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
  const store = Library.memoryAdapter();
  let laptop = await Library.open({ adapter: store, deviceName: "Laptop" });
  await laptop.create();
  for (let i = 0; i < 100; i++) await laptop.api("PUT", "/api/covers/novel" + i, { type: "image/png", bytes: png(i) });
  const c7 = await laptop.cover("novel7");
  assert.ok(c7 && c7.type === "image/png" && same(c7.bytes, png(7)), "a cover, read back");
  const served = await laptop.api("GET", "/api/covers/novel42");
  assert.ok(served && same(served.bytes, png(42)), "and as the API serves it");

  // opened again: what is held is each cover's head; the pictures are read when asked for
  laptop = await Library.open({ adapter: store, deviceName: "Laptop" });
  assert.ok(laptop.versions().some(([k]) => k === "cover:novel3"), "the cover is among the records kept");
  const asked = laptop.get("cover:novel3");
  assert.ok(asked instanceof Promise, "its record is read from the adapter, not held");
  assert.ok(!(laptop.get("devices") instanceof Promise), "(other records are held)");
  const whole = await asked;
  assert.ok(whole && typeof whole.body === "string" && whole.body.length > 1000 && whole.sig, "its whole record, read from the adapter");
  assert.ok(same((await laptop.cover("novel99")).bytes, png(99)), "a cover after opening again");
  assert.strictEqual((await laptop.api("GET", "/api/novels")).novels.length, 0);

  // a device let in gets the covers as records, and can read them
  const phone = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Phone" });
  const ask = phone.joinRequest();
  laptop.joinAsked(ask);
  const { keys } = await laptop.allow(ask.id);
  assert.ok(await phone.receiveKeys(keys));
  for (const [k, v] of laptop.versions()) if (phone.wants(k, v)) assert.ok((await phone.receive(await laptop.get(k))).stored, k + " taken");
  assert.ok(same((await phone.cover("novel55")).bytes, png(55)), "the phone reads a cover it was sent");

  // a cover changed: the new picture, everywhere it is read
  await laptop.api("PUT", "/api/covers/novel55", { type: "image/png", bytes: png(255) });
  assert.ok(same((await laptop.cover("novel55")).bytes, png(255)), "the new picture");
  for (const [k, v] of laptop.versions()) if (phone.wants(k, v)) await phone.receive(await laptop.get(k));
  assert.ok(same((await phone.cover("novel55")).bytes, png(255)), "on the phone too");

  // an import with covers: written as records, readable after
  const fresh = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Desk" });
  await fresh.create();
  const exported = await laptop.api("GET", "/api/export");
  const covers = {};
  for (let i = 0; i < 5; i++) covers["novel" + i] = png(i);
  await fresh.importState(Object.assign({}, exported, { covers: Object.fromEntries(Object.keys(covers).map((id) => [id, { type: "image/png", size: covers[id].length, at: 1, hash: "x" }])) }), covers);
  assert.ok(same((await fresh.cover("novel4")).bytes, png(4)), "an imported cover");
  assert.strictEqual(await fresh.cover("novel50"), null, "one not imported is not there");

  console.log("OK — covers lazy passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
