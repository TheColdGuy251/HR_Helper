# ============================================================================
#  HR-помощник ТИУ — запуск всего приложения одной командой.
#
#    .\start.ps1               боевой режим (собранный Next.js)
#    .\start.ps1 -Dev          режим разработки (горячая перезагрузка)
#    .\start.ps1 -NoLlm        без локальной модели (быстрый старт, mock-ответы)
#    .\start.ps1 -SkipBuild    не пересобирать фронтенд
#    .\start.ps1 -WithPython   поднять ещё и старый FastAPI (для сверки)
#    .\start.ps1 -OpenFirewall открыть порт 3000 для домашней сети (от админа)
#    .\start.ps1 -Stop         остановить всё
#
#  Что поднимается:
#    PostgreSQL и Qdrant   — в Docker (docker-compose.yml)
#    Next.js  :3000        — ВСЁ приложение, включая ассистента; сюда и заходить
#    worker                — фоновые задания (ПДн, веб-источники, индексация)
#
#  Python больше не нужен: перенос завершён, FastAPI не запускается. Флаг
#  -WithPython поднимает его на :8000 рядом — только чтобы сравнить поведение
#  старой и новой реализации; на работу приложения это не влияет.
# ============================================================================
param(
  [switch]$Dev,
  [switch]$NoLlm,
  [switch]$SkipBuild,
  [switch]$WithPython,
  [switch]$OpenFirewall,
  [switch]$NoPython,  # устарел: Python и так не запускается; оставлен, чтобы
                      # прежняя команда не падала с ошибкой параметра
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'
$backend = Join-Path $root 'backend'
if (-not (Test-Path $backend)) { $backend = Join-Path $root 'HR Helper' }

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [ок] $text" 'Green' }
function Warn($text) { Say "  [!] $text" 'Yellow' }
function Die($text) { Say "  [стоп] $text" 'Red'; exit 1 }

function Test-Port($port) {
  try { (Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded }
  catch { $false }
}

# Ждёт, пока порт начнёт отвечать. Возвращает $false по истечении времени.
function Wait-Port($port, $seconds, $what) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $port) { Ok "$what отвечает на :$port"; return $true }
    Start-Sleep -Seconds 1
  }
  Warn "$what не поднялся за $seconds с — посмотрите его окно"
  return $false
}

function Stop-ByPort($port, $what) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { return }
  foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Ok "$what остановлен (:$port)"
}

# ── Доступ из локальной сети ────────────────────────────────────────────────
# Next и так слушает все интерфейсы, поэтому телефону мешает только брандмауэр
# Windows. Правило заводим ровно на порт 3000 и только для частных сетей —
# в кафе или на публичном Wi-Fi приложение открыто не будет.
if ($OpenFirewall) {
  $name = 'HR-помощник (Next.js 3000)'
  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { Die 'Нужны права администратора: запустите PowerShell «от имени администратора»' }

  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Ok 'Правило уже создано'
  } else {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 3000 -Profile Private | Out-Null
    Ok 'Порт 3000 открыт для частной сети'
  }
  Say "`nУдалить правило:  Remove-NetFirewallRule -DisplayName '$name'`n" 'Gray'
  exit 0
}

# ── Остановка ───────────────────────────────────────────────────────────────
if ($Stop) {
  Say "`nОстановка HR-помощника" 'Cyan'
  Stop-ByPort 3000 'Next.js'
  Stop-ByPort 8000 'FastAPI'
  # Воркер порт не слушает — ищем по командной строке.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*worker.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Ok 'Воркер остановлен' }
  Say "`nКонтейнеры PostgreSQL и Qdrant продолжают работать." 'Gray'
  Say "Остановить их:  docker compose stop`n" 'Gray'
  exit 0
}

Say "`n=== HR-помощник ТИУ ===" 'Cyan'
Say ("Режим: " + $(if ($Dev) { 'разработка' } else { 'боевой' }) + $(if ($NoLlm) { ', без LLM' } else { '' })) 'Gray'

# ── 1. Проверки окружения ───────────────────────────────────────────────────
Say "`n[1/5] Проверка окружения" 'Cyan'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Не найден Node.js' }
Ok "Node $(node --version)"

if (-not (Test-Path "$app\.env")) {
  Die "Нет файла $app\.env — скопируйте из .env.example и заполните"
}

function Get-EnvValue($file, $key) {
  $line = Select-String -Path $file -Pattern "^$key=(.*)$" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
  return ''
}
if (-not (Get-EnvValue "$app\.env" 'SECRET_KEY')) { Die 'SECRET_KEY не задан в app\.env' }

# Старый бэкенд нужен только для сверки, но если его поднимают — ключ подписи
# сессионной cookie обязан совпадать, иначе вход в одном не виден другому.
if ($WithPython) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Die 'Не найден Python' }
  if (-not (Test-Path "$backend\.env")) { Die "Нет файла $backend\.env" }
  if ((Get-EnvValue "$backend\.env" 'SECRET_KEY') -ne (Get-EnvValue "$app\.env" 'SECRET_KEY')) {
    Die 'SECRET_KEY в backend\.env и app\.env различаются — сессии не будут работать'
  }
  Ok 'SECRET_KEY согласован с backend\.env'
}

if (-not (Get-EnvValue "$app\.env" 'CRON_SECRET')) {
  Warn 'CRON_SECRET пуст — фоновые задания (в т.ч. автоудаление ПДн) не запустятся'
}
if (-not (Test-Path "$app\node_modules")) { Die "Нет зависимостей: cd app; npm install" }
Ok 'Зависимости на месте'

# ── 2. Инфраструктура ───────────────────────────────────────────────────────
Say "`n[2/5] База данных и векторный поиск" 'Cyan'

