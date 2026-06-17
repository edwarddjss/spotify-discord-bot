$ErrorActionPreference = 'Continue'
Write-Host '========== GREENROOM LIVE DIAGNOSTIC =========='

$greenroomExe = "$env:LOCALAPPDATA\Programs\greenroom\greenroom.exe"
$ff = "$env:LOCALAPPDATA\Programs\greenroom\resources\bin\ffmpeg.exe"
$dataDir = "$env:APPDATA\@greenroom\desktop"
$router = Join-Path $dataDir 'runtime\greenroom-audio-router.ps1'
$state = Join-Path $dataDir 'runtime\spotify-output-device.txt'

if (Test-Path $greenroomExe) {
  Write-Host "greenroom version: $((Get-Item $greenroomExe).VersionInfo.ProductVersion)"
} else {
  Write-Host 'greenroom.exe not found'
}

Write-Host "`n--- Processes ---"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'greenroom|ffmpeg|Spotify|Discord|node' } |
  Select-Object ProcessId, ParentProcessId, Name, @{ n = 'Cmd'; e = { if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(220, $_.CommandLine.Length)) } else { '' } } } |
  Format-Table -Wrap

Write-Host "--- Spotify output routing state ---"
if (Test-Path $state) { Get-Content $state } else { Write-Host 'no spotify-output-device.txt' }

Write-Host "`n--- Route Spotify now (test) ---"
if (Test-Path $router) {
  try {
    $routeOut = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $router -Action route -TargetName 'CABLE Input' -StatePath $state 2>&1
    Write-Host $routeOut
  } catch {
    Write-Host "route failed: $($_.Exception.Message)"
  }
}

Write-Host "`n--- FFmpeg device list (CABLE) ---"
if (Test-Path $ff) {
  & $ff -list_devices true -f dshow -i dummy 2>&1 | Select-String -Pattern 'CABLE|VB-Audio'
} else {
  Write-Host "ffmpeg missing at $ff"
}

Write-Host "`n--- 5s capture test (play Spotify now if silent) ---"
$wav = Join-Path $env:TEMP 'gr-live-capture.wav'
if (Test-Path $ff) {
  Remove-Item $wav -ErrorAction SilentlyContinue
  & $ff -y -f dshow -i 'audio=CABLE Output (VB-Audio Virtual Cable)' -t 5 -acodec pcm_s16le -ar 48000 -ac 2 $wav 2>&1 | Select-Object -Last 4
  if (Test-Path $wav) {
    $bytes = [IO.File]::ReadAllBytes($wav)
    $peak = 0
    for ($i = 44; $i -lt [Math]::Min($bytes.Length, 441044); $i += 2) {
      $s = [Math]::Abs([BitConverter]::ToInt16($bytes, $i))
      if ($s -gt $peak) { $peak = $s }
    }
    Write-Host "WAV size=$($bytes.Length) peak_sample=$peak (0=silence, >1000=audio present)"
  }
}

Write-Host "`n--- Spotify per-app endpoint registry ---"
Get-ItemProperty 'HKCU:\Software\Microsoft\Multimedia\Audio\DefaultEndpoint' -ErrorAction SilentlyContinue | Format-List

Write-Host "`n--- Packaged engine has NameMatches fix ---"
$asar = "$env:LOCALAPPDATA\Programs\greenroom\resources\app.asar"
if (Test-Path $asar) {
  $extract = Join-Path $env:TEMP 'gr-asar-check'
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue }
  npx --yes asar extract $asar $extract 2>$null
  $routerJs = Join-Path $extract 'node_modules\@greenroom\engine\dist\windows-audio-router.js'
  if (Test-Path $routerJs) {
    $hit = Select-String -Path $routerJs -Pattern 'NameMatches' -Quiet
    Write-Host "engine windows-audio-router NameMatches present: $hit"
  } else {
    Write-Host "could not find engine dist in asar"
  }
}

Write-Host "`n========== END =========="
