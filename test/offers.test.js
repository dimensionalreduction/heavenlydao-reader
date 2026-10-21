// offerOnlyWhenNeeded (p2p-core.js): how many WebRTC offers each announce to a tracker carries, from what that tracker said last.
// Run: node test/offers.test.js
const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { offerOnlyWhenNeeded } = globalThis.P2PCore;

// A stand-in for a room torrent with bittorrent-tracker 9's client: two trackers, each recording what it was asked to announce
function fakeRoom(urls) {
  const client = new EventEmitter();
  client._trackers = urls.map((url) => ({ announceUrl: url, sent: [], announce(o) { this.sent.push(o); } }));
  const torrent = { numPeers: 0, discovery: { tracker: client } };
  return { torrent, client, t: client._trackers };
}
const last = (tr) => tr.sent[tr.sent.length - 1];
const usual = { numwant: 50, uploaded: 0, downloaded: 0, left: 0 };

const { torrent, client, t: [ours, other] } = fakeRoom(["wss://a", "wss://b"]);
assert.strictEqual(offerOnlyWhenNeeded(torrent), true);
assert.strictEqual(offerOnlyWhenNeeded(torrent), false, "fitted once");

ours.announce({ ...usual, event: "started" });
assert.strictEqual(last(ours).numwant, 50, "before a tracker answered: the usual offers");

// alone: the tracker lists only this device
client.emit("update", { announce: "wss://a", complete: 1, incomplete: 0 });
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 0, "alone in the room: no offers (one who arrives sends its own)");
other.announce(usual);
assert.strictEqual(last(other).numwant, 50, "each tracker by its own answer: one that has not answered still gets them");

// three others listed, one of them connected already
client.emit("update", { announce: "wss://a", complete: 3, incomplete: 1 });
torrent.numPeers = 1;
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 2, "as many as the devices listed that this one is not connected to");

// connected to everyone listed
torrent.numPeers = 3;
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 0, "connected to all of them: none");

// a room of thousands: none past the connection target (30), whatever the tracker lists
client.emit("update", { announce: "wss://a", complete: 5000, incomplete: 0 });
torrent.numPeers = 30;
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 0, "connected to 30: no more offers in a room of thousands");
torrent.numPeers = 28;
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 2, "up to the target");
// on the relay: 8
globalThis.P2PCore.setConnectionTarget(8);
torrent.numPeers = 8;
ours.announce(usual);
assert.strictEqual(last(ours).numwant, 0, "a page on the relay stops at 8");
globalThis.P2PCore.setConnectionTarget(30);

// a tracker listing many (or long-gone) devices: at most what was asked for (the tracker client caps it at 5 itself)
client.emit("update", { announce: "wss://b", complete: 40, incomplete: 0 });
torrent.numPeers = 0;
other.announce({ ...usual, numwant: 5 });
assert.strictEqual(last(other).numwant, 5);

// leaving is announced untouched
ours.announce({ ...usual, event: "stopped" });
assert.deepStrictEqual(last(ours), { ...usual, event: "stopped" });

// no tracker client (not started, or another WebTorrent): nothing happens
assert.strictEqual(offerOnlyWhenNeeded({ discovery: null }), false);
assert.strictEqual(offerOnlyWhenNeeded(null), false);

// connected to nobody while a tracker lists others: asked again soon (here 20 ms, then 40...), until connected or listed alone
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const room = fakeRoom(["wss://a"]);
  let updates = 0;
  room.client.update = () => { updates++; };
  offerOnlyWhenNeeded(room.torrent, { lonelyMs: 20, lonelyMaxMs: 40 });
  room.client.emit("update", { announce: "wss://a", complete: 3, incomplete: 0 }); // two others listed, connected to none
  await wait(35);
  assert.strictEqual(updates, 1, "announced again soon");
  room.client.emit("update", { announce: "wss://a", complete: 3, incomplete: 0 });
  await wait(25);
  assert.strictEqual(updates, 1, "the next one a little later (doubled)");
  await wait(30);
  assert.strictEqual(updates, 2, "and then");
  room.torrent.numPeers = 1;
  room.client.emit("update", { announce: "wss://a", complete: 3, incomplete: 0 });
  await wait(60);
  assert.strictEqual(updates, 2, "connected: no more");
  room.torrent.numPeers = 0;
  room.client.emit("update", { announce: "wss://a", complete: 1, incomplete: 0 });
  await wait(60);
  assert.strictEqual(updates, 2, "listed alone: none either");
  room.client.emit("update", { announce: "wss://a", complete: 2, incomplete: 0 });
  room.torrent.destroyed = true;
  await wait(40);
  assert.strictEqual(updates, 2, "a room left: none");
  console.log("OK — offers only when needed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
