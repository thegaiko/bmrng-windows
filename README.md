# bmrng для Windows

Кроссплатформенная (Electron) версия bmrng: тот же бэкенд `https://bmrng.app`, та же
логика установки приложений на iPhone (**ipatool** + **pymobiledevice3**).

## Что это

- **UI** — HTML/CSS/JS (Electron), не C#. Тот же фирменный стиль и сценарий.
- **Аккаунт** — регистрация/вход/подтверждение почты через API `bmrng.app` (тот же сервер, что у Mac-версии).
- **Установка** — `ipatool.exe` качает IPA из истории покупок Apple ID, `pymobiledevice3` ставит на iPhone по USB.

## Разработка (запуск)

```bash
cd bmrng-windows
npm install
npm start
```

В режиме разработки приложение берёт системные `ipatool` и `python3 -m pymobiledevice3`
(на macOS — те же, что у Mac-версии; на Windows — из PATH).

## Сборка .exe под Windows

Выполняется на Windows (или через CI):

```bash
npm install
npm run fetch-tools        # скачает vendor/ipatool.exe
# положить Windows-Python с pymobiledevice3 в vendor/python/ (см. ниже)
npm run dist               # -> release/bmrng Setup 1.0.0.exe  (+ portable)
```

### vendor/python (self-contained)
Чтобы .exe работал без установленного Python:
1. Скачать переносимый Windows-Python (python-build-standalone,
   `cpython-3.12.*-x86_64-pc-windows-msvc-install_only.tar.gz`).
2. Распаковать в `vendor/python/` (чтобы был `vendor/python/python.exe`).
3. `vendor/python/python.exe -m pip install pymobiledevice3`.

Если `vendor/` пуст — приложение ищет `ipatool.exe` и `python` в системном PATH.

## Требования на компьютере пользователя (Windows)

- **Apple Mobile Device Support** — для доступа к iPhone по USB. Ставится вместе с
  **iTunes** или приложением **Apple Devices** из Microsoft Store. Без него
  `pymobiledevice3` не увидит телефон.

## Структура

```
main.js          — процесс Electron: устройства, Apple ID, установка, API bmrng
preload.js       — мост IPC (contextBridge)
renderer/        — интерфейс (index.html, styles.css, renderer.js)
apps.json        — каталог приложений (общий с Mac-версией)
assets/logos/    — логотипы приложений
scripts/         — загрузка инструментов
vendor/          — вшитые ipatool.exe + python (для сборки)
```
