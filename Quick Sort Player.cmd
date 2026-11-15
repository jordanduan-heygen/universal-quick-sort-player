@echo off
setlocal
title Quick Sort Player
cd /d "%~dp0"

echo.
echo  Quick Sort Player
echo  =================
echo.

if not exist ".venv\Scripts\quick-sort-player.exe" (
  echo First launch: installing the app. This can take a few minutes...
  echo.
  where py >nul 2>nul
  if %errorlevel%==0 (
    py -3 -m venv .venv
  ) else (
    where python >nul 2>nul
    if errorlevel 1 (
      echo Python is not installed yet. Opening the download page...
      start "" "https://www.python.org/downloads/windows/"
      echo.
      echo Install Python, check "Add Python to PATH", then double-click this file again.
      pause
      exit /b 2
    )
    python -m venv .venv
  )
  if errorlevel 1 goto :failed
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  if errorlevel 1 goto :failed
  ".venv\Scripts\python.exe" -m pip install -e .
  if errorlevel 1 goto :failed
)

echo Opening http://127.0.0.1:8767 in your browser...
echo Keep this window open while you use Quick Sort Player.
echo Press Ctrl+C here when you are finished.
echo.
".venv\Scripts\quick-sort-player.exe" --no-reload
exit /b %errorlevel%

:failed
echo.
echo Installation did not finish. Copy the error above if you need help.
pause
exit /b 1
