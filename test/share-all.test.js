// What is shared with readers (library.js `sharing`, the owner's own record): every novel by default, those stopped one by one remembered,
// kept private, and the same on every device of the library. (The site writes the novels' lists from it: sharing.js updateSharedManifests.)
// Run: node test/share-all.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");

(async () => {
  const laptop = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  await laptop.create();
  assert.deepStrictEqual(laptop.sharing(), { all: true, off: [], outCap: 0 }, "every novel, by default (and the daily limit: 0, the default)");
  assert.ok(Library.isPrivate("sharing"), "never published to readers");

  assert.deepStrictEqual(await laptop.put("sharing", { all: true, off: ["wtr-lab:1"] }), { changed: true });
  assert.deepStrictEqual(laptop.sharing(), { all: true, off: ["wtr-lab:1"], outCap: 0 });
  assert.deepStrictEqual(await laptop.put("sharing", { all: true, off: ["wtr-lab:1"] }), { changed: false }, "written only when it changes");

  // a device let in gets it with the rest of the library
  const phone = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Phone" });
  const ask = phone.joinRequest();
  laptop.joinAsked(ask);
  const { keys } = await laptop.allow(ask.id);
  assert.ok(await phone.receiveKeys(keys));
  for (const [k, v] of await laptop.versions()) if (phone.wants(k, v)) await phone.receive(await laptop.get(k));
  assert.deepStrictEqual(phone.sharing(), { all: true, off: ["wtr-lab:1"], outCap: 0 }, "the same on the phone");

  await phone.put("sharing", { all: false, off: [] });
  for (const [k, v] of await phone.versions()) if (laptop.wants(k, v)) await laptop.receive(await phone.get(k));
  assert.deepStrictEqual(laptop.sharing(), { all: false, off: [], outCap: 0 }, "and changed from either");

  console.log("OK — share all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
