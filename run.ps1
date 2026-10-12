$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Virtual environment not found. Create .venv and install requirements first."
}

& $Python (Join-Path $Root "adapter.py")
exit $LASTEXITCODE
