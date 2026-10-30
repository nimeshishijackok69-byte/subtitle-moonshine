# Chrome Web Store packaging with a strict allowlist.
# Ships ONLY manifest-reachable files; proves binaries are real (not Git LFS
# pointer stubs) and sized sanely before zipping. Run: powershell -f package.ps1
# NOTE: ASCII-only on purpose -- Windows PowerShell 5.1 mangles non-ASCII in
# .ps1 files whose encoding it cannot sniff.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content "$repo\manifest.json" -Raw | ConvertFrom-Json).version
$zipPath = Join-Path (Split-Path $repo -Parent) "subtitle-moonshine-$version.zip"

$files = @(
  "manifest.json", "constants.js", "service_worker.js", "offscreen.js", "offscreen.html",
  "contentScript.js", "popup.js", "popup.html", "popup.css", "audio-worklet.js",
  "sensevoice-frontend.js", "README.md",
  "lib\ort.min.js", "lib\ort-wasm-simd-threaded.mjs", "lib\ort-wasm-simd-threaded.wasm", "lib\silero_vad.onnx",
  "models\sensevoice\frontend.json", "models\sensevoice\tokens.txt",
  "models\sensevoice\model.int8.onnx", "models\sensevoice\LICENSE"
)
# Deliberately EXCLUDED: docs\, context.md, implementation_plan.md,
# deepseek_findings.md, models\onnx\ (dead Moonshine models, ~87 MB),
# models\tokenizer*, models\*.json, lib\ort.all.min.js,
# lib\ort-wasm-simd-threaded.jsep.*, .git\, .freebuff\ (dev server),
# .commandcode\, .gitattributes
$excludedIfPresent = @(
  "models\onnx", "lib\ort.all.min.js"
)

foreach ($rel in $files) {
  if (-not (Test-Path (Join-Path $repo $rel))) { throw "Missing required file: $rel" }
}
foreach ($rel in $excludedIfPresent) {
  if (Test-Path (Join-Path $repo $rel)) { throw "Excluded artifact unexpectedly present in repo: $rel" }
}

# Binary sanity: real weights, not LFS pointer stubs; sane minimum sizes.
$onnx = Join-Path $repo "models\sensevoice\model.int8.onnx"
$vad  = Join-Path $repo "lib\silero_vad.onnx"
$wasm = Join-Path $repo "lib\ort-wasm-simd-threaded.wasm"
if ((Get-Item $onnx).Length -lt 200MB) { throw "model.int8.onnx too small (LFS pointer or corrupted?)" }
foreach ($bin in @($onnx, $vad, $wasm)) {
  $head = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($bin)[0..30])
  if ($head -like "version https://git-lfs*") { throw "LFS pointer detected: $bin - run 'git lfs pull' first" }
}
$mib = [math]::Round((Get-Item $onnx).Length/1MB, 1)
Write-Host "Package binary assertions OK (model.int8.onnx ~ $mib MB)"

$stage = Join-Path $env:TEMP "cws-stage-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($rel in $files) {
    $dest = Join-Path $stage $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item (Join-Path $repo $rel) $dest
  }
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path "$stage\*" -DestinationPath $zipPath -Force
} finally {
  Remove-Item $stage -Recurse -Force
}

$zip = Get-Item $zipPath
Write-Host "$($zip.FullName) - files: $($files.Count) - $([math]::Round($zip.Length/1MB,1)) MB"
