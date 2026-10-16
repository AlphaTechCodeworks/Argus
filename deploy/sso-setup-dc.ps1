# Argus single sign-on: the domain controller side. Run this ONCE on DC01.
#
# What it is for: with it, people at office Windows PCs open Argus (https://cctv.jfl.gripe) and are
# signed in as themselves, without typing their password. Windows does this with "Kerberos": the PC
# asks the domain controller for a ticket for Argus, and Argus checks the ticket with a secret key.
# This script makes that key and saves it in a small file, C:\argus-sso.keytab, which you then
# upload in Argus.
#
# How to run it:
#   1. Copy this file to DC01 (for example to the Desktop).
#   2. Right-click the Start button, choose "Windows PowerShell (Admin)" or "Terminal (Admin)".
#   3. Type:   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\sso-setup-dc.ps1"
#      and press Enter.
#   4. When it says "Done", open Argus > Settings > Active Directory > Single sign-on (Windows),
#      upload C:\argus-sso.keytab, then DELETE C:\argus-sso.keytab from DC01 (it is a secret).
#   5. Run sso-browsers-gpo.ps1 too (once), so Edge and Chrome on the office PCs use it.
#
# What it does, step by step (it is safe to run again: each step checks first):
#   - makes a Windows account "svc-argus-sso" just for this (or reuses it): a long random password
#     that nobody needs to know, never expires, cannot be changed by the account, AES encryption only
#     (no old RC4/DES);
#   - registers the name Argus is reached by (HTTP/cctv.jfl.gripe) on that account;
#   - runs Windows' own "ktpass" tool to write the key file. ktpass sets the account's password again
#     (to the same random one) and that makes a new key: running this script again therefore makes
#     the OLD key file stop working, so upload the new file in Argus each time you run it.
#
# Nothing else on the domain is changed. To undo it all: delete the account svc-argus-sso in
# "Active Directory Users and Computers", and remove the keytab in Argus.

#Requires -RunAsAdministrator
param(
  [string]$HostName = 'cctv.jfl.gripe',
  [string]$AccountName = 'svc-argus-sso',
  [string]$OutFile = 'C:\argus-sso.keytab'
)

$ErrorActionPreference = 'Stop'

function Say($text) { Write-Host $text }
function Stop-With($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Nothing more was changed. Send a photo of this window to whoever set up Argus.'
  exit 1
}

try {
  Import-Module ActiveDirectory
} catch {
  Stop-With 'The Active Directory tools are not on this computer. Run this on the domain controller (DC01).'
}

$domain = Get-ADDomain
$realm = $domain.DNSRoot.ToUpper()       # JFL.LOCAL
$netbios = $domain.NetBIOSName           # JFL
$spn = "HTTP/$HostName"
$principal = "$spn@$realm"               # HTTP/cctv.jfl.gripe@JFL.LOCAL

Say "Domain: $realm ($netbios)"
Say "Service name for Argus: $principal"
Say ''

# ---- a long random password (letters, digits and a few symbols that need no quoting) --------------
function New-StrongPassword([int]$Length = 40) {
  $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  $lower = 'abcdefghijkmnopqrstuvwxyz'
  $digit = '23456789'
  $symbol = '-_.+=#!'
  $all = $upper + $lower + $digit + $symbol
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] ($Length * 2)
  do {
    $rng.GetBytes($bytes)
    $chars = for ($i = 0; $i -lt $Length; $i++) { $all[$bytes[$i] % $all.Length] }
    $pw = -join $chars
  } until ($pw -cmatch '[A-Z]' -and $pw -cmatch '[a-z]' -and $pw -match '[0-9]' -and $pw -match '[-_.+=#!]')
  return $pw
}
$password = New-StrongPassword
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force

