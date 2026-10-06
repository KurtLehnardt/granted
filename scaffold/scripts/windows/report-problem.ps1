# Granted -- "Report a problem" from the tray icon.
#
# Opens a pre-filled GitHub "new issue" page in the browser: the tail of the
# tray's server log, Granted's version, Windows version, model provider type
# and search mode -- all sanitized first. The user reviews it and submits it
# with their OWN GitHub account. Granted holds no GitHub token (one shipped in
# the app could be extracted and abused), and nothing is sent until the user
# presses Submit on GitHub.
#
# Sanitizing uses the same rules as the app: the list below MIRRORS
# scaffold/lib/errorLog/sanitize-rules.json (tests fail if they drift --
# scaffold's lib/errorLog/__tests__/psMirror.test.ts and the installer's
# reportProblem tests), plus the same home-folder / user-name / .env.local
# handling as lib/errorLog/sanitize.ts and lib/errorLog/server.ts.
#
#   report-problem.ps1 -LogPath <server log> [-ScaffoldDir <dir>]       open the issue page
#   report-problem.ps1 ... -PrintUrl                                    print the link instead (tests)
#   report-problem.ps1 -SanitizeFile <in> -OutFile <out> [-HomeDir ...] sanitize a file (tests)
param(
  [string]$LogPath,
  [string]$ScaffoldDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$TailLines = 80,
  [switch]$PrintUrl,
  [string]$SanitizeFile,
  [string]$OutFile,
  [string]$HomeDir = $env:USERPROFILE,
  [string]$UserName = $env:USERNAME,
  [int]$MaxLength = 7000
)

$ErrorActionPreference = "Stop"
$IssueNewUrl = "https://github.com/KurtLehnardt/granted/issues/new"

