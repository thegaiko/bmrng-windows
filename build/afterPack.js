// electron-builder afterPack hook (macOS).
// При identity:null electron-builder не подписывает вложенные бинарники в
// extraResources. На Apple Silicon неподписанный Mach-O убивается (SIGKILL),
// поэтому здесь ad-hoc-подписываем ipatool, python и все .so/.dylib, а затем
// пере-подписываем сам бандл (seal ресурсов изменился).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function sign(f) {
  try { execFileSync("codesign", ["--force", "--sign", "-", f], { stdio: "ignore" }); return true; }
  catch (e) { console.warn("  ! codesign:", f, e.message); return false; }
}

function isMachO(f) {
  try { return execFileSync("file", ["-b", f]).toString().includes("Mach-O"); }
  catch { return false; }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const vendor = path.join(appPath, "Contents", "Resources", "vendor");
  if (!fs.existsSync(vendor)) { console.warn("afterPack: нет vendor — пропускаю"); return; }

  const files = walk(vendor);
  const libs = files.filter((f) => /\.(dylib|so)$/.test(f));
  const bins = files.filter((f) =>
    !/\.(dylib|so)$/.test(f) &&
    (/(^|\/)ipatool$/.test(f) || /\/bin\//.test(f)) &&
    isMachO(f));

  let n = 0;
  for (const f of libs) if (sign(f)) n++;          // сначала библиотеки
  for (const f of bins) if (sign(f)) n++;          // затем исполняемые
  console.log(`afterPack: ad-hoc подписано ${n} бинарников (${libs.length} lib, ${bins.length} exe) в vendor`);

  // пере-подписываем бандл целиком (ресурсы изменились)
  sign(appPath);
};