# ---- 1. the service account ---------------------------------------------------------------------
$user = Get-ADUser -Filter "SamAccountName -eq '$AccountName'" -Properties servicePrincipalName
if (-not $user) {
  Say "1. Making the account $netbios\$AccountName ..."
  New-ADUser -Name $AccountName -SamAccountName $AccountName `
    -Description 'Argus CCTV single sign-on (Kerberos). Made by sso-setup-dc.ps1. Do not use it to sign in; do not reset its password (that stops single sign-on until a new keytab is uploaded).' `
    -AccountPassword $securePassword -Enabled $true `
    -PasswordNeverExpires $true -CannotChangePassword $true
  $user = Get-ADUser -Identity $AccountName -Properties servicePrincipalName
} else {
  Say "1. The account $netbios\$AccountName is already there: using it."
  Set-ADUser -Identity $user -PasswordNeverExpires $true -CannotChangePassword $true
  Enable-ADAccount -Identity $user
}
# AES only: 8 = AES128, 16 = AES256, together 24. Without this Windows may still use RC4 for it.
Set-ADUser -Identity $user -Replace @{ 'msDS-SupportedEncryptionTypes' = 24 }
Say '   AES encryption only (msDS-SupportedEncryptionTypes = 24), password never expires, cannot be changed by the account.'

# ---- 2. the service name (SPN) -------------------------------------------------------------------
Say "2. Registering $spn on $netbios\$AccountName ..."
$holders = @(Get-ADObject -LDAPFilter "(servicePrincipalName=$spn)" -Properties sAMAccountName)
$elsewhere = @($holders | Where-Object { $_.sAMAccountName -ne $AccountName })
if ($elsewhere.Count -gt 0) {
  Stop-With "$spn is already registered on another account: $(($elsewhere | ForEach-Object { $_.sAMAccountName }) -join ', '). It can only be on one. Remove it there first (setspn -D $spn <that account>), then run this again."
}
if ($holders.Count -gt 0) {
  Say '   Already registered on this account.'
} else {
  & setspn.exe -S $spn "$netbios\$AccountName"
  if ($LASTEXITCODE -ne 0) { Stop-With "setspn could not register $spn (exit code $LASTEXITCODE)." }
}

# ---- 3. the key file (ktpass) --------------------------------------------------------------------
Say "3. Writing the key file $OutFile with ktpass (AES-256 only) ..."
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
# /princ     the service name, with the realm in capitals
# /mapuser   the account it belongs to; ktpass also sets that account's logon name to /princ, which
#            is what makes Windows' key and the file's key the same (the "salt")
# /crypto    AES256-SHA1 only     /ptype KRB5_NT_PRINCIPAL, as Kerberos services use
# /pass      sets the account's password to this random one and makes the key from it
& ktpass.exe /out $OutFile /princ $principal /mapuser "$netbios\$AccountName" /crypto AES256-SHA1 /ptype KRB5_NT_PRINCIPAL /pass $password
$ktpassExit = $LASTEXITCODE
$password = $null
$securePassword = $null
if ($ktpassExit -ne 0 -or -not (Test-Path $OutFile)) { Stop-With "ktpass did not write the key file (exit code $ktpassExit)." }

# make sure the account still has AES only and is not marked DES-only (ktpass can change these)
Set-ADUser -Identity $AccountName -Replace @{ 'msDS-SupportedEncryptionTypes' = 24 }
Set-ADAccountControl -Identity $AccountName -UseDESKeyOnly $false

# let the other domain controller learn the new key now rather than in a few minutes
try {
  & repadmin.exe /syncall /AdeP | Out-Null
  Say '   Told the other domain controllers about the new key.'
} catch {
  Say '   (Could not ask the other domain controllers to update now; they will within about 15 minutes.)'
}

# only Administrators and SYSTEM may read the key file while it is here
try {
  & icacls.exe $OutFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
} catch {}

$kvno = (Get-ADUser -Identity $AccountName -Properties 'msDS-KeyVersionNumber').'msDS-KeyVersionNumber'
Say ''
Write-Host 'Done.' -ForegroundColor Green
Say "The key file is:  $OutFile   (key version $kvno)"
Say ''
Say 'Now:'
Say '  a. In Argus: Settings > Active Directory > Single sign-on (Windows) > choose that file > Upload keytab.'
Say "     Argus should show $principal  aes256-cts-hmac-sha1-96  key version $kvno."
Say "  b. DELETE $OutFile from this computer (and from wherever you copied it). It is a secret."
Say '  c. Run sso-browsers-gpo.ps1 once (if you have not already), then tick "Sign office Windows PCs in automatically" in Argus.'
Say ''
Say 'If you ever run this script again, upload the new file in Argus: the old one stops working.'
