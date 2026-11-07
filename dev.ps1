# Запуск объединённого проекта в режиме разработки:
# бэкенд FastAPI (uvicorn :8000) и фронтенд Next.js (:3000) в отдельных окнах.
$root = $PSScriptRoot

# Папка бэкенда: backend/ (целевое имя) или HR Helper/ (исходное).
$backend = Join-Path $root "backend"
if (-not (Test-Path $backend)) { $backend = Join-Path $root "HR Helper" }

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$backend'; python app.py"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\app'; npm run dev"

Write-Host "Бэкенд:  http://localhost:8000 (API, /api/docs)"
Write-Host "Фронтенд: http://localhost:3000"
