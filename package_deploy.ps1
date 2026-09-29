# Clean Deployment Packager for IncuVision (Raspberry Pi 5)
$Root = $PSScriptRoot
$DeployDir = Join-Path $Root "deploy_pi"

Write-Host "Creating clean deployment folder at: $DeployDir" -ForegroundColor Cyan

# Ensure clean directories
if (Test-Path $DeployDir) {
    Remove-Item -Path $DeployDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir "vision") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir "app") | Out-Null

# 1. Copy Frontend App files
Write-Host "Copying web dashboard..." -ForegroundColor Yellow
Copy-Item -Path (Join-Path $Root "app\*") -Destination (Join-Path $DeployDir "app") -Recurse -Force

# 2. Copy ONNX Model Weights
Write-Host "Copying yolov8ncandling.onnx..." -ForegroundColor Yellow
Copy-Item -Path (Join-Path $Root "yolov8ncandling.onnx") -Destination $DeployDir -Force

# 3. Copy Runtime Python Scripts Only
$RuntimeScripts = @(
    "main.py",
    "api.py",
    "candling_pipeline.py",
    "image_enhancer.py",
    "coordinator.py",
    "mqtt_bridge.py",
    "lcd_manager.py",
    "logger.py",
    "config.py",
    "requirements.txt"
)

Write-Host "Copying runtime vision scripts..." -ForegroundColor Yellow
foreach ($file in $RuntimeScripts) {
    $src = Join-Path $Root "vision\$file"
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $DeployDir "vision") -Force
    }
}

# 4. Copy Testing guide
Copy-Item -Path (Join-Path $Root "TESTING_GUIDE.txt") -Destination $DeployDir -Force

Write-Host "`nSUCCESS! Clean package created at '$DeployDir'." -ForegroundColor Green
$totalSize = (Get-ChildItem -Path $DeployDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("Total package size: {0:N2} MB" -f $totalSize) -ForegroundColor Green
