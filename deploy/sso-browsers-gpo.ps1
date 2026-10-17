# Argus single sign-on: tell the browsers on the office PCs that Argus may use their Windows sign-in.
# Run this ONCE on DC01, after sso-setup-dc.ps1.
#
# Why: Edge, Chrome and Firefox only hand a website the PC's Windows sign-in when they are told that
# website is "ours". This script makes a Group Policy called "Argus single sign-on", linked to the
# whole domain, that tells them so for https://cctv.jfl.gripe and for nothing else:
#   - puts https://cctv.jfl.gripe in the "Local intranet" zone (Windows' own list, which Edge and
#     Chrome follow);
#   - Edge and Chrome: AuthServerAllowlist = cctv.jfl.gripe;
#   - Firefox: its single sign-on list (Authentication > SPNEGO) = cctv.jfl.gripe.
#
# How to run it:
#   1. Copy this file to DC01.
#   2. Right-click the Start button, choose "Windows PowerShell (Admin)" or "Terminal (Admin)".
#   3. Type:   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\sso-browsers-gpo.ps1"
#      and press Enter.
#   The office PCs pick it up by themselves within about 90 minutes, or at their next restart. To see
#   it at once on one PC: open a Command Prompt there and type  gpupdate /force , then restart the
#   browser.
#
# Safe to run again: it only adds what is missing. To undo it: in "Group Policy Management", delete
# the policy "Argus single sign-on".
#
# Edge and Chrome on Windows already sign in automatically to sites in the Local intranet zone, so
# step 1 is enough and is all this script does by default. It does NOT set AuthServerAllowlist unless
# asked with -SetAllowlist: that list REPLACES the browsers' own choice of which sites may have the
# Windows sign-in, so any other company website that signs people in automatically today would start
# asking for a password unless it is listed too (-AlsoAllow 'intranet.jfl.local,*.jfl.local').

#Requires -RunAsAdministrator
param(
  [string]$HostName = 'cctv.jfl.gripe',
  [string]$GpoName = 'Argus single sign-on',
  [string]$AlsoAllow = '',
  [switch]$SetAllowlist
)

$ErrorActionPreference = 'Stop'

function Stop-With($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Send a photo of this window to whoever set up Argus.'
  exit 1
}

try {
  Import-Module GroupPolicy
  Import-Module ActiveDirectory
} catch {
  Stop-With 'The Group Policy tools are not on this computer. Run this on the domain controller (DC01).'
}

$site = "https://$HostName"
$domainDn = (Get-ADDomain).DistinguishedName

# ---- the policy ----------------------------------------------------------------------------------
$gpo = Get-GPO -Name $GpoName -ErrorAction SilentlyContinue
if (-not $gpo) {
  Write-Host "Making the Group Policy ""$GpoName"" ..."
  $gpo = New-GPO -Name $GpoName -Comment "Lets Edge, Chrome and Firefox sign people in to Argus ($site) with their Windows sign-in. Made by sso-browsers-gpo.ps1."
} else {
  Write-Host "The Group Policy ""$GpoName"" is already there: updating it."
}
# only computer settings are used: the user half can be off (it makes policy processing a bit faster)
$gpo.GpoStatus = 'UserSettingsDisabled'

# ---- 1. Local intranet zone (Site to Zone Assignment List): value name = the site, data "1" ------
$zoneKey = 'HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMapKey'
Set-GPRegistryValue -Guid $gpo.Id -Key $zoneKey -ValueName $site -Type String -Value '1' | Out-Null
# the switch that says "the list is set by policy" (what the Group Policy editor itself writes)
Set-GPRegistryValue -Guid $gpo.Id -Key 'HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings' -ValueName 'ListBox_Support_ZoneMapKey' -Type DWord -Value 1 | Out-Null
Write-Host "1. $site is in the Local intranet zone."

# ---- 2. Edge and Chrome: AuthServerAllowlist (comma-separated), keeping what this policy had ------
function Merge-List([string]$old, [string[]]$add) {
  $items = @()
  foreach ($x in (($old -split ',') + $add)) {
    $t = $x.Trim()
    if ($t -and -not ($items -contains $t)) { $items += $t }
  }
  return ($items -join ',')
}
$wanted = @($HostName) + @($AlsoAllow -split ',' | Where-Object { $_.Trim() })
foreach ($browser in @(if ($SetAllowlist) { 'HKLM\SOFTWARE\Policies\Microsoft\Edge', 'HKLM\SOFTWARE\Policies\Google\Chrome' } else { Write-Host '2. Edge and Chrome: no allow list set (the Local intranet zone above is enough; use -SetAllowlist to set one)' })) {
  $old = ''
  try { $old = (Get-GPRegistryValue -Guid $gpo.Id -Key $browser -ValueName 'AuthServerAllowlist' -ErrorAction Stop).Value } catch {}
  $value = Merge-List $old $wanted
  Set-GPRegistryValue -Guid $gpo.Id -Key $browser -ValueName 'AuthServerAllowlist' -Type String -Value $value | Out-Null
  Write-Host "2. $(Split-Path $browser -Leaf): AuthServerAllowlist = $value"
}

# ---- 3. Firefox: Authentication > SPNEGO (a numbered list) -----------------------------------------
$ffKey = 'HKLM\SOFTWARE\Policies\Mozilla\Firefox\Authentication\SPNEGO'
$have = @()
try { $have = @(Get-GPRegistryValue -Guid $gpo.Id -Key $ffKey -ErrorAction Stop | ForEach-Object { $_.Value }) } catch {}
$n = $have.Count
foreach ($h in $wanted) {
  if (-not ($have -contains $h)) {
    $n++
    Set-GPRegistryValue -Guid $gpo.Id -Key $ffKey -ValueName "$n" -Type String -Value $h | Out-Null
  }
}
Write-Host "3. Firefox: single sign-on allowed for $($wanted -join ', ')."

# ---- linked to the whole domain --------------------------------------------------------------------
$linked = (Get-GPInheritance -Target $domainDn).GpoLinks | Where-Object { $_.DisplayName -eq $GpoName }
if (-not $linked) {
  New-GPLink -Guid $gpo.Id -Target $domainDn -LinkEnabled Yes | Out-Null
  Write-Host "Linked to the domain ($domainDn)."
} else {
  Write-Host "Already linked to the domain ($domainDn)."
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Office PCs pick this up within about 90 minutes or at their next restart (or now: gpupdate /force on the PC, then restart the browser).'
Write-Host "Then, on an office PC signed in to the domain, open $site : it should sign in by itself."
