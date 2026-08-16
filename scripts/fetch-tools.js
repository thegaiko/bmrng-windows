// Скачивает ipatool.exe (Windows) в ./vendor для сборки .exe.
// Python с pymobiledevice3 бандлится отдельно (см. README).
const fs = require("fs");
const path = require("path");
const https = require("https");

const VENDOR = path.join(__dirname, "..", "vendor");
// Пропатченный ipatool (добавлен флаг --reuse для установки из кэша нашего сервера).
// Собран из форка majd/ipatool v2.3.2, хостится у нас. Оригинал: github.com/majd/ipatool
const URL = "https://bmrng.app/download/ipatool-win-patched.exe";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u) => {
      const req = https.get(u, { headers: { "User-Agent": "bmrng-ci" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
        const f = fs.createWriteStream(dest);
        res.on("error", reject);
        f.on("error", reject);
        res.pipe(f);
        f.on("finish", () => f.close(() => resolve()));
      });
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    };
    go(url);
  });
}

async function downloadRetry(url, dest, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try { await download(url, dest); return; }
    catch (e) {
      try { fs.unlinkSync(dest); } catch {}
      console.log(`  ↻ повтор загрузки ${i}/${tries}: ${e.message}`);
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  const dest = path.join(VENDOR, "ipatool.exe");
  console.log("↓ ipatool (пропатченный, --reuse) …");
  await downloadRetry(URL, dest);
  const sz = fs.statSync(dest).size;
  if (sz < 5 * 1024 * 1024) throw new Error("ipatool.exe подозрительно мал: " + sz + " байт");
  console.log("✓ vendor/ipatool.exe готов (" + Math.round(sz / 1048576) + " МБ)");
  console.log("Далее: положите Windows-Python с pymobiledevice3 в vendor/python/ (см. README).");
})();
