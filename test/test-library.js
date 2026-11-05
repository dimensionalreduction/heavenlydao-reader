// A stand-in for the library (library.js roomLink) in the sync tests: no records.
module.exports = function testLibrary() {
  return {
    versions: async () => [],
    wants: async () => false,
    get: async () => null,
    receive: async () => ({ stored: false })
  };
};
