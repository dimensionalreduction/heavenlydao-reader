// The popup's "Your library" section: the library kept on your own devices (library-host.js, docs/SHARED-LIBRARIES.md): its devices, and
// letting new ones in. (Joining is the popup's lock screen, popup-lock.js: this part shows only once the extension is in the library.)
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const textEl = document.getElementById("myLibText");
  const codeEl = document.getElementById("myLibCode");
  const joinsEl = document.getElementById("myLibJoins");
  if (!textEl) return;

  async function call(op, ...args) {
    await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that keeps the library)
    const r = await ext.runtime.sendMessage({ target: "lib", op, args });
    if (!r) throw new Error("the extension did not answer");
    if (r.error) throw new Error(r.error);
    return r.result;
  }

  const button = (label, title, onclick) => {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = label;
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  let busy = "";
  // Runs one action, saying what it is doing, and draws the section again.
  const act = (doing, fn) => async () => {
    busy = doing;
    draw();
    try {
      const said = await fn();
      busy = "";
      await draw(said || "");
    } catch (e) {
      busy = "";
      await draw("Not done: " + e.message);
    }
  };

  let shown = ""; // what is on screen: drawn again only when it changes, so a button is not replaced under a click
  let lastNote = "";
  async function draw(note) {
    if (note !== undefined) lastNote = note;
    note = lastNote;
    let st;
    try {
      st = await call("status");
    } catch (e) {
      textEl.textContent = "The library can't be reached: " + e.message;
      textEl.hidden = false;
      shown = "";
      return;
    }
    const now = JSON.stringify([st, busy, note]);
    if (now === shown) return;
    shown = now;
    joinsEl.replaceChildren();
    codeEl.textContent = st.code ? "Library " + st.code : "";
    const tail = busy ? " " + busy : note ? " " + note : "";
    if (st.state === "unsupported") {
      textEl.textContent = "This browser can't make the library's keys (Ed25519). Update it to keep a library here.";
      textEl.hidden = false;
      return;
    }
    if (st.state !== "member") return; // (the lock screen is shown instead)
    textEl.textContent = tail.trim(); // (only what is being done or was just done)
    textEl.hidden = !textEl.textContent; // (nothing to say: no gap either)
    for (const j of st.joins) {
      const row = document.createElement("div");
      row.className = "label-row";
      row.style.marginTop = "6px";
      const who = document.createElement("span");
      who.className = "subtitle";
      who.style.margin = "0";
      who.textContent = "“" + j.name + "” asks to join";
      const btns = document.createElement("div");
      btns.className = "btn-group";
      btns.append(
        button("Allow", "Let this device in: it gets the library and can change it.", act("Letting it in…", async () => { await call("allow", j.id); return "Let in."; })),
        button("Refuse", "Not this device.", act("", async () => { await call("refuse", j.id); }))
      );
      row.append(who, btns);
      joinsEl.append(row);
    }
    for (const r of st.refused || []) {
      const row = document.createElement("div");
      row.className = "label-row";
      row.style.marginTop = "6px";
      const who = document.createElement("span");
      who.className = "subtitle";
      who.style.margin = "0";
      who.textContent = "Refused: " + r.name;
      const btns = document.createElement("div");
      btns.className = "btn-group";
      btns.append(button("Allow to ask again", "Take it off the refused list: when it asks to join again, you can allow it.", act("", async () => { await call("unrefuse", r.id); })));
      row.append(who, btns);
      joinsEl.append(row);
    }
  }

  // Leave this library: asked again first (with what goes), then the main device is told (the site's tabs in this browser are given the
  // proof the extension made; the devices in the room pass it on) and the lock screen shows, to join another.
  const leaveBtn = document.getElementById("leaveBtn");
  const leaveAsk = document.getElementById("leaveAsk");
  const leaveAskText = document.getElementById("leaveAskText");
  const leaveYes = document.getElementById("leaveYes");
  leaveBtn.onclick = async () => {
    let st;
    try {
      st = await call("status");
    } catch (e) {
      return void (leaveAskText.textContent = e.message);
    }
    const others = st.devices.filter((d) => !d.me);
    leaveYes.hidden = st.main && others.length > 0;
    leaveAskText.textContent = leaveYes.hidden
      ? "This extension is your library's main device: remove your other devices first (Settings › Library)."
      : others.length
        ? "Leave library " + st.code + "? This extension forgets it, with the chapters it holds; " + others.map((d) => d.name).join(", ") + (others.length === 1 ? " keeps it." : " keep it.")
        : "Leave library " + st.code + "? It is only on this extension: it is deleted, with its chapters.";
    leaveAsk.hidden = false;
    leaveBtn.disabled = true;
  };
  document.getElementById("leaveNo").onclick = () => { leaveAsk.hidden = true; leaveBtn.disabled = false; };
  leaveYes.onclick = async () => {
    leaveYes.disabled = true;
    leaveAskText.textContent = "Leaving…";
    const lockNote = document.getElementById("lockNote");
    try {
      const was = await call("status");
      const r = await call("leave");
      let removed = false;
      if (r.proof) {
        const bridge = (ext.runtime.getManifest().content_scripts || []).find((c) => c.js.includes("site-bridge.js"));
        const tabs = bridge ? await Promise.resolve(ext.tabs.query({ url: bridge.matches })).catch(() => []) : [];
        for (const t of tabs) {
          const a = await Promise.race([Promise.resolve(ext.tabs.sendMessage(t.id, { type: "site:ask", op: "leaving", args: [r.proof] })).catch(() => null), new Promise((ok) => setTimeout(ok, 8000))]);
          if (a && a.result && a.result.removed) removed = true;
        }
      }
      const main = was.devices.find((d) => d.main && !d.me);
      lockNote.textContent = "Left library " + was.code + "." + (removed || !main ? "" : " If “" + main.name + "” still lists “" + was.device.name + "”, press Remove there (Settings › Library).");
      leaveAsk.hidden = true;
      leaveBtn.disabled = false;
    } catch (e) {
      leaveAskText.textContent = "Not left: " + e.message;
    }
    leaveYes.disabled = false;
  };

  draw();
  setInterval(() => { if (!busy) draw(); }, 3000); // a device asking to join shows up while the popup is open
})();
