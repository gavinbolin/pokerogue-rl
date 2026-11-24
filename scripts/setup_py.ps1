# Creates the project venv (.venv, gitignored) with CUDA torch, gymnasium and numpy, then checks the GPU.
#   powershell -ExecutionPolicy Bypass -File scripts\setup_py.ps1          (or double-click Setup-Python.bat)
# Uses Python 3.12 through the py launcher (torch has CUDA wheels for it). Rerun any time; it is idempotent.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$TORCH_SPEC = "torch==2.11.0"
$TORCH_INDEX = "https://download.pytorch.org/whl/cu128"   # CUDA 12.8 build; works with driver >= 570

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "[setup_py] creating .venv with Python 3.12"
    py -3.12 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "py -3.12 not found; install Python 3.12 from python.org" }
}
$py = Join-Path $root ".venv\Scripts\python.exe"
& $py -m pip install --upgrade pip -q
& $py -m pip install $TORCH_SPEC --index-url $TORCH_INDEX -q
if ($LASTEXITCODE -ne 0) { throw "torch install failed" }
& $py -m pip install -r requirements.txt -q
if ($LASTEXITCODE -ne 0) { throw "requirements install failed" }
& $py -c @"
import torch, gymnasium, numpy, time
print('python', __import__('sys').version.split()[0], '| torch', torch.__version__, '| CUDA', torch.version.cuda, '| gymnasium', gymnasium.__version__, '| numpy', numpy.__version__)
ok = torch.cuda.is_available()
print('cuda available:', ok)
if ok:
    print('gpu:', torch.cuda.get_device_name(0))
    a = torch.randn(4096, 4096, device='cuda'); torch.cuda.synchronize(); t = time.time()
    for _ in range(10): b = a @ a
    torch.cuda.synchronize(); dt = time.time() - t
    print(f'matmul 4096^2 x10: {dt*1000:.0f} ms ({10*2*4096**3/dt/1e12:.1f} TFLOP/s fp32)')
"@
Write-Host "[setup_py] done. Use .venv\Scripts\python -m rl.bc  (see README 'Python training side')"
