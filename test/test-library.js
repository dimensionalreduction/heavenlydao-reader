// A stand-in for the library (library.js roomLink) in the sync tests: every device given the same id is a device of one library and proves it
// (p2p-core.js protocol 10: only devices of a library talk chapters), with no keys or records. Real libraries: peer-auth.test.js.
module.exports = function testLibrary(libId = "test library") {
  return {
    lib: async () => libId,
    versions: async () => [],
    wants: async () => false,
    get: async () => null,
    receive: async () => ({ stored: false }),
    joinAsked: async () => false,
    receiveKeys: async () => false,
    joinRequest: async () => null,
    peerProof: async (text) => ({ d: libId, s: text }),
    peerCheck: async (d, text, s) => d === libId && s === text
  };
};
