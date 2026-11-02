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
  "diagnostics.js", "sensevoice-frontend.js", "README.md",
  "lib\ort.min.js", "lib\ort-wasm-simd-threaded.mjs", "lib\ort-wasm-simd-threaded.wasm",
  "lib\ort-wasm-simd-threaded.jsep.mjs", "lib\ort-wasm-simd-threaded.jsep.wasm", "lib\silero_vad.onnx",
  "models\sensevoice\frontend.json", "models\sensevoice\tokens.txt",
  "models\sensevoice\model.int8.onnx", "models\sensevoice\LICENSE"
)
# Deliberately EXCLUDED: docs\, context.md, implementation_plan.md,
# deepseek_findings.md, models\onnx\ (dead Moonshine models, ~87 MB),
# models\tokenizer*, models\*.json, lib\ort.all.min.js, .git\,
# .freebuff\ (dev server), .commandcode\, .gitattributes
#
# lib\ort-wasm-simd-threaded.jsep.* is NOT dead. lib\ort.min.js is the ORT
# webgpu bundle and requests "ort-wasm-simd-threaded.jsep.mjs" by name; dropping
# it makes InferenceSession.create fail with "no available backend found.
# ERR: [wasm] TypeError". The assertion below enforces that invariant instead
# of trusting a hand-maintained comment.
$excludedIfPresent = @(
  "models\onnx", "lib\ort.all.min.js"
)

foreach ($rel in $files) {
  if (-not (Test-Path (Join-Path $repo $rel))) { throw "Missing required file: $rel" }
}
foreach ($rel in $excludedIfPresent) {
  if (Test-Path (Join-Path $repo $rel)) { throw "Excluded artifact unexpectedly present in repo: $rel" }
}

# Runtime-companion invariant: the ORT bundle resolves its wasm artifacts by
# filename at runtime, so every name it references must exist on disk and be
# packaged. A missing companion only surfaces in the browser, as
# "no available backend found. ERR: [wasm] TypeError".
$ortText = Get-Content "$repo\lib\ort.min.js" -Raw
$ortRefs = @([regex]::Matches($ortText, 'ort-wasm-[A-Za-z0-9\.\-]+\.(?:mjs|wasm)') |
  ForEach-Object { $_.Value } | Sort-Object -Unique)
if ($ortRefs.Count -eq 0) { throw "no wasm artifact references found in lib\ort.min.js (minifier change?)" }
# Transitive: a referenced .mjs loader names its own .wasm payload.
foreach ($ref in @($ortRefs)) {
  $refPath = Join-Path $repo "lib\$ref"
  if ($ref -match '\.mjs$' -and (Test-Path $refPath)) {
    $jsText = Get-Content $refPath -Raw
    foreach ($m in [regex]::Matches($jsText, 'ort-wasm-[A-Za-z0-9\.\-]+\.wasm')) {
      if ($ortRefs -notcontains $m.Value) { $ortRefs += $m.Value }
    }
  }
}
foreach ($name in $ortRefs) {
  $rel = "lib\$name"
  if (-not (Test-Path (Join-Path $repo $rel))) { throw "lib\ort.min.js requires $rel but it is missing" }
  if ($files -notcontains $rel) { throw "$rel is required by lib\ort.min.js but absent from the allowlist" }
}
Write-Host "ORT runtime companions OK: $($ortRefs -join ', ')"

# Script-graph invariant: every file an extension page loads, every static
# import in the worker, and every getURL() asset must be packaged. The allowlist
# is hand-maintained and a new file is easy to forget; the failure is an
# extension that throws on load, which no binary check would catch.
$scriptRefs = @()
foreach ($page in @("popup.html", "offscreen.html")) {
  $html = Get-Content (Join-Path $repo $page) -Raw
  foreach ($m in [regex]::Matches($html, '<script[^>]*\ssrc="([^"]+)"')) { $scriptRefs += $m.Groups[1].Value }
}
foreach ($js in @("service_worker.js", "offscreen.js", "popup.js")) {
  $text = Get-Content (Join-Path $repo $js) -Raw
  foreach ($m in [regex]::Matches($text, 'import\s+"([^"]+)"')) { $scriptRefs += $m.Groups[1].Value }
  foreach ($m in [regex]::Matches($text, 'getURL\(\s*"([^"]+)"')) { $scriptRefs += $m.Groups[1].Value }
}
$allowNorm = @($files | ForEach-Object { $_ -replace '\\', '/' })
# A trailing slash is a directory (wasmPaths), not a file; the artifact names it
# resolves are covered by the ORT companion check above.
$scriptRefs = @($scriptRefs | ForEach-Object { $_.TrimStart("./") } |
  Where-Object { $_ -notlike '*/' } | Sort-Object -Unique)
