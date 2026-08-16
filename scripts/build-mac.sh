#!/usr/bin/env bash
# Сборка Mac-версии bmrng с ПРАВИЛЬНЫМ python под архитектуру.
#
# КРИТИЧНО: arm64-приложение обязано содержать arm64-python, x64 — x86_64-python.
# Если перепутать — pymobiledevice3 не стартует (на M-маках без Rosetta) и приложение
# «не видит телефон». Именно этот баг ловили в 1.0.23.
#
# Оба python лежат в build-python/{arm64,x64} (gitignored, ~300 МБ каждый).
# Как их пересобрать с нуля — см. OPERATIONS.md (раздел «Python под архитектуру»).
#
# Использование:
#   scripts/build-mac.sh arm64      — только Apple Silicon
#   scripts/build-mac.sh x64        — только Intel
#   scripts/build-mac.sh both       — обе
set -euo pipefail
cd "$(dirname "$0")/.."   # → корень bmrng-windows

ARCH="${1:-}"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" && "$ARCH" != "both" ]]; then
  echo "Использование: $0 arm64|x64|both"; exit 1
fi

swap_and_build() {
  local arch="$1"
  local src="build-python/$arch"
  if [[ ! -x "$src/bin/python3" ]]; then
    echo "✗ Нет $src/bin/python3 — положи туда $arch-python (см. OPERATIONS.md)"; exit 1
  fi

  echo "→ vendor/python := $arch"
  rm -rf vendor/python
  cp -R "$src" vendor/python
  find vendor/python -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find vendor/python -name '*.pyc' -delete 2>/dev/null || true

  # ipatool ТОЖЕ под арку: x86_64 ipatool на Apple Silicon без Rosetta даёт EBADARCH(-86)
  # при запуске (вход в Apple ID не проходит). arm64-сборка обязана нести arm64-ipatool.
  local ipa="build-ipatool/ipatool-$arch"
  if [[ ! -x "$ipa" ]]; then
    echo "✗ Нет $ipa — положи туда пропатченный ipatool под $arch (см. OPERATIONS.md)"; exit 1
  fi
  cp "$ipa" vendor/ipatool
  chmod +x vendor/ipatool
  local ia iwant; ia=$(file vendor/ipatool | grep -o 'arm64\|x86_64' || true)
  [[ "$arch" == arm64 ]] && iwant=arm64 || iwant=x86_64
  [[ "$ia" == "$iwant" ]] || { echo "✗ ipatool арки '$ia', ожидалась '$iwant'"; exit 1; }

  # проверка архитектуры python перед долгой сборкой
  local got want
  got=$(file vendor/python/bin/python3.12 2>/dev/null | grep -o 'arm64\|x86_64' || true)
  [[ "$arch" == arm64 ]] && want=arm64 || want=x86_64
  if [[ "$got" != "$want" ]]; then
    echo "✗ python архитектуры '$got', ожидалась '$want' — сборка отменена"; exit 1
  fi

  # проверка, что cryptography (нужна pymobiledevice3) реально импортируется
  if ! vendor/python/bin/python3 -c "from cryptography.hazmat.bindings._rust import x509" 2>/dev/null; then
    echo "✗ cryptography не импортируется в $arch-python — почини (см. OPERATIONS.md)"; exit 1
  fi

  echo "→ electron-builder --$arch"
  if [[ "$arch" == arm64 ]]; then
    npm run dist:mac -- --arm64
  else
    npm run dist:mac -- --x64
  fi

  # проверка собранного .app: арка python + импорт cryptography
  local appdir
  [[ "$arch" == arm64 ]] && appdir="release/mac-arm64/bmrng.app" || appdir="release/mac/bmrng.app"
  local py="$appdir/Contents/Resources/vendor/python/bin/python3"
  if [[ -x "$py" ]]; then
    local a; a=$(file "$appdir/Contents/Resources/vendor/python/bin/python3.12" | grep -o 'arm64\|x86_64' || true)
    if "$py" -c "from cryptography.hazmat.bindings._rust import x509" 2>/dev/null; then
      echo "✓ $arch: собранное приложение — python $a, cryptography OK"
    else
      echo "⚠ $arch: cryptography НЕ импортируется в собранном .app — проверь вручную"
    fi
  fi
}

case "$ARCH" in
  arm64) swap_and_build arm64 ;;
  x64)   swap_and_build x64 ;;
  both)  swap_and_build arm64; swap_and_build x64 ;;
esac

# вернуть vendor/python в дефолт (arm64) — чтобы `npm start` и случайная ручная
# сборка не собрали arm64-приложение с x64-python.
echo "→ восстанавливаю vendor/python := arm64 (дефолт)"
rm -rf vendor/python && cp -R build-python/arm64 vendor/python

echo "✓ Готово. Артефакты в release/ (dmg + zip)."
