$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv-build\Scripts\python.exe")) {
    py -3 -m venv .venv-build
}

& ".venv-build\Scripts\python.exe" -m pip install --upgrade pip
& ".venv-build\Scripts\python.exe" -m pip install ".[dev]" pyinstaller
& ".venv-build\Scripts\python.exe" -m pytest -q
& ".venv-build\Scripts\pyinstaller.exe" --noconfirm --clean QuickSortPlayer.spec
$hash = (Get-FileHash ".\dist\Quick Sort Player.exe" -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  Quick Sort Player.exe" | Set-Content ".\dist\Quick Sort Player.exe.sha256" -Encoding ascii

Write-Host ""
Write-Host "Built: $PSScriptRoot\dist\Quick Sort Player.exe" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Green
Write-Host "You can copy that single EXE to another Windows 10/11 computer." -ForegroundColor Green
