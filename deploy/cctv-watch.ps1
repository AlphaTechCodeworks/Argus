# The outside watcher: reports what the CCTV server cannot report about itself.
# Dot-sourced by cctv-keepalive.ps1 and called once a minute.
#
# It alerts when the server has not answered /healthz for 3 minutes, when the recording drive is
# not attached, and once after a Windows restart. It clears each one when it recovers. It uses the
# same phone push and email settings as the server, cached on the Windows side so it still works
# when Ubuntu is down.
#
# Windows PowerShell 5.1 only: no ternary, no ?? and no && / || chain operators.
#
# Two rules hold everywhere below:
#   * nothing here may throw into the keep-alive loop, so every risky call is wrapped; and
#   * the email password and the ntfy topic are never written to a log or to the console, because
#     the keep-alive's transcript is a plain file on the test PC.

# Only initialise once. The keep-alive may dot-source this file again (for instance after an edit),
# and a fresh hashtable would forget that an alert was already sent and repeat it.
# Test-Path is used rather than reading the variable, because under Set-StrictMode reading a
# variable that does not exist yet is itself an error.
if (-not (Test-Path 'variable:script:CctvWatchState')) {
  $script:CctvWatchState = @{
    down      = $null   # when the server first failed to answer
    downSent  = $false  # whether the "not answering" alert has gone out for this outage
    drive     = $null   # when the recording drive first went missing
    booted    = $false  # whether the after-restart check has run in this process
    targetsAt = [datetime]::MinValue
  }
}

function Get-CctvTargets {
  param($Distro = 'Ubuntu-24.04')

  $cache = 'C:\ProgramData\cctv-test\alert-targets.json'

  # Refresh from the server at most every ten minutes. The rest of the time we read the Windows-side
  # copy, which is the whole point: when Ubuntu is down there is nothing to read from it.
  $age = (Get-Date) - $script:CctvWatchState.targetsAt
  if ($age -gt [timespan]::FromMinutes(10)) {
    # Mark the attempt before making it, so a hanging or failing wsl.exe cannot turn this into a
    # retry on every single tick.
    $script:CctvWatchState.targetsAt = Get-Date
    try {
      $raw = (& wsl.exe -d $Distro -u root -- cat /var/lib/cctv/alert-targets.json 2>$null | Out-String)
      # wsl.exe can hand back UTF-16 with a byte-order mark; ConvertFrom-Json rejects a leading BOM.
      $raw = $raw -replace "`0", '' -replace "^\xEF\xBB\xBF", ''
      $raw = $raw.Trim([char]0xFEFF).Trim()
      if ($raw -match '^\{') {
        $dir = Split-Path -Parent $cache
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # The file holds the email password, so it is written for administrators only.
        Set-Content -Path $cache -Value $raw -Encoding utf8
        & icacls $cache /inheritance:r /grant:r "Administrators:(F)" "SYSTEM:(F)" 2>$null | Out-Null
      }
    } catch {
      # Deliberately silent: the exception text can quote the file's contents.
    }
  }

  if (Test-Path $cache) {
    try {
      $text = (Get-Content -Raw $cache).Trim([char]0xFEFF).Trim()
      if (-not $text) { return $null }
      $parsed = $text | ConvertFrom-Json
      # A JSON array parses happily but has no ntfy/email members, and reading a missing member off
      # one throws under Set-StrictMode. Anything else is handled by Get-CctvField.
      if ($parsed -is [array]) { return $null }
      return $parsed
    } catch {
      return $null
    }
  }
  return $null
}

# Read a member without caring whether it, or its parent, exists. Set-StrictMode (which the
# keep-alive may have switched on) turns a missing member into a terminating error, and a malformed
# targets file must never take the watcher down.
function Get-CctvField {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  try {
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
  } catch {
    return $null
  }
}

