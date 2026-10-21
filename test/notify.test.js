// What is new, for the notifications (the extension's and the site's). Run: node test/notify.test.js
const assert = require("assert");
const path = require("path");
const N = require(path.join(__dirname, "..", "src", "shared", "notify.js"));

// ---- what is told ----
assert.strictEqual(N.allowed(undefined, "pr", "own"), true, "everything is on until switched off");
assert.strictEqual(N.allowed({ on: false }, "pr", "own"), false, "notifications off: nothing");
assert.strictEqual(N.allowed({ kinds: { pr: false } }, "pr", "own"), false, "its kind off");
assert.strictEqual(N.allowed({ kinds: { pr: false } }, "join", "own"), true, "another kind still on");
assert.strictEqual(N.allowed({ libs: { lib1: false } }, "follow", "lib1"), false, "its library off");
assert.strictEqual(N.allowed({ libs: { lib1: false } }, "follow", "lib2"), true, "another library still on");
assert.strictEqual(N.allowed({ libs: { own: false } }, "chapters", N.OWN), false, "your own library off");
assert.strictEqual(N.allowed({ until: 5000 }, "pr", "own", 4000), false, "turned off for a while: nothing");
assert.strictEqual(N.allowed({ until: 5000 }, "pr", "own", 5000), true, "the time is up: told again");
assert.strictEqual(N.allowed({ until: 0 }, "pr", "own"), true, "no time set");
assert.strictEqual(N.snoozed({ until: Date.now() + 60000 }), true);
assert.strictEqual(N.snoozed({ on: false }), false, "off until turned on is not a snooze");
assert.deepStrictEqual(N.SNOOZES.map((x) => x[1] / 60000), [30, 60, 120]);
assert.deepStrictEqual(N.KINDS.map((k) => k[0]), ["join", "devices", "pr", "chapters", "follow", "editions"]);

// ---- the list ----
let list = [];
for (let i = 0; i < 5; i++) list = N.add(list, { id: "n" + i }, 3);
assert.deepStrictEqual(list.map((n) => n.id), ["n4", "n3", "n2"], "newest first, kept to the most");
list = N.add(list, { id: "n2", text: "again" }, 3);
assert.deepStrictEqual(list.map((n) => n.id), ["n2", "n4", "n3"], "the same id: replaced, and first");
assert.strictEqual(list[0].text, "again");

// ---- a followed library ----
assert.deepStrictEqual(N.newInLibrary(null, { a: { title: "A", n: 3 } }), [], "the first look: nothing new");
assert.deepStrictEqual(N.newInLibrary({ a: 3 }, { a: { title: "A", n: 3 } }), [], "the same: nothing");
assert.deepStrictEqual(N.newInLibrary({ a: 3 }, { a: { title: "A", n: 7 }, b: { title: "B", n: 2 } }),
  [{ type: "chapters", id: "a", title: "A", added: 4 }, { type: "novel", id: "b", title: "B", added: 2 }]);
assert.deepStrictEqual(N.newInLibrary({ a: 0 }, { a: { title: "A", n: 0 } }), [], "a novel known with no chapters is not new");
assert.deepStrictEqual(N.newInLibrary({ a: 9 }, { a: { title: "A", n: 5 } }), [], "fewer chapters: nothing to tell");
assert.deepStrictEqual(N.newInLibrary({ a: 1 }, {}), [], "a novel gone: nothing to tell");

// ---- your own novels ----
assert.deepStrictEqual(N.newChapters(null, { X: 10 }), [], "the first look: nothing new");
assert.deepStrictEqual(N.newChapters({ X: 10, Y: 4 }, { X: 12, Y: 4, Z: 300 }), [{ name: "X", from: 10, to: 12 }], "past the last one; a new novel only noted");
assert.deepStrictEqual(N.newChapters({ X: 10 }, { X: 8 }), [], "an earlier last one: nothing");

console.log("OK — notify checks passed");
