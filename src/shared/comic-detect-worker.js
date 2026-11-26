// The comic text finder's model (comic-host.js: detect), run off the offscreen / background page's own thread, as the site's comic-detect-worker.js does. On that
// thread a tile (about 0.65 s on WebAssembly, a chapter over a hundred) held up everything else: the reading's requests, their answers, the lettering and the
// progress messages all waited until every tile was done, so nothing ran at once. Asked { id, model, input (3 x size x size floats), size } -> { id, map (size x size, 0-255) }
// or { id, error }.
importScripts("ort/ort.wasm.min.js");
ort.env.wasm.wasmPaths = new URL("ort/", self.location.href).href;
ort.env.wasm.numThreads = 1;

let session = null;
onmessage = async (ev) => {
  const { id, model, input, size } = ev.data;
  try {
    if (!session) session = ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    const s = await session;
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) });
    const prob = out[s.outputNames[0]].data, map = new Uint8Array(size * size);
    for (let i = 0; i < map.length; i++) map[i] = Math.round(Math.max(0, Math.min(1, prob[i])) * 255);
    postMessage({ id, map }, [map.buffer]);
  } catch (e) {
    session = null;
    postMessage({ id, error: String((e && e.message) || e) });
  }
};