function Send-CctvAlert {
  param([string]$Title, [string]$Body, [string]$Priority = 'high')

  # One outer guard: a failure to warn must never become a failure of the keep-alive.
  try {
    $t = $null
    try { $t = Get-CctvTargets } catch { $t = $null }
    if ($null -eq $t) { return }

    $ntfy = Get-CctvField $t 'ntfy'
    $topic = Get-CctvField $ntfy 'topic'
    $base = Get-CctvField $ntfy 'url'
    if ($topic -and $base) {
      try {
        # PowerShell 5.1 still negotiates TLS 1.0 by default, which ntfy.sh and most hosts refuse.
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      } catch {}
      # The topic is the shared secret for ntfy, so the URL is built here and never printed.
      $url = ([string]$base).TrimEnd('/') + '/' + [string]$topic
      try {
        Invoke-RestMethod -Uri $url -Method Post -Body $Body -Headers @{ Title = $Title; Priority = $Priority } -TimeoutSec 15 | Out-Null
      } catch {}
    }

    $email = Get-CctvField $t 'email'
    $host_ = Get-CctvField $email 'host'
    $to = Get-CctvField $email 'to'
    $from = Get-CctvField $email 'from'
    if ($host_ -and $to -and $from) {
      $client = $null
      $message = $null
      try {
        $port = Get-CctvField $email 'port'
        if (-not $port) { $port = 587 }
        $client = New-Object Net.Mail.SmtpClient([string]$host_, [int]$port)
        $secure = Get-CctvField $email 'secure'
        # Absent means "use STARTTLS", which is what EnableSsl does for port 587.
        if ($null -eq $secure) { $client.EnableSsl = $true } else { $client.EnableSsl = [bool]$secure }
        $user = Get-CctvField $email 'user'
        if ($user) {
          $pass = Get-CctvField $email 'pass'
          $client.Credentials = New-Object Net.NetworkCredential([string]$user, [string]$pass)
        }
        $message = New-Object Net.Mail.MailMessage
        $message.From = New-Object Net.Mail.MailAddress([string]$from)
        # "to" may be one address or a list; @() makes both behave the same.
        foreach ($addr in @($to)) {
          if ($addr) { $message.To.Add([string]$addr) }
        }
        if ($message.To.Count -gt 0) {
          $message.Subject = $Title
          $message.Body = $Body
          $client.Send($message)
        }
      } catch {
        # Silent on purpose: an SMTP exception can echo the credentials we just handed it.
      } finally {
        if ($message) { try { $message.Dispose() } catch {} }
        if ($client) { try { $client.Dispose() } catch {} }
      }
    }
  } catch {}
}

function Test-CctvServer {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8080/healthz
    return ($r.Content -match '"ok":true')
  } catch {
    return $false
  }
}

# One check. Call once a minute from the keep-alive loop.
function Invoke-CctvWatch {
  param($Distro = 'Ubuntu-24.04', $Serial = 'WX81EC526UT4')

  # The keep-alive loop runs unattended for weeks; it must survive anything that happens in here.
  try {

    if (-not $script:CctvWatchState.booted) {
      $script:CctvWatchState.booted = $true
      try {
        $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
        if ($boot -and ((Get-Date) - $boot -lt [timespan]::FromMinutes(10))) {
          Send-CctvAlert -Title 'CCTV: the test PC restarted' -Body ("Windows started at {0:HH:mm}. The server should come back within a minute." -f $boot) -Priority 'high'
        }
      } catch {}
    }

    # the server
    $up = Test-CctvServer
    if ($up) {
      # Only say it is back if we said it was gone. A blip shorter than three minutes never
      # reached the phone, so a recovery message for it would be noise.
      if ($script:CctvWatchState.downSent) {
        Send-CctvAlert -Title 'CCTV: the server is back' -Body ('It was not answering from {0:HH:mm}.' -f $script:CctvWatchState.down) -Priority 'default'
      }
      $script:CctvWatchState.down = $null
      $script:CctvWatchState.downSent = $false
    } else {
      if (-not $script:CctvWatchState.down) {
        $script:CctvWatchState.down = Get-Date
      } elseif (((Get-Date) - $script:CctvWatchState.down -ge [timespan]::FromMinutes(3)) -and (-not $script:CctvWatchState.downSent)) {
        $script:CctvWatchState.downSent = $true
        Send-CctvAlert -Title 'CCTV: the server is not answering' -Body ('Nothing on http://127.0.0.1:8080/healthz since {0:HH:mm}. Nothing is being recorded.' -f $script:CctvWatchState.down)
      }
    }

    # the recording drive. An empty or failed reply means "cannot tell" (Ubuntu itself may be
    # down), which is not the same as "missing", so only a definite 0 opens the alert.
    $count = ''
    try {
      $raw = (& wsl.exe -d $Distro -u root -- bash -c "lsblk -dno SERIAL | grep -c '^$Serial`$'; true" 2>$null | Out-String)
      $count = ($raw -replace "`0", '').Trim()
    } catch {
      $count = ''
    }
    if ($count -match '^\s*0\s*$') {
      if (-not $script:CctvWatchState.drive) {
        $script:CctvWatchState.drive = Get-Date
        Send-CctvAlert -Title 'CCTV: the recording drive is not attached' -Body 'The keep-alive will try to attach it. If this repeats, check the USB cable.'
      }
    } elseif ($count -match '^\s*[1-9][0-9]*\s*$') {
      if ($script:CctvWatchState.drive) {
        Send-CctvAlert -Title 'CCTV: the recording drive is back' -Body 'Recording has resumed.' -Priority 'default'
        $script:CctvWatchState.drive = $null
      }
    }

  } catch {
    # Last resort. Swallowing beats stopping the keep-alive, and the message could contain settings.
  }
}