# --- the rules (MIRROR of scaffold/lib/errorLog/sanitize-rules.json "rules") --
$GrantedSanitizeRulesJson = @'
{
  "rules": [
    {"name":"anthropic-key","pattern":"sk-ant-[A-Za-z0-9_\\-]{6,}","flags":"","replacement":"[redacted-key]"},
    {"name":"sk-key","pattern":"\\bsk-[A-Za-z0-9_\\-]{12,}","flags":"","replacement":"[redacted-key]"},
    {"name":"google-key","pattern":"AIza[0-9A-Za-z_\\-]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"groq-key","pattern":"\\bgsk_[A-Za-z0-9]{12,}","flags":"","replacement":"[redacted-key]"},
    {"name":"xai-key","pattern":"\\bxai-[A-Za-z0-9]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"huggingface-token","pattern":"\\bhf_[A-Za-z0-9]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"github-token","pattern":"\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})","flags":"","replacement":"[redacted-key]"},
    {"name":"bearer-token","pattern":"(\\bbearer\\s+)[A-Za-z0-9._~+/=\\-]{6,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"basic-auth-header","pattern":"(\\bbasic\\s+)[A-Za-z0-9+/=]{12,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"url-credentials","pattern":"(\\b[a-z][a-z0-9+.\\-]{0,30}://)[^/\\s:@\"'<>]{1,256}:[^/\\s@\"'<>]{1,256}@","flags":"i","replacement":"$1[redacted]@"},
    {"name":"key-query-param","pattern":"([?&;](?:key|api_key|apikey|api-key|access_token|token|auth|sig|signature|password)=)[^&\\s\"'#<>]+","flags":"i","replacement":"$1[redacted]"},
    {"name":"key-header-or-field","pattern":"(\\b(?:x-api-key|x-goog-api-key|api[_\\-]?key|access[_\\-]?token|refresh[_\\-]?token|client[_\\-]?secret|password|passwd)[\"']?\\s*[:=]\\s*[\"']?)[^\\s\"'&,;}]{4,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"env-secret-assignment","pattern":"(\\b[A-Z0-9_]{0,60}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)\\s*=\\s*)[^\\s\"';,&]+","flags":"","replacement":"$1[redacted]"},
    {"name":"email","pattern":"[A-Za-z0-9._%+\\-]{1,64}@(?:[A-Za-z0-9\\-]{1,63}\\.){1,8}[A-Za-z]{2,24}\\b","flags":"","replacement":"[email]"},
    {"name":"windows-home","pattern":"\\b[A-Za-z]:[\\\\/]+(?:Users|Documents and Settings)[\\\\/]+[^\\\\/\\s\"'<>|:*?]+(?:(?: [^\\\\/\\s\"'<>|:*?]+){1,4}(?=[\\\\/]))?","flags":"i","replacement":"~"},
    {"name":"mac-home","pattern":"/Users/[^/\\s\"'<>:]+","flags":"","replacement":"~"},
    {"name":"linux-home","pattern":"/home/[^/\\s\"'<>:]+","flags":"","replacement":"~"}
  ]
}
'@
$GrantedSanitizeRules = ConvertFrom-Json $GrantedSanitizeRulesJson

# Same as lib/errorLog/server.ts: secret-named variables, or values that look like tokens.
$SecretName = '(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$'
$TokenLike = '^(?=.*[0-9])(?=.*[A-Za-z])[^\s]{16,}$'

function Get-EnvFileSecrets([string]$Text) {
  $out = @()
  if (-not $Text) { return $out }
  foreach ($raw in ($Text -split "\r?\n")) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $m = [regex]::Match($line, '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $m.Success) { continue }
    $value = $m.Groups[2].Value.Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if (-not $value) { continue }
    if ([regex]::IsMatch($m.Groups[1].Value, $SecretName, 'IgnoreCase') -or [regex]::IsMatch($value, $TokenLike)) { $out += $value }
  }
  return $out
}

# Same as homePattern() in lib/errorLog/sanitize.ts.
function Get-HomePattern([string]$HomeDir) {
  if (-not $HomeDir) { return $null }
  $parts = @(($HomeDir -replace '[\\/]+$', '') -split '[\\/]+')
  if (@($parts | Where-Object { $_ }).Count -lt 2) { return $null }
  return ((@($parts | ForEach-Object { [regex]::Escape($_) })) -join '[\\/]+') + '(?![A-Za-z0-9_\-])'
}

function ConvertTo-GrantedSanitized {
  param([string]$Text, [string]$HomeDir, [string]$UserName, [string[]]$Secrets)
  if (-not $Text) { return "" }
  try {
    $out = $Text
    $usable = @($Secrets | Where-Object { $_ -and $_.Trim().Length -ge 6 } | ForEach-Object { $_.Trim() } | Select-Object -Unique | Sort-Object -Property Length -Descending)
    foreach ($s in $usable) { $out = $out.Replace($s, "[redacted]") }
    $homePattern = Get-HomePattern $HomeDir
    if ($homePattern) { $out = [regex]::Replace($out, $homePattern, "~", 'IgnoreCase') }
    foreach ($r in $GrantedSanitizeRules.rules) {
      $opts = if ($r.flags -match "i") { [System.Text.RegularExpressions.RegexOptions]::IgnoreCase } else { [System.Text.RegularExpressions.RegexOptions]::None }
      $out = [regex]::Replace($out, $r.pattern, $r.replacement, $opts)
    }
    if ($UserName -and $UserName.Trim().Length -ge 3) {
      $userPattern = '(^|[^A-Za-z0-9_])' + [regex]::Escape($UserName.Trim()) + '(?![A-Za-z0-9_])'
      $out = [regex]::Replace($out, $userPattern, '$1[user]', 'IgnoreCase')
    }
    return $out
  } catch {
    return "[could not be sanitized]"
  }
}

function Read-TextOrNull([string]$Path) {
  try { if ($Path -and (Test-Path -LiteralPath $Path)) { return [System.IO.File]::ReadAllText($Path) } } catch { }
  return $null
}

function Get-GrantedSecrets([string]$ScaffoldDir) {
  $secrets = @(Get-EnvFileSecrets (Read-TextOrNull (Join-Path $ScaffoldDir ".env.local")))
  try {
    $cfg = Read-TextOrNull (Join-Path $ScaffoldDir "data\local\llm-config.json")
    if ($cfg) {
      $c = ConvertFrom-Json $cfg
      if ($c.cloud -and $c.cloud.keySource -and $c.cloud.keySource.key) { $secrets += [string]$c.cloud.keySource.key }
      if ($c.anthropicApiKey) { $secrets += [string]$c.anthropicApiKey }
    }
  } catch { }
  return $secrets
}

# --- test entry point: sanitize a file ----------------------------------------
if ($SanitizeFile) {
  $text = [System.IO.File]::ReadAllText($SanitizeFile, [System.Text.Encoding]::UTF8)
  $secrets = @(Get-GrantedSecrets $ScaffoldDir)
  $clean = ConvertTo-GrantedSanitized -Text $text -HomeDir $HomeDir -UserName $UserName -Secrets $secrets
  [System.IO.File]::WriteAllText($OutFile, $clean, (New-Object System.Text.UTF8Encoding $false))
  exit 0
}

# --- the report ---------------------------------------------------------------
function Get-GrantedContext([string]$ScaffoldDir) {
  $version = "unknown"
  try { $version = (ConvertFrom-Json (Read-TextOrNull (Join-Path $ScaffoldDir "package.json"))).version } catch { }
  $os = "Windows"
  try { $os = "win32 $([System.Environment]::OSVersion.Version) $(if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' })" } catch { }
  $envText = Read-TextOrNull (Join-Path $ScaffoldDir ".env.local")
  $envValue = {
    param($name)
    if (-not $envText) { return $null }
    $m = [regex]::Match($envText, "(?m)^\s*$name\s*=\s*[`"']?([^`"'\r\n]*)")
    if ($m.Success -and $m.Groups[1].Value.Trim()) { return $m.Groups[1].Value.Trim() } else { return $null }
  }
  $provider = $null
  try {
    $cfg = Read-TextOrNull (Join-Path $ScaffoldDir "data\local\llm-config.json")
    if ($cfg) {
      $c = ConvertFrom-Json $cfg
      if ($c.provider -eq "ollama") { $provider = "local (Ollama)" }
      elseif ($c.cloud -and $c.cloud.providerId) { $provider = "cloud ($($c.cloud.providerId))" }
      elseif ($c.provider) { $provider = "cloud" }
    }
  } catch { }
  if (-not $provider) {
    $p = & $envValue "LLM_PROVIDER"
    $provider = if (-not $p -or $p -eq "anthropic") { "cloud" } else { "local ($p)" }
  }
  $search = & $envValue "SEARCH_EMBEDDINGS"
  if (-not $search) { $search = "auto" }
  return @{ version = $version; os = $os; provider = $provider; search = $search }
}

function New-GrantedIssueBody([hashtable]$Context, [string[]]$Lines, [int]$Omitted) {
  $b = New-Object System.Collections.Generic.List[string]
  $b.Add("### What happened"); $b.Add("_Please describe what you were doing when this went wrong._"); $b.Add("")
  $b.Add("### Error ID"); $b.Add("_none_"); $b.Add("")
  $b.Add("### Environment")
  $b.Add("- Granted version: $($Context.version)")
  $b.Add("- Operating system: $($Context.os)")
  $b.Add("- Model provider: $($Context.provider)")
  $b.Add("- Search mode: $($Context.search)")
  $b.Add("- Reported from: tray")
  $b.Add("")
  $b.Add("### Recent errors")
  if ($Lines.Count -eq 0) { $b.Add("_The server log is empty._") }
  else {
    $b.Add("Last $($Lines.Count) line(s) of the server log:")
    $b.Add('```text'); foreach ($l in $Lines) { $b.Add(($l -replace '`{3,}', "'''")) }; $b.Add('```')
  }
  if ($Omitted -gt 0) {
    $b.Add("")
    $b.Add("_$Omitted earlier line(s) were left out to keep this link short. The tray's Show log opens the whole log, if you'd like to paste more here._")
  }
  $b.Add("")
  $b.Add("_API keys, email addresses and your user folder were removed automatically. Please check nothing private is left before you submit._")
  return ($b -join "`n")
}

function New-GrantedIssueUrl([hashtable]$Context, [string[]]$Lines, [int]$MaxLength) {
  $title = [uri]::EscapeDataString("Problem (tray): Granted's server log")
  $lines = @($Lines | ForEach-Object { if ($_.Length -gt 500) { $_.Substring(0, 499) + "..." } else { $_ } })
  for ($skip = 0; $skip -le $lines.Count; $skip++) {
    $keep = if ($skip -lt $lines.Count) { @($lines[$skip..($lines.Count - 1)]) } else { @() }
    $body = New-GrantedIssueBody $Context $keep $skip
    if ($body.Length -gt 30000) { continue }   # EscapeDataString's limit; a shorter tail comes next
    $url = "${IssueNewUrl}?title=$title&labels=bug&body=$([uri]::EscapeDataString($body))"
    if ($url.Length -le $MaxLength) { return $url }
  }
  return "${IssueNewUrl}?title=$title&labels=bug"
}

$secrets = @(Get-GrantedSecrets $ScaffoldDir)
$tail = @()
if ($LogPath -and (Test-Path -LiteralPath $LogPath)) {
  try { $tail = @(Get-Content -LiteralPath $LogPath -Tail $TailLines -ErrorAction Stop) } catch { $tail = @() }
}
$clean = @($tail | ForEach-Object { ConvertTo-GrantedSanitized -Text ([string]$_) -HomeDir $HomeDir -UserName $UserName -Secrets $secrets } | Where-Object { $_ -ne $null })
$context = Get-GrantedContext $ScaffoldDir
foreach ($k in @($context.Keys)) { $context[$k] = ConvertTo-GrantedSanitized -Text ([string]$context[$k]) -HomeDir $HomeDir -UserName $UserName -Secrets $secrets }
$url = New-GrantedIssueUrl $context $clean $MaxLength

if ($PrintUrl) { Write-Output $url; exit 0 }
Start-Process $url
