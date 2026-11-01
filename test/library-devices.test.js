// The devices of a library (src/shared/library.js): removing a device (a new owner key that the removed device never gets), a device let in
// again and a new one after it (every key generation), and a refused device. Run: node test/library-devices.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");

(async () => {
  // ---- three devices of one library ----
  const A = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  const B = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Phone" });
  const C = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Old tablet" });
  await A.create();
  const all = [A, B, C];
  const outbox = new Map(all.map((d) => [d, []]));
  for (const d of all) d.on("records", (rs) => outbox.get(d).push(...rs));
  // everything written goes to every other device (twice over, so what was refused for now is taken later)
  async function settle() {
    for (let round = 0; round < 4; round++) {
      const sent = all.map((d) => [d, outbox.get(d).splice(0)]);
      for (const [from, rs] of sent) for (const to of all) if (to !== from) for (const r of rs) await to.receive(r);
      for (const d of all) for (const to of all) if (to !== d) for (const [k] of d.versions()) { const r = d.get(k); if (to.wants(k, r.ver)) await to.receive(r); }
    }
  }
  for (const X of [B, C]) {
    A.joinAsked(X.joinRequest());
    const { keys } = await A.allow(X.status().device.id);
    await X.receiveKeys(keys);
  }
  await settle();
  assert.ok(all.every((d) => d.status().state === "member"));
  assert.ok(A.get("dh:" + B.status().device.id) && A.get("dh:" + C.status().device.id), "every device said its X25519 key");

  // ---- removing a device: a new owner key, which it never gets ----
  const cId = C.status().device.id;
  await assert.rejects(B.removeDevice(cId), /only the main device/);
  await A.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:1"), { title: "Written before the removal" });
  await settle();
  const removed = await A.removeDevice(cId);
  assert.deepStrictEqual(removed.missed, [], "every remaining device was sent the new key");
  await A.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:8053"), { title: "Written after the removal" });
  await settle();
  assert.strictEqual(B.status().state, "member");
  assert.strictEqual(C.status().state, "removed");
  assert.deepStrictEqual((await B.api("GET", "/api/novels")).novels.map((n) => n.title).sort(), ["Written after the removal", "Written before the removal"], "B reads what is written with the new key");
  await assert.rejects(C.api("GET", "/api/novels"), /removed/);
  // C cannot read a record written with the new key
  const newRecord = A.get("novel:wtr-lab:8053");
  assert.ok(newRecord.kg >= 1);
  // B writes with the new key too, and A takes it
  await B.api("PUT", "/api/term-notes", { source: "科雷", keys: ["wtr-lab:8053"], text: "after" });
  await settle();
  assert.strictEqual((await A.api("GET", "/api/term-notes")).notes[0].text, "after");

  // the removed device asks again (its old library goes), the main device lets it in, and it reads the library as a new member
  await C.abandon();
  assert.strictEqual(C.status().state, "joining");
  assert.strictEqual(C.status().libId, "", "it holds nothing of the old library");
  A.joinAsked(C.joinRequest());
  await C.receiveKeys((await A.allow(cId)).keys);
  await settle();
  assert.strictEqual(C.status().state, "member", "removed, asked again, let in");
  assert.deepStrictEqual((await C.api("GET", "/api/novels")).novels.map((n) => n.title).sort(), ["Written after the removal", "Written before the removal"]);

  // a device let in after the removal gets every key generation, so it reads the old records too
  const D = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "New phone" });
  all.push(D);
  outbox.set(D, []);
  D.on("records", (rs) => outbox.get(D).push(...rs));
  A.joinAsked(D.joinRequest());
  await D.receiveKeys((await A.allow(D.status().device.id)).keys);
  await settle();
  assert.strictEqual(D.status().state, "member");
  assert.deepStrictEqual((await D.api("GET", "/api/novels")).novels.map((n) => n.title).sort(), ["Written after the removal", "Written before the removal"]);

  // a refused device is listed with its name and not shown when it asks again, until it is taken off the list
  const E = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Tablet" });
  all.push(E);
  const eId = E.status().device.id;
  assert.strictEqual(A.joinAsked(E.joinRequest()), true);
  await A.refuse(eId);
  assert.deepStrictEqual(A.status().refused, [{ id: eId, name: "Tablet" }]);
  assert.deepStrictEqual(B.status().refused, [], "only the main device has the list");
  assert.strictEqual(A.joinAsked(E.joinRequest()), false, "refused: not shown again");
  assert.deepStrictEqual(A.status().joins, []);
  await A.unrefuse(eId);
  assert.deepStrictEqual(A.status().refused, []);
  assert.strictEqual(A.joinAsked(E.joinRequest()), true, "off the list: it is shown again");
  assert.deepStrictEqual(A.status().joins.map((j) => j.name), ["Tablet"]);

  console.log("OK — library devices checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
