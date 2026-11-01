// The popup's "Comic pictures" part of the Library tab: how much of the pictures this browser keeps.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  if (!$("picSave") || typeof PictureLimit === "undefined") return;

  PictureLimit.settings().then(({ maxGB }) => { $("picMax").value = String(maxGB); }, () => {});
  $("picSave").onclick = async () => {
    const v = Number($("picMax").value);
    if (!(v >= 1 && v <= 500)) return;
    await ext.storage.local.set({ [PictureLimit.MAX_KEY]: Math.round(v) });
    PictureLimit.forgetSettings();
    $("picSave").textContent = "Saved";
    setTimeout(() => { $("picSave").textContent = "Save"; }, 1500);
  };
})();
