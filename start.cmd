@echo off
rem Запуск start.ps1 без изменения политики выполнения скриптов Windows:
rem Bypass действует только на этот запуск. Параметры передаются как есть:
rem   start.cmd -NoLlm    start.cmd -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