# Если сервисы уже подняты (в том числе созданы вручную, вне compose), не
# трогаем их: пересоздание контейнера Qdrant отвязало бы том с проиндексированной
# базой знаний.
if ((Test-Port 5432) -and (Test-Port 6333)) {
  Ok 'PostgreSQL и Qdrant уже работают'
} else {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die 'Не найден Docker' }
  # docker пишет прогресс в stderr, а PowerShell 5.1 считает это ошибкой команды,
  # поэтому на время вызова снимаем строгий режим и смотрим только код возврата.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $dockerOut = & docker compose -f (Join-Path $root 'docker-compose.yml') up -d *>&1
  $dockerFailed = $LASTEXITCODE -ne 0
  $ErrorActionPreference = $prevEap

  if ($dockerFailed) {
    # Частый случай: контейнер с таким именем уже существует, но остановлен.
    if ($dockerOut -match 'already in use') {
      Warn 'Контейнеры уже созданы вне compose — запускаю их напрямую'
      $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & docker start hr-postgres qdrant *>&1 | Out-Null
      $ErrorActionPreference = $prevEap
    } else {
      Say ($dockerOut | Select-Object -Last 3) 'DarkGray'
      Die 'Не удалось поднять контейнеры (запущен ли Docker Desktop?)'
    }
  }
  if (-not (Wait-Port 5432 40 'PostgreSQL')) { Die 'PostgreSQL недоступен' }
  if (-not (Wait-Port 6333 30 'Qdrant')) { Warn 'Qdrant недоступен — поиск по базе знаний работать не будет' }
}

# ── 3. Сборка фронтенда ─────────────────────────────────────────────────────
if (-not $Dev -and -not $SkipBuild) {
  Say "`n[3/5] Сборка фронтенда" 'Cyan'
  Push-Location $app
  # npm тоже пишет часть вывода в stderr — строгий режим здесь мешает.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & npm run build *>&1 | Select-String -Pattern 'Compiled|Failed|error' | ForEach-Object { Say "  $_" }
  $failed = $LASTEXITCODE -ne 0
  $ErrorActionPreference = $prevEap
  Pop-Location
  if ($failed) { Die 'Сборка не прошла' }
  Ok 'Собрано'
} else {
  Say "`n[3/5] Сборка пропущена" 'Cyan'
}

# ── 4. Запуск ───────────────────────────────────────────────────────────────
Say "`n[4/5] Запуск сервисов" 'Cyan'

Stop-ByPort 8000 'Прежний FastAPI'
Stop-ByPort 3000 'Прежний Next.js'

# FastAPI поднимается только по явному запросу (-WithPython) — для сверки
# ответов старой и новой реализации. Модель ему не отдаём: её держит Next.js,
# вторая копия в видеопамять не поместится. Планировщик там тоже выключен
# (SCHEDULER_ENABLED=false) — фоновые задания ведёт воркер, иначе выполнялись
# бы дважды.
if ($WithPython) {
  Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle='HR: FastAPI :8000 (сверка, не обязателен)'; " +
    "Set-Location '$backend'; `$env:LLM_ENABLED='false'; python app.py"
  )
  Wait-Port 8000 90 'FastAPI' | Out-Null
}

$nextCmd = if ($Dev) { 'npm run dev' } else { 'npm run start' }
Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "`$host.UI.RawUI.WindowTitle='HR: Next.js :3000'; Set-Location '$app'; $nextCmd"
)
if (-not (Wait-Port 3000 90 'Next.js')) { Die 'Next.js не поднялся' }

Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "`$host.UI.RawUI.WindowTitle='HR: фоновые задания'; Set-Location '$app'; npm run worker"
)
Ok 'Воркер фоновых заданий запущен'

# ── 5. Проверка ─────────────────────────────────────────────────────────────
Say "`n[5/5] Проверка" 'Cyan'
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 30
  Ok "Страница входа отвечает ($($r.StatusCode))"
} catch {
  Warn 'Страница входа не ответила — проверьте окно Next.js'
}

# Адрес в локальной сети — по нему заходят с телефона и других компьютеров.
# Next слушает все интерфейсы сам, отдельная настройка не нужна; мешает только
# брандмауэр Windows, поэтому проверяем и правило для порта.
function Get-LanIp {
  $c = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | Select-Object -First 1
  $addr = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
      ($null -eq $c -or $_.InterfaceIndex -eq $c.InterfaceIndex)
    } | Select-Object -First 1
  if ($addr) { return $addr.IPAddress }
  return $null
}

$lanIp = Get-LanIp
$fwRule = Get-NetFirewallRule -DisplayName 'HR-помощник (Next.js 3000)' -ErrorAction SilentlyContinue

Say "`n────────────────────────────────────────────" 'Cyan'
Say "  Приложение:  http://localhost:3000" 'Green'
if ($lanIp) {
  Say "  В сети:      http://${lanIp}:3000" 'Green'
}
Say "────────────────────────────────────────────" 'Cyan'
if ($lanIp -and -not $fwRule) {
  Warn 'С телефона пока не откроется: брандмауэр не пропускает входящие на :3000'
  Say  '  Открыть порт (один раз, в PowerShell от администратора):' 'Gray'
  Say  "  .\start.ps1 -OpenFirewall" 'Gray'
}
if ($WithPython) {
  Say "FastAPI на :8000 поднят для сверки — приложение к нему не обращается." 'DarkGray'
}
if (-not $NoLlm) {
  Say "`nПервый ответ ассистента займёт ~10 с: модель загружается в видеопамять." 'Gray'
}
Say "Остановить всё:  .\start.ps1 -Stop`n" 'Gray'
