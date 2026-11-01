// A stand-in for the library (library.js roomLink) in the sync tests: no keys or records, only its id.
module.exports = function testLibrary(libId = "test library") {
  return {
    lib: async () => libId,
    versions: async () => [],
    wants: async () => false,
    get: async () => null,
    receive: async () => ({ stored: false })
  };
};
