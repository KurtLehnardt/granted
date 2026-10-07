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

# --- the rules (MIRROR of scaffold/lib/errorLog/sanitize-rules.json, all but $comment) --
$GrantedSanitizeRulesJson = @'
{
  "secretEnvName": "(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$",
  "settingEnvName": "(_URL|_MODEL|_PROVIDER|_MODE|_DIMENSIONS|_PORT|_HOST)$|^(SEARCH|NEXT_PUBLIC|LLM|LOCAL|OLLAMA)_",
  "tokenLikeValue": "^(?=.*[0-9])(?=.*[A-Za-z])[^\\s]{16,}$",
  "publicHosts": ["api.anthropic.com","api.openai.com","generativelanguage.googleapis.com","openrouter.ai","api.groq.com","api.mistral.ai","api.x.ai","api.together.xyz","api.deepseek.com","api.fireworks.ai","github.com","api.github.com","huggingface.co","registry.npmjs.org","nodejs.org","aka.ms"],
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
    {"name":"authorization-header","pattern":"(\\b(?:proxy-)?authorization[\"']?\\s*[:=]\\s*[\"']?(?:(?:token|apikey|api-key|key|bearer|basic|digest)\\s+)?)(?!(?:token|apikey|api-key|key|bearer|basic|digest)(?:\\s|$))[^\\s\"'&,;}\\[]{4,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"url-credentials","pattern":"(\\b[a-z][a-z0-9+.\\-]{0,30}://)[^/\\s:@\"'<>]{1,256}:[^/\\s@\"'<>]{1,256}@","flags":"i","replacement":"$1[redacted]@"},
    {"name":"key-query-param","pattern":"([?&;](?:key|api_key|apikey|api-key|access_token|token|auth|sig|signature|password|secret)=)[^&\\s\"'#<>]+","flags":"i","replacement":"$1[redacted]"},
    {"name":"key-header-or-field","pattern":"(\\b(?:x-api-key|x-goog-api-key|api[_\\-]?key|api[_\\-]?secret|access[_\\-]?token|refresh[_\\-]?token|auth[_\\-]?token|id[_\\-]?token|client[_\\-]?secret|token|secret|password|passwd)[\"']?\\s*[:=]\\s*[\"']?)[^\\s\"'&,;}\\[]{4,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"env-secret-assignment","pattern":"(\\b[A-Z0-9_]{0,60}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)\\s*=\\s*)[^\\s\"';,&]+","flags":"","replacement":"$1[redacted]"},
    {"name":"email","pattern":"[A-Za-z0-9._%+\\-]{1,64}@(?:[A-Za-z0-9\\-]{1,63}\\.){1,8}[A-Za-z]{2,24}\\b","flags":"","replacement":"[email]"},
    {"name":"private-network-url-host","pattern":"(\\b[a-z][a-z0-9+.\\-]{0,30}://)[A-Za-z0-9\\-.]{1,200}\\.(?:local|lan|internal|intranet|corp|home|localdomain)\\b","flags":"i","replacement":"$1[private-host]"},
    {"name":"private-ipv4","pattern":"\\b(?:10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2})\\b","flags":"","replacement":"[private-host]"},
    {"name":"windows-home","pattern":"\\b[A-Za-z]:[\\\\/]+(?:Users|Documents and Settings)[\\\\/]+[^\\\\/\\s\"'<>|:*?]+(?:(?: [^\\\\/\\s\"'<>|:*?]+){1,4}(?=[\\\\/]))?","flags":"i","replacement":"~"},
    {"name":"mac-home","pattern":"/Users/[^/\\s\"'<>:]+","flags":"","replacement":"~"},
    {"name":"linux-home","pattern":"/home/[^/\\s\"'<>:]+","flags":"","replacement":"~"},
    {"name":"onedrive-organization","pattern":"(\\bOneDrive) - [^\\\\/\"'<>|:*?\\r\\n]{1,100}?(?=[\\\\/\"'<>|:*?\\r\\n]|$)","flags":"","replacement":"$1"}
  ]
}
'@
$GrantedSanitize = ConvertFrom-Json $GrantedSanitizeRulesJson

# Same as lib/errorLog/server.ts (the patterns come from the shared settings above).
$SecretName = $GrantedSanitize.secretEnvName
$SettingName = $GrantedSanitize.settingEnvName
$TokenLike = $GrantedSanitize.tokenLikeValue
$FccDefaultKeyFile = "~/.fcc/proxy_auth_token"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-EnvFileEntries([string]$Text) {
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
    if ($value) { $out += ,@($m.Groups[1].Value, $value) }
  }
  return $out
}

