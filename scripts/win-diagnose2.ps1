$ErrorActionPreference = 'Continue'
Write-Host '=== ENGINE / BOT STATE ==='
$procs = Get-CimInstance Win32_Process
$ffmpeg = $procs | Where-Object { $_.Name -eq 'ffmpeg.exe' }
Write-Host "ffmpeg processes: $($ffmpeg.Count)"
$ffmpeg | ForEach-Object { $_.CommandLine }

$engineLike = $procs | Where-Object { $_.CommandLine -match 'dist\\index\.js|@greenroom/engine|greenroom engine' }
Write-Host "engine-like processes: $($engineLike.Count)"
$engineLike | ForEach-Object { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) }

Write-Host "`n=== SPOTIFY TYPE ==="
$spotify = $procs | Where-Object { $_.Name -eq 'Spotify.exe' -and $_.CommandLine -notmatch 'type=' } | Select-Object -First 1
if ($spotify) { Write-Host $spotify.CommandLine }

Write-Host "`n=== ASAR ENGINE CHECK ==="
$asar = "$env:LOCALAPPDATA\Programs\greenroom\resources\app.asar"
$extract = "$env:TEMP\gr-asar-check2"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Push-Location $env:TEMP
npx --yes @electron/asar extract $asar $extract 2>$null
Pop-Location
Get-ChildItem $extract -Recurse -Filter 'windows-audio-router.js' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "found: $($_.FullName)"
  Write-Host "NameMatches: $((Select-String -Path $_.FullName -Pattern 'NameMatches' -Quiet))"
  Write-Host "normalizeFfmpeg: $((Select-String -Path $_.FullName -Pattern 'normalizeFfmpegCaptureDevice' -Quiet))"
}
Get-ChildItem $extract -Recurse -Filter 'audio-device-names.js' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "audio-device-names.js: $($_.FullName)" }

Write-Host "`n=== SPOTIFY AUTH PROFILES (no tokens) ==="
$auth = "$env:APPDATA\@greenroom\desktop\spotify-auth.json"
if (Test-Path $auth) {
  $json = Get-Content $auth -Raw | ConvertFrom-Json
  $json.profiles.PSObject.Properties | ForEach-Object {
    $p = $_.Value
    Write-Host "user=$($_.Name) audioDevice=$($p.audioDevice)"
  }
}

Write-Host "`n=== SQLITE AUDIO KEYS (strings) ==="
$db = "$env:APPDATA\@greenroom\desktop\greenroom.sqlite"
if (Test-Path $db) {
  $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($db))
  [regex]::Matches($text, 'audio\.(captureDevice|routeDevice|restoreDevice)') | ForEach-Object { $_.Value } | Sort-Object -Unique
}

Write-Host "`n=== DISCORD BOT IN VOICE? (need bot token - skip) ==="
Write-Host 'Check Discord UI: is greenroom bot in your voice channel with green speaking indicator?'

Write-Host "`n=== ROUTE + CAPTURE WHILE SPOTIFY PLAYING ==="
$router = "$env:APPDATA\@greenroom\desktop\runtime\greenroom-audio-router.ps1"
$state = "$env:APPDATA\@greenroom\desktop\runtime\spotify-output-device.txt"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $router -Action route -TargetName 'CABLE Input' -StatePath $state 2>&1
Start-Sleep -Seconds 2
$ff = "$env:LOCALAPPDATA\Programs\greenroom\resources\bin\ffmpeg.exe"
$wav = "$env:TEMP\gr-diag2.wav"
& $ff -y -f dshow -i 'audio=CABLE Output (VB-Audio Virtual Cable)' -t 3 -acodec pcm_s16le -ar 48000 -ac 2 $wav 2>$null
if (Test-Path $wav) {
  $b = [IO.File]::ReadAllBytes($wav)
  $peak = 0
  for ($i = 44; $i -lt $b.Length; $i += 2) { $s = [Math]::Abs([BitConverter]::ToInt16($b, $i)); if ($s -gt $peak) { $peak = $s } }
  Write-Host "post-route peak=$peak"
}
