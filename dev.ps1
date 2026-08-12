# Запуск в режиме разработки: Next.js (:3000) с горячей перезагрузкой.
# Полный запуск со всеми проверками и инфраструктурой — .\start.ps1 -Dev
$root = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\app'; npm run dev"

Write-Host "Приложение: http://localhost:3000"