# Same as isSecretEnv() in lib/errorLog/server.ts.
function Test-SecretEnv([string]$Name, [string]$Value) {
  if ([regex]::IsMatch($Name, $SecretName, 'IgnoreCase')) { return -not [regex]::IsMatch($Value, '^(true|false|\d+)$', 'IgnoreCase') }
  return (-not [regex]::IsMatch($Name, $SettingName, 'IgnoreCase')) -and [regex]::IsMatch($Value, $TokenLike)
}

function Get-EnvFileSecrets([string]$Text) {
  return @(Get-EnvFileEntries $Text | Where-Object { Test-SecretEnv $_[0] $_[1] } | ForEach-Object { $_[1] })
}

# Same as homePattern() in lib/errorLog/sanitize.ts.
function Get-HomePattern([string]$HomeDir) {
  if (-not $HomeDir) { return $null }
  $parts = @(($HomeDir -replace '[\\/]+$', '') -split '[\\/]+')
  if (@($parts | Where-Object { $_ }).Count -lt 2) { return $null }
  return ((@($parts | ForEach-Object { [regex]::Escape($_) })) -join '[\\/]+') + '(?![A-Za-z0-9_\-])'
}

# Same as isLoopbackHost() / privateHosts() in lib/errorLog/sanitize.ts.
function Test-LoopbackHost([string]$HostName) {
  $h = $HostName.ToLowerInvariant().Trim('[', ']')
  return $h -eq "localhost" -or $h -eq "::1" -or $h -eq "0.0.0.0" -or [regex]::IsMatch($h, '^127\.\d+\.\d+\.\d+$')
}
function Get-PrivateHosts([string[]]$Urls) {
  $out = @()
  foreach ($u in $Urls) {
    if (-not $u -or -not $u.Trim()) { continue }
    $t = $u.Trim()
    if (-not [regex]::IsMatch($t, '^[a-z][a-z0-9+.-]*://', 'IgnoreCase')) { $t = "http://$t" }
    $uri = $null
    if (-not [System.Uri]::TryCreate($t, [System.UriKind]::Absolute, [ref]$uri)) { continue }
    $h = $uri.Host.ToLowerInvariant().Trim('[', ']')
    if (-not $h -or (Test-LoopbackHost $h)) { continue }
    $public = $false
    foreach ($p in $GrantedSanitize.publicHosts) { if ($h -eq $p -or $h.EndsWith(".$p")) { $public = $true; break } }
    if (-not $public -and $out -notcontains $h) { $out += $h }
  }
  return $out
}

