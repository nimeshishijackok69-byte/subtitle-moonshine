<#
.SYNOPSIS
    Runs each bench strategy in its own process with a hard wall-clock kill.

.DESCRIPTION
    A single hung child used to eat an entire sweep: the loop waited forever on
    a process that had already written its results, and every strategy after it
    never ran (F-007).

    This driver treats each strategy as an independent unit - start, wait, kill
    if it overstays - so one failure costs exactly one row and the rest of the
    sweep still runs. Each run gets its own JSON, stdout and stderr file.

    Termination follows a completion marker (<out>.json.done) that the runner
    writes before it releases the session: a process can finish every decode,
    write every result, and still never exit, and nothing inside it can force
    the issue (F-007). Marker seen -> a short grace, then kill and report
    EXIT HANG with the data intact. No marker by the deadline -> TIMEOUT.

    Uses System.Diagnostics.Process rather than Start-Process: an object
    returned by -PassThru does not expose ExitCode, so a killed run and a clean
    run would be indistinguishable.

.PARAMETER Audio
    Raw s16le / 16 kHz / mono input. Defaults to ..\bench-audio\ep01.raw,
    i.e. a sibling of the repo, which is where the corpus is extracted.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File bench\sweep.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File bench\sweep.ps1 `
        -Strategies final8 -Beams "1,8" -Repeats 3 -OutDir bench\out\beam
#>
[CmdletBinding()]
param(
    [string]$Audio = "",
    [int]$LimitSec = 60,
    [int]$Threads = 4,
    [string[]]$Strategies = @("current", "fixed1s5_250", "fixed2s250", "fixed2s500", "fixed2s750", "fixed2s1000", "fixed3s750", "final8"),
    [string]$Beams = "1",
    [int]$Repeats = 1,
    [int]$TimeoutSec = 300,
    [int]$GraceSec = 3,
    [int]$DecodeTimeout = 30000,
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

# `-Strategies a,b` binds as one string when the script is launched with
# powershell -File, so split on commas regardless of how it was supplied.
$Strategies = @($Strategies | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

$benchDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $benchDir
$matrix = Join-Path $benchDir "matrix.mjs"

if (-not $Audio) { $Audio = Join-Path (Split-Path -Parent $repoRoot) "bench-audio\ep01.raw" }
if (-not $OutDir) { $OutDir = Join-Path $benchDir "out" }
if (-not [System.IO.Path]::IsPathRooted($Audio)) { $Audio = Join-Path (Get-Location).Path $Audio }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path (Get-Location).Path $OutDir }

if (-not (Test-Path -LiteralPath $matrix)) { throw "matrix.mjs not found: $matrix" }
if (-not (Test-Path -LiteralPath $Audio)) { throw "audio not found: $Audio`n  extract a clip with: ffmpeg -i episode.mp3 -f s16le -ar 16000 -ac 1 ep01.raw" }

$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)

