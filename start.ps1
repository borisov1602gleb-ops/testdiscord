# Запуск проекта на Windows одной командой:  .\start.ps1
#
# Скрипт делает всё, что иначе приходится помнить руками: поднимает службу
# PostgreSQL, спрашивает пароль один раз и запоминает его в backend\.env,
# создаёт базу и применяет схему, если их ещё нет, и стартует backend.
# Повторный запуск ничего не ломает — можно запускать каждый раз.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=== Платформа сообществ: запуск ===" -ForegroundColor Cyan

# --- 1. Служба PostgreSQL ---
$service = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $service) {
  Write-Host "Служба PostgreSQL не найдена. Установи PostgreSQL или запусти базу вручную." -ForegroundColor Yellow
} elseif ($service.Status -ne "Running") {
  Write-Host "Запускаю службу $($service.Name)..."
  Start-Service -Name $service.Name
} else {
  Write-Host "PostgreSQL уже работает ($($service.Name))."
}

# --- 2. Настройки в backend\.env ---
$envFile = Join-Path $PSScriptRoot "backend\.env"
if (-not (Test-Path $envFile)) {
  Write-Host ""
  Write-Host "Первый запуск: нужен пароль пользователя postgres (тот, что задавали при установке)."
  $password = Read-Host "Пароль postgres"
  # Пароль попадает в строку подключения, поэтому спецсимволы экранируем.
  $escaped = [System.Uri]::EscapeDataString($password)
  $lines = @(
    "PORT=3000",
    "DATABASE_URL=postgres://postgres:$escaped@localhost:5432/community",
    "JWT_SECRET=local-dev-secret",
    "EXPOSE_DEV_CODE=true",
    "ETL_INTERVAL_SEC=300",
    "LIVEKIT_URL=ws://localhost:7880",
    "LIVEKIT_API_KEY=devkey",
    "LIVEKIT_API_SECRET=secret"
  )
  Set-Content -Path $envFile -Value $lines -Encoding UTF8
  Write-Host "Настройки сохранены в backend\.env — больше спрашивать не буду."
}

foreach ($line in Get-Content $envFile) {
  if ($line -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process")
  }
}

# --- 3. База данных ---
# psql обычно не прописан в PATH, поэтому ищем его там, куда ставится PostgreSQL.
$psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1

if ($null -ne $psql) {
  # Пароль для psql берём из той же строки подключения.
  if ($env:DATABASE_URL -match "postgres://postgres:([^@]*)@") {
    $env:PGPASSWORD = [System.Uri]::UnescapeDataString($matches[1])
  }
  $exists = & $psql.FullName -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='community'"
  if ($exists -ne "1") {
    Write-Host "Создаю базу community..."
    & $psql.FullName -U postgres -d postgres -c "CREATE DATABASE community" | Out-Null
  }
  $usersTable = & $psql.FullName -U postgres -d community -tAc "SELECT to_regclass('public.users')"
  if ([string]::IsNullOrWhiteSpace($usersTable)) {
    Write-Host "Применяю схему из db\schema.sql..."
    & $psql.FullName -U postgres -d community -f "db\schema.sql" | Out-Null
  }
} else {
  Write-Host "psql не найден — считаю, что база community уже готова." -ForegroundColor Yellow
}

# --- 4. Зависимости ---
if (-not (Test-Path (Join-Path $PSScriptRoot "backend\node_modules"))) {
  Write-Host "Ставлю зависимости (это один раз, минуту-две)..."
  npm install --prefix backend
}

# --- 5. Backend ---
# Миграции и таблицы аналитических слоёв backend применит сам при старте.
Write-Host ""
Write-Host "Открывай http://localhost:3000 — остановить можно по Ctrl+C." -ForegroundColor Green
Write-Host ""
node backend/src/index.js
