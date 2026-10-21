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
      return;
    }
    if (st.state !== "member") return; // (the lock screen is shown instead)
    const others = st.devices.filter((d) => !d.me).map((d) => d.name + (d.main ? " (main)" : ""));
    textEl.textContent = "Your glossaries, terms and notes are kept here and on your other devices. This device: " +
      st.device.name + (st.main ? " — the main device, which lets new devices in" : "") + ". " +
      (others.length ? "Also: " + others.join(", ") + "." : "No other device yet.") + tail;
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

  draw();
  setInterval(() => { if (!busy) draw(); }, 3000); // a device asking to join shows up while the popup is open
})();
