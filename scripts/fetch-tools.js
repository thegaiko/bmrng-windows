// Скачивает ipatool.exe (Windows) в ./vendor для сборки .exe.
// Python с pymobiledevice3 бандлится отдельно (см. README).
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const VENDOR = path.join(__dirname, "..", "vendor");
const IPATOOL_VER = "2.3.2";
const ARCH = process.env.IPA_ARCH || "amd64"; // amd64 | arm64
const URL = `https://github.com/majd/ipatool/releases/download/v${IPATOOL_VER}/ipatool-${IPATOOL_VER}-windows-${ARCH}.tar.gz`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return go(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
      const f = fs.createWriteStream(dest);
      res.pipe(f); f.on("finish", () => f.close(resolve));
    }).on("error", reject);
    go(url);
  });
}

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  const tgz = path.join(VENDOR, "ipatool.tar.gz");
  console.log("↓ ipatool", ARCH, "…");
  await download(URL, tgz);
  execSync(`tar -xzf "${tgz}" -C "${VENDOR}"`);
  // распакуется ipatool-*-windows-*/ipatool.exe — вытащим наверх
  for (const d of fs.readdirSync(VENDOR)) {
    const p = path.join(VENDOR, d);
    if (fs.statSync(p).isDirectory()) {
      const exe = path.join(p, "ipatool.exe");
      if (fs.existsSync(exe)) { fs.copyFileSync(exe, path.join(VENDOR, "ipatool.exe")); }
    }
  }
  fs.unlinkSync(tgz);
  console.log("✓ vendor/ipatool.exe готов");
  console.log("Далее: положите Windows-Python с pymobiledevice3 в vendor/python/ (см. README).");
})();