foreach ($ref in $scriptRefs) {
  if ($allowNorm -notcontains $ref) { throw "$ref is loaded at runtime but missing from the allowlist" }
}
Write-Host "Script graph OK: $($scriptRefs.Count) entries"

# Binary sanity: real weights and real wasm modules, not LFS pointer stubs.
$onnx = Join-Path $repo "models\sensevoice\model.int8.onnx"
if ((Get-Item $onnx).Length -lt 200MB) { throw "model.int8.onnx too small (LFS pointer or corrupted?)" }
foreach ($rel in @($files | Where-Object { $_ -match '\.(onnx|wasm)$' })) {
  $bin = Join-Path $repo $rel
  $head = New-Object byte[] 32
  $stream = [System.IO.File]::OpenRead($bin)
  try { $read = $stream.Read($head, 0, 32) } finally { $stream.Dispose() }
  if ($read -lt 32) { throw "file too small to be a model or wasm module: $rel" }
  if ([System.Text.Encoding]::ASCII.GetString($head) -like "version https://git-lfs*") {
    throw "LFS pointer detected: $rel - run 'git lfs pull' first"
  }
  if ($rel -match '\.wasm$' -and ($head[0] -ne 0x00 -or $head[1] -ne 0x61 -or $head[2] -ne 0x73 -or $head[3] -ne 0x6D)) {
    throw "not a real wasm module (bad magic number): $rel"
  }
}
$mib = [math]::Round((Get-Item $onnx).Length/1MB, 1)
Write-Host "Package binary assertions OK (model.int8.onnx ~ $mib MB)"

# Build the archive entry-by-entry with explicit '/' entry names. Neither
# Compress-Archive nor ZipFile::CreateFromDirectory (on the .NET Framework
# that Windows PowerShell 5.1 hosts) is safe here: both have written '\'
# separators, which violates APPNOTE 4.4.17.1 - CWS rejects it and POSIX
# unzips extract literal "lib\ort.min.js" files that break the extension.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$mode = [System.IO.Compression.ZipArchiveMode]::Create
$level = [System.IO.Compression.CompressionLevel]::Optimal
$fs = [System.IO.File]::Create($zipPath)
$zip = New-Object System.IO.Compression.ZipArchive($fs, $mode)
try {
  foreach ($rel in $files) {
    $entryName = $rel -replace '\\', '/'
    $entry = $zip.CreateEntry($entryName, $level)
    $entryStream = $entry.Open()
    $fileStream = [System.IO.File]::OpenRead((Join-Path $repo $rel))
    try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
  }
} finally {
  $zip.Dispose()
  $fs.Dispose()
}

# Post-build validation of the actual archive: separator spec, entry set =
# allowlist, and the 228 MB model is really inside (not an LFS stub).
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if ($zip.Entries.Count -ne $files.Count) {
    throw "zip entry count $($zip.Entries.Count) != allowlist $($files.Count)"
  }
  $badSep = @($zip.Entries | Where-Object { $_.FullName -match '\\' })
  if ($badSep.Count -gt 0) { throw "backslash-separated zip entries exist (ZIP spec violation)" }
  $names = @($zip.Entries | ForEach-Object { $_.FullName })
  foreach ($rel in $files) {
    $norm = $rel -replace '\\', '/'
    if ($names -notcontains $norm) { throw "missing from zip: $norm" }
  }
  $modelEntry = $zip.Entries | Where-Object { $_.FullName -eq 'models/sensevoice/model.int8.onnx' }
  if (($modelEntry.Length) -lt 200MB) { throw "model.int8.onnx in zip too small ($($modelEntry.Length) B) - LFS pointer shipped?" }
} finally {
  $zip.Dispose()
}

$zip = Get-Item $zipPath
Write-Host "$($zip.FullName) - files: $($files.Count) - $([math]::Round($zip.Length/1MB,1)) MB"
Write-Host "Post-build validation OK: separators, entry set, model size"