function ConvertTo-GrantedSanitized {
  param([string]$Text, [string]$HomeDir, [string]$UserName, [string[]]$Secrets, [string[]]$Hosts)
  if (-not $Text) { return "" }
  try {
    $out = $Text
    $usable = @($Secrets | Where-Object { $_ -and $_.Trim().Length -ge 6 } | ForEach-Object { $_.Trim() } | Select-Object -Unique | Sort-Object -Property Length -Descending)
    foreach ($s in $usable) { $out = $out.Replace($s, "[redacted]") }
    $hostList = @($Hosts | Where-Object { $_ -and $_.Trim().Length -ge 3 } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Select-Object -Unique | Sort-Object -Property Length -Descending)
    foreach ($h in $hostList) {
      $out = [regex]::Replace($out, '(^|[^A-Za-z0-9.\-])' + [regex]::Escape($h) + '(?![A-Za-z0-9\-]|\.[A-Za-z0-9])', '$1[private-host]', 'IgnoreCase')
    }
    $homePattern = Get-HomePattern $HomeDir
    if ($homePattern) { $out = [regex]::Replace($out, $homePattern, "~", 'IgnoreCase') }
    foreach ($r in $GrantedSanitize.rules) {
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

# Always as UTF-8: Windows PowerShell 5.1 otherwise reads BOM-less files as ANSI,
# and a non-ASCII user name or folder (an accented name) would no longer match -- and escape redaction.
function Read-TextOrNull([string]$Path) {
  try { if ($Path -and (Test-Path -LiteralPath $Path)) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) } } catch { }
  return $null
}

function Expand-HomePath([string]$Path) {
  if ($Path -eq "~") { return $HomeDir }
  if ($Path.StartsWith("~/") -or $Path.StartsWith("~\")) { return (Join-Path $HomeDir $Path.Substring(2)) }
  return $Path
}

# Every non-empty line of a small key file (same as keyFileLines() in server.ts).
function Get-KeyFileLines([string]$Path) {
  try {
    $p = Expand-HomePath $Path
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return @() }
    if ((Get-Item -LiteralPath $p).Length -gt 8192) { return @() }
    return @((Read-TextOrNull $p) -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  } catch { return @() }
}

function Get-LlmConfig([string]$ScaffoldDir) {
  try { $cfg = Read-TextOrNull (Join-Path $ScaffoldDir "data\local\llm-config.json"); if ($cfg) { return (ConvertFrom-Json $cfg) } } catch { }
  return $null
}

# Same sources as serverSanitizeContext() in lib/errorLog/server.ts: .env.local,
# secret-named environment variables, the cloud key WHATEVER its source (inline,
# any env var, a key file), fcc's default key file, and private base-URL hosts.
function Get-GrantedSanitizeContext([string]$ScaffoldDir) {
  $secrets = @()
  $urls = @()
  $entries = @(Get-EnvFileEntries (Read-TextOrNull (Join-Path $ScaffoldDir ".env.local")))
  foreach ($e in $entries) {
    if (Test-SecretEnv $e[0] $e[1]) { $secrets += $e[1] }
    if ($e[0] -match '_URL$' -or $e[1] -match '^https?://') { $urls += $e[1] }
  }
  foreach ($v in (Get-ChildItem env:)) {
    if (-not $v.Value) { continue }
    if ([regex]::IsMatch($v.Name, $SecretName, 'IgnoreCase') -and -not [regex]::IsMatch($v.Value, '^(true|false|\d+)$', 'IgnoreCase')) { $secrets += $v.Value }
    if ($v.Name -match '_BASE_URL$') { $urls += $v.Value }
  }
  $c = Get-LlmConfig $ScaffoldDir
  if ($c) {
    if ($c.cloud -and $c.cloud.keySource) {
      $ks = $c.cloud.keySource
      if ($ks.type -eq "inline" -and $ks.key) { $secrets += [string]$ks.key }
      if ($ks.type -eq "env" -and $ks.name) {
        $fromEnv = [System.Environment]::GetEnvironmentVariable([string]$ks.name)
        if ($fromEnv) { $secrets += $fromEnv }
        foreach ($e in $entries) { if ($e[0] -eq $ks.name) { $secrets += $e[1] } }
      }
      if ($ks.type -eq "file" -and $ks.path) { $secrets += @(Get-KeyFileLines ([string]$ks.path)) }
    }
    if ($c.cloud -and $c.cloud.baseUrl) { $urls += [string]$c.cloud.baseUrl }
    if ($c.anthropicApiKey) { $secrets += [string]$c.anthropicApiKey }
  }
  $secrets += @(Get-KeyFileLines $FccDefaultKeyFile)
  return @{ secrets = $secrets; hosts = @(Get-PrivateHosts $urls) }
}

function ConvertTo-ReportText([string]$Text, [hashtable]$Ctx) {
  return ConvertTo-GrantedSanitized -Text $Text -HomeDir $HomeDir -UserName $UserName -Secrets $Ctx.secrets -Hosts $Ctx.hosts
}

# --- test entry point: sanitize a file ----------------------------------------
if ($SanitizeFile) {
  $ctx = Get-GrantedSanitizeContext $ScaffoldDir
  $clean = ConvertTo-ReportText ([System.IO.File]::ReadAllText($SanitizeFile, [System.Text.Encoding]::UTF8)) $ctx
  [System.IO.File]::WriteAllText($OutFile, $clean, $Utf8NoBom)
  exit 0
}

# --- the report ---------------------------------------------------------------
# The same words the app's report uses (lib/errorLog/context.ts): the provider
# TYPE (never a key) and the search mode actually in effect (scripts/lib/spaces.mjs).
function Get-GrantedContext([string]$ScaffoldDir) {
  $version = "unknown"
  try { $version = (ConvertFrom-Json (Read-TextOrNull (Join-Path $ScaffoldDir "package.json"))).version } catch { }
  $os = "win32"
  try { $os = "win32 $([System.Environment]::OSVersion.Version) $(if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' })" } catch { }
  $envMap = @{}
  foreach ($e in @(Get-EnvFileEntries (Read-TextOrNull (Join-Path $ScaffoldDir ".env.local")))) { $envMap[$e[0]] = $e[1] }
  $getEnv = { param($name) if ($envMap.ContainsKey($name)) { return $envMap[$name] } else { return [System.Environment]::GetEnvironmentVariable($name) } }
  $c = Get-LlmConfig $ScaffoldDir

  # resolveProvider(): the Settings file wins, else LLM_PROVIDER (unset/anthropic = cloud).
  $local = $false
  if ($c -and $c.provider -eq "ollama") { $local = $true }
  elseif ($c -and ($c.provider -eq "cloud" -or $c.provider -eq "anthropic")) { $local = $false }
  else { $p = [string](& $getEnv "LLM_PROVIDER"); $local = -not (-not $p -or $p.ToLowerInvariant() -eq "anthropic") }

  # resolveCloudConfig(): the saved provider, else a valid ANTHROPIC_API_KEY, else a valid OPENAI_API_KEY.
  $cloudId = $null
  if ($c -and $c.cloud -and $c.cloud.providerId) { $cloudId = [string]$c.cloud.providerId }
  elseif ($c -and $c.anthropicApiKey) { $cloudId = "anthropic" }
  else {
    $ak = ([string](& $getEnv "ANTHROPIC_API_KEY")).Trim()
    $ok = ([string](& $getEnv "OPENAI_API_KEY")).Trim()
    if ($ak -match '^sk-ant-[A-Za-z0-9_-]+$' -and $ak.Length -ge 20 -and $ak.Length -le 200) { $cloudId = "anthropic" }
    elseif (-not $ak -or $ak -eq "sk-ant-...") {
      if ($ok.StartsWith("sk-") -and -not $ok.StartsWith("sk-...") -and $ok.Length -ge 20 -and $ok.Length -le 200 -and $ok -notmatch '\s') { $cloudId = "openai" }
    }
  }
  $provider = if ($local) { "local (Ollama)" } elseif ($cloudId) { "cloud ($cloudId)" } else { "cloud (not set up)" }

  # resolveSpaceId(): builtin / custom / openai, as search actually runs.
  $setting = ([string](& $getEnv "SEARCH_EMBEDDINGS")).Trim().ToLowerInvariant()
  if (@("auto", "builtin", "openai") -notcontains $setting) { $setting = "auto" }
  $embUrl = ([string](& $getEnv "EMBEDDINGS_BASE_URL")).Trim()
  $embModel = ([string](& $getEnv "EMBEDDINGS_MODEL")).Trim()
  $embDims = ([string](& $getEnv "EMBEDDINGS_DIMENSIONS")).Trim()
  $custom = ($embUrl -and $embUrl -notmatch 'api\.openai\.com') -or ($embModel -and $embModel -ne "text-embedding-3-small") -or ($embDims -and $embDims -ne "512")
  $openAiKey = [string](& $getEnv "EMBEDDINGS_API_KEY"); if (-not $openAiKey) { $openAiKey = [string](& $getEnv "OPENAI_API_KEY") }
  $openAiKey = $openAiKey.Trim()
  $looksOpenAi = $openAiKey.Length -ge 20 -and $openAiKey.Length -le 200 -and $openAiKey -notmatch '\s' -and $openAiKey.StartsWith("sk-") -and -not $openAiKey.StartsWith("sk-...")
  $search = if ($setting -eq "builtin") { "builtin" } elseif ($custom) { "custom" } elseif ($setting -eq "openai") { "openai" } elseif ($local) { "builtin" } elseif ($looksOpenAi) { "openai" } else { "builtin" }

  return @{ version = $version; os = $os; provider = $provider; search = $search }
}

# The issue FORM (.github/ISSUE_TEMPLATE/bug_report.yml) with its fields filled
# by id, like the app's lib/errorLog/issueUrl.ts -- the form adds the bug label.
$PrivacyNote = "(API keys, email addresses and your user folder were removed automatically. Please check nothing private is left before you submit.)"

function New-GrantedIssueFields([hashtable]$Context, [string[]]$Lines, [int]$Omitted) {
  $envText = @(
    "- Granted version: $($Context.version)",
    "- Operating system: $($Context.os)",
    "- Model provider: $($Context.provider)",
    "- Search mode: $($Context.search)",
    "- Reported from: tray"
  ) -join "`n"
  $r = New-Object System.Collections.Generic.List[string]
  $r.Add($PrivacyNote); $r.Add("")
  if ($Lines.Count -eq 0) { $r.Add("The server log is empty.") }
  else {
    $r.Add("Last $($Lines.Count) line(s) of the server log:")
    foreach ($l in $Lines) { $r.Add(($l -replace '`{3,}', "'''")) }
  }
  if ($Omitted -gt 0) {
    $r.Add("")
    $r.Add("$Omitted earlier line(s) were left out to keep this link short. The tray's Show log opens the whole log, if you'd like to paste more here.")
  }
  return @{ environment = $envText; "recent-errors" = ($r -join "`n") }
}

function New-GrantedIssueUrl([hashtable]$Context, [string[]]$Lines, [int]$MaxLength) {
  $base = "${IssueNewUrl}?template=bug_report.yml&title=$([uri]::EscapeDataString("Problem (tray): Granted's server log"))"
  $lines = @($Lines | ForEach-Object { if ($_.Length -gt 500) { $_.Substring(0, 497) + "..." } else { $_ } })
  for ($skip = 0; $skip -le $lines.Count; $skip++) {
    $keep = if ($skip -lt $lines.Count) { @($lines[$skip..($lines.Count - 1)]) } else { @() }
    $f = New-GrantedIssueFields $Context $keep $skip
    if (($f["recent-errors"].Length + $f.environment.Length) -gt 30000) { continue }   # EscapeDataString's limit; a shorter tail comes next
    $url = "$base&environment=$([uri]::EscapeDataString($f.environment))&recent-errors=$([uri]::EscapeDataString($f['recent-errors']))"
    if ($url.Length -le $MaxLength) { return $url }
  }
  return $base
}

$ctx = Get-GrantedSanitizeContext $ScaffoldDir
$tail = @()
if ($LogPath -and (Test-Path -LiteralPath $LogPath)) {
  try { $tail = @(Get-Content -LiteralPath $LogPath -Tail $TailLines -Encoding UTF8 -ErrorAction Stop) } catch { $tail = @() }
}
$clean = @($tail | ForEach-Object { ConvertTo-ReportText ([string]$_) $ctx })
$context = Get-GrantedContext $ScaffoldDir
foreach ($k in @($context.Keys)) { $context[$k] = ConvertTo-ReportText ([string]$context[$k]) $ctx }
$url = New-GrantedIssueUrl $context $clean $MaxLength

if ($PrintUrl) { Write-Output $url; exit 0 }
Start-Process $url