Write-Output ("sweep   audio={0} limit={1}s threads={2} beams={3} repeats={4} timeout={5}s grace={6}s" -f `
    (Split-Path -Leaf $Audio), $LimitSec, $Threads, $Beams, $Repeats, $TimeoutSec, $GraceSec)
Write-Output ("        node={0} ({1})" -f $node, (& $node -v))
Write-Output ""

$rows = New-Object System.Collections.Generic.List[object]

foreach ($strategy in $Strategies) {
    for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
        $tag = if ($Repeats -gt 1) { "$strategy.r$repeat" } else { $strategy }
        $json = Join-Path $OutDir "$tag.json"
        $marker = "$json.done"
        $outLog = Join-Path $OutDir "$tag.stdout.log"
        $errLog = Join-Path $OutDir "$tag.stderr.log"
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue

        $argLine = @(
            "`"$matrix`"",
            "--audio", "`"$Audio`"",
            "--limit", "$LimitSec",
            "--strategies", $strategy,
            "--beams", $Beams,
            "--threads", $Threads,
            "--progress",
            "--decodeTimeout", "$DecodeTimeout",
            "--out", "`"$json`""
        ) -join " "

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $node
        $psi.Arguments = $argLine
        $psi.WorkingDirectory = $repoRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $utf8
        $psi.StandardErrorEncoding = $utf8

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $started = $true
        $hint = ""
        $startError = ""
        try {
            $null = $proc.Start()
            # Drain both pipes concurrently; reading one while the other fills
            # its buffer is the classic redirect deadlock.
            $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
            $stderrTask = $proc.StandardError.ReadToEndAsync()

            $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
            while (-not $proc.HasExited) {
                if (Test-Path -LiteralPath $marker) {
                    if (-not $proc.WaitForExit($GraceSec * 1000)) { $hint = "EXIT HANG" }
                    break
                }
                if ([DateTime]::UtcNow -ge $deadline) { $hint = "TIMEOUT"; break }
                Start-Sleep -Milliseconds 200
            }
        } catch {
            $started = $false
            $startError = $_.Exception.Message
        }
        $sw.Stop()

        $note = ""
        if ($started -and -not $proc.HasExited) {
            try { $proc.Kill() } catch { }
            if (-not $proc.WaitForExit(5000)) {
                & taskkill /F /T /PID $proc.Id 2>&1 | Out-Null
                if (-not $proc.WaitForExit(5000)) { $note = "UNKILLABLE pid=$($proc.Id)" }
            }
        }
        $finished = $started -and $proc.HasExited
        $exitCode = if ($finished -and -not $hint) { $proc.ExitCode } else { $null }

        $stdoutText = ""; $stderrText = ""
        if ($started) {
            if ($stdoutTask.Wait(5000)) { $stdoutText = $stdoutTask.Result }
            if ($stderrTask.Wait(5000)) { $stderrText = $stderrTask.Result }
        }
        [System.IO.File]::WriteAllText($outLog, $stdoutText, $utf8)
        [System.IO.File]::WriteAllText($errLog, $stderrText, $utf8)

        # The JSON is the source of truth, not stdout: a killed process loses
        # whatever it had buffered in its pipe, but every file it already wrote
        # survives. matrix.mjs persists after each configuration for the same
        # reason.
        $jsonRuns = @()
        if (Test-Path -LiteralPath $json) {
            try {
                $doc = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
                $jsonRuns = @($doc.runs)
            } catch { $jsonRuns = @() }
        }

        if (-not $started) { $verdict = "START FAIL" }
        elseif ($hint -eq "TIMEOUT") { $verdict = "TIMEOUT" }
        elseif ($hint -eq "EXIT HANG") { $verdict = "EXIT HANG" }
        elseif ($exitCode -ne 0) { $verdict = "FAIL exit=$exitCode" }
        elseif ($jsonRuns.Count -eq 0) { $verdict = "NO RESULTS" }
        else { $verdict = "ok" }
        if ($note) { $verdict = "$verdict $note" }

        # One line per measured configuration, printed as it lands: a failure is
        # visible before the rest of the sweep finishes, not after.
        foreach ($run in $jsonRuns) {
            Write-Output ("{0,-16} beam={1,-2} {2,-14} wall={3,6:N1}s  decodes={4,3}  compute={5,5}x  p50={6,7}ms  p95={7,7}ms" -f `
                $tag, $run.beamWidth, $verdict, $run.wallSec, $run.decodes,
                $run.computeOverRealtime, $run.p50InferMs, $run.p95InferMs)

            $rows.Add([pscustomobject]@{
                strategy = $strategy
                repeat = $repeat
                beam = $run.beamWidth
                verdict = $verdict
                complete = $true
                exitCode = $exitCode
                wallSec = $run.wallSec
                processWallSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                decodes = $run.decodes
                computeOverRealtime = $run.computeOverRealtime
                p50InferMs = $run.p50InferMs
                p95InferMs = $run.p95InferMs
                json = Split-Path -Leaf $json
            })
        }

        if ($jsonRuns.Count -eq 0) {
            Write-Output ("{0,-16} {1,-30} wall={2,6:N1}s" -f $tag, $verdict, $sw.Elapsed.TotalSeconds)
            if ($startError) { Write-Output ("{0,-16} {1}" -f "", $startError) }
            else {
                $reason = ($stderrText -split "`r?`n") |
                    Where-Object { $_ -match 'Error|error|timeout|cannot|failed' } | Select-Object -Last 1
                if ($reason) { Write-Output ("{0,-16} {1}" -f "", $reason.Trim()) }
            }

            $rows.Add([pscustomobject]@{
                strategy = $strategy
                repeat = $repeat
                beam = $null
                verdict = $verdict
                complete = $false
                exitCode = $exitCode
                wallSec = $null
                processWallSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                decodes = $null
                computeOverRealtime = $null
                p50InferMs = $null
                p95InferMs = $null
                json = $null
            })
        }
    }
}

$summaryPath = Join-Path $OutDir ("sweep-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$payload = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    audio = Split-Path -Leaf $Audio
    limitSec = $LimitSec
    threads = $Threads
    beams = $Beams
    repeats = $Repeats
    timeoutSec = $TimeoutSec
    node = (& $node -v)
    rows = $rows
}
[System.IO.File]::WriteAllText($summaryPath, ($payload | ConvertTo-Json -Depth 5), $utf8)

Write-Output ""
Write-Output ("{0}/{1} runs complete  ->  {2}" -f ($rows | Where-Object { $_.complete }).Count, $rows.Count, $summaryPath)
$issues = $rows | Where-Object { -not $_.complete }
if ($issues) {
    Write-Output "runs without usable results:"
    $issues | ForEach-Object { Write-Output ("  {0,-16} {1}" -f $_.strategy, $_.verdict) }
}
