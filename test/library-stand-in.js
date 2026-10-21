// A library in this process, for the tests of what asks the library (glossary-server.js and the scripts that use it): library-api.js answering
// the /api/... calls the way library-host.js's "api" op does (pictures cross as base64). Not a test itself (no .test.js).
//   const lib = libraryStandIn();
//   globalThis.LibraryHost = lib.host;   // what glossary-server.js asks, as in Firefox's background page
//   await lib.api("GET", "/api/novels"); // the test's own look, straight at the library
//   lib.down = true;                      // the library does not answer (as when Chrome's offscreen page is starting)
//   lib.state                             // everything it keeps
const { createLibraryApi, normalizeState } = require("../src/shared/library-api.js");

function libraryStandIn(saved) {
  const pictures = new Map();
  const handler = createLibraryApi({
    state: normalizeState(saved || {}),
    persist: () => {},
    covers: { save: (id, bytes) => void pictures.set(id, bytes), read: (id) => pictures.get(id) || null }
  });
  const lib = {
    down: false,
    calls: 0,
    state: handler.state,
    api: (method, path, body) => handler.handle(method, path, body),
    host: {
      async call(op, [method, path, body] = []) {
        if (op !== "api") throw new Error("unknown library call " + op);
        lib.calls++;
        if (lib.down) throw Object.assign(new Error("the library did not answer"), { network: true });
        // (what crosses a message is a copy)
        const b = body && typeof body.bytesB64 === "string" ? { type: body.type, bytes: new Uint8Array(Buffer.from(body.bytesB64, "base64")) } : body === undefined ? undefined : structuredClone(body);
        const out = await handler.handle(String(method), String(path), b);
        return out && out.bytes instanceof Uint8Array ? { type: out.type, hash: out.hash, bytesB64: Buffer.from(out.bytes).toString("base64") } : structuredClone(out);
      }
    }
  };
  return lib;
}

module.exports = { libraryStandIn };
