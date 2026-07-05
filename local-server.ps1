param(
  [int]$Port = $(if ($env:PRIVET_PORT) { [int]$env:PRIVET_PORT } else { 8787 }),
  [string]$UpstreamBaseUrl = $(if ($env:PRIVET_API_BASE_URL) { $env:PRIVET_API_BASE_URL } else { "https://whisper-skynet.bourbaki-lab.duckdns.org" }),
  [string]$OutputDir = $(if ($env:PRIVET_OUTPUT_DIR) { $env:PRIVET_OUTPUT_DIR } else { "C:\Users\kuqui\OneDrive\Escritorio\alejandria" })
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TranscriptionPath = "/audio/transcription/"
$UpstreamBaseUrl = $UpstreamBaseUrl.TrimEnd("/")

Add-Type -AssemblyName System.Net.Http

function Find-HeaderEnd {
  param([byte[]]$Bytes, [int]$Length)

  for ($i = 0; $i -le $Length - 4; $i++) {
    if ($Bytes[$i] -eq 13 -and $Bytes[$i + 1] -eq 10 -and $Bytes[$i + 2] -eq 13 -and $Bytes[$i + 3] -eq 10) {
      return $i
    }
  }

  return -1
}

function Get-MimeType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8"; break }
    ".css" { "text/css; charset=utf-8"; break }
    ".js" { "application/javascript; charset=utf-8"; break }
    ".png" { "image/png"; break }
    ".jpg" { "image/jpeg"; break }
    ".jpeg" { "image/jpeg"; break }
    ".svg" { "image/svg+xml"; break }
    ".txt" { "text/plain; charset=utf-8"; break }
    default { "application/octet-stream"; break }
  }
}

function Write-RawResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [hashtable]$Headers,
    [byte[]]$Body = [byte[]]::new(0)
  )

  if (-not $Headers.ContainsKey("Content-Length")) {
    $Headers["Content-Length"] = [string]$Body.Length
  }
  $Headers["Connection"] = "close"
  $Headers["X-Content-Type-Options"] = "nosniff"

  $headerText = "HTTP/1.1 $StatusCode $Reason`r`n"
  foreach ($key in $Headers.Keys) {
    $headerText += "$key`: $($Headers[$key])`r`n"
  }
  $headerText += "`r`n"

  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

function Write-TextResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [string]$Text
  )

  $body = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Write-RawResponse -Stream $Stream -StatusCode $StatusCode -Reason $Reason -Headers @{
    "Content-Type" = "text/plain; charset=utf-8"
  } -Body $body
}

function Write-RuntimeConfig {
  param([System.Net.Sockets.NetworkStream]$Stream)

  $outputDirJson = ConvertTo-Json -Compress $OutputDir
  $backendApiJson = ConvertTo-Json -Compress $UpstreamBaseUrl
  $bodyText = "window.APP_CONFIG = Object.freeze({`n  API_BASE_URL: window.location.origin,`n  BACKEND_API_BASE_URL: $backendApiJson,`n  LOCAL_OUTPUT_DIR: $outputDirJson,`n});`n"
  $body = [System.Text.Encoding]::UTF8.GetBytes($bodyText)
  Write-RawResponse -Stream $Stream -StatusCode 200 -Reason "OK" -Headers @{
    "Content-Type" = "application/javascript; charset=utf-8"
    "Cache-Control" = "no-store, no-cache, must-revalidate, max-age=0"
  } -Body $body
}

function Write-StaticFile {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [string]$RequestPath
  )

  if ($RequestPath -eq "/") {
    $RequestPath = "/index.html"
  }

  $relative = [Uri]::UnescapeDataString($RequestPath.TrimStart("/")).Replace("/", [System.IO.Path]::DirectorySeparatorChar)
  $fullPath = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))
  $rootFull = [System.IO.Path]::GetFullPath($Root)

  if (-not $fullPath.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-TextResponse -Stream $Stream -StatusCode 403 -Reason "Forbidden" -Text "Ruta no permitida"
    return
  }

  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    Write-TextResponse -Stream $Stream -StatusCode 404 -Reason "Not Found" -Text "Archivo no encontrado"
    return
  }

  $body = [System.IO.File]::ReadAllBytes($fullPath)
  Write-RawResponse -Stream $Stream -StatusCode 200 -Reason "OK" -Headers @{
    "Content-Type" = Get-MimeType -Path $fullPath
  } -Body $body
}

function Read-Request {
  param([System.Net.Sockets.NetworkStream]$Stream)

  $buffer = [byte[]]::new(65536)
  $memory = New-Object System.IO.MemoryStream
  $headerEnd = -1

  while ($headerEnd -lt 0) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) {
      throw "Solicitud vacia"
    }

    $memory.Write($buffer, 0, $read)
    $bytes = $memory.ToArray()
    $headerEnd = Find-HeaderEnd -Bytes $bytes -Length $bytes.Length

    if ($memory.Length -gt 1048576) {
      throw "Cabeceras demasiado grandes"
    }
  }

  $allBytes = $memory.ToArray()
  $headerText = [System.Text.Encoding]::ASCII.GetString($allBytes, 0, $headerEnd)
  $lines = $headerText -split "`r`n"
  $requestLine = $lines[0] -split " "

  if ($requestLine.Length -lt 2) {
    throw "Linea de solicitud invalida"
  }

  $headers = @{}
  foreach ($line in $lines[1..($lines.Length - 1)]) {
    if (-not $line) {
      continue
    }

    $separator = $line.IndexOf(":")
    if ($separator -gt 0) {
      $name = $line.Substring(0, $separator).Trim().ToLowerInvariant()
      $value = $line.Substring($separator + 1).Trim()
      $headers[$name] = $value
    }
  }

  return @{
    Method = $requestLine[0].ToUpperInvariant()
    Path = ($requestLine[1] -split "\?", 2)[0]
    Headers = $headers
    InitialBody = $allBytes[($headerEnd + 4)..($allBytes.Length - 1)]
  }
}

function Get-OutputFileName {
  param([hashtable]$Headers)

  if ($Headers.ContainsKey("x-privet-output-filename") -and $Headers["x-privet-output-filename"]) {
    return [Uri]::UnescapeDataString($Headers["x-privet-output-filename"]).Trim()
  }

  return "transcripcion.txt"
}

function Get-SafeOutputFileName {
  param([string]$FileName)

  $leaf = [System.IO.Path]::GetFileName($(if ($FileName) { $FileName } else { "transcripcion.txt" }))
  if (-not $leaf.ToLowerInvariant().EndsWith(".txt")) {
    $leaf = "$leaf.txt"
  }

  $stem = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
  $stem = [regex]::Replace($stem, '[\\/:*?"<>|]+', "-")
  $stem = [regex]::Replace($stem, "\s+", "-").Trim(".-")
  if ($stem.Length -gt 120) {
    $stem = $stem.Substring(0, 120)
  }
  if (-not $stem) {
    $stem = "transcripcion"
  }

  return "$stem.txt"
}

function ConvertTo-TranscriptionText {
  param([byte[]]$Body)

  $text = [System.Text.Encoding]::UTF8.GetString($Body)

  try {
    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
    if ($parsed -is [string]) {
      return $parsed
    }

    foreach ($name in @("text", "transcription", "transcript", "result", "output")) {
      if ($parsed.PSObject.Properties.Name -contains $name) {
        $value = [string]$parsed.$name
        if ($value.Trim()) {
          return $value
        }
      }
    }
  }
  catch {
    return $text
  }

  return $text
}

function Save-Transcription {
  param(
    [byte[]]$Body,
    [string]$OutputFileName
  )

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $safeName = Get-SafeOutputFileName -FileName $OutputFileName
  $candidate = Join-Path $OutputDir $safeName
  $counter = 2

  while (Test-Path -LiteralPath $candidate) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($safeName)
    $candidate = Join-Path $OutputDir "$stem-$counter.txt"
    $counter += 1
  }

  $text = ConvertTo-TranscriptionText -Body $Body
  [System.IO.File]::WriteAllText($candidate, $text, [System.Text.Encoding]::UTF8)
  return $candidate
}

function Get-StatusReason {
  param([int]$StatusCode)

  switch ($StatusCode) {
    200 { "OK"; break }
    201 { "Created"; break }
    204 { "No Content"; break }
    400 { "Bad Request"; break }
    404 { "Not Found"; break }
    408 { "Request Timeout"; break }
    413 { "Payload Too Large"; break }
    422 { "Unprocessable Entity"; break }
    500 { "Internal Server Error"; break }
    502 { "Bad Gateway"; break }
    503 { "Service Unavailable"; break }
    504 { "Gateway Timeout"; break }
    default { "OK"; break }
  }
}

function Read-CurlHeaders {
  param([string]$HeaderPath)

  $raw = [System.IO.File]::ReadAllText($HeaderPath, [System.Text.Encoding]::GetEncoding("iso-8859-1"))
  $blocks = $raw.Replace("`r`n", "`n").Split("`n`n") | Where-Object { $_.Trim() }
  $headers = @{}
  if (-not $blocks -or $blocks.Count -eq 0) {
    return $headers
  }

  $lines = $blocks[-1].Split("`n")
  foreach ($line in $lines[1..($lines.Length - 1)]) {
    if (-not $line -or -not $line.Contains(":")) {
      continue
    }

    $separator = $line.IndexOf(":")
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    $headers[$name] = $value
  }

  return $headers
}

function Invoke-UpstreamWithCurl {
  param(
    [string]$PayloadPath,
    [hashtable]$Headers
  )

  $curlCommand = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curlCommand) {
    throw "No se encontro curl.exe en este Windows."
  }

  $bodyPath = [System.IO.Path]::GetTempFileName()
  $headerPath = [System.IO.Path]::GetTempFileName()
  $contentType = if ($Headers.ContainsKey("content-type")) { $Headers["content-type"] } else { "application/octet-stream" }
  $accept = if ($Headers.ContainsKey("accept")) { $Headers["accept"] } else { "*/*" }

  try {
    $curlArgs = @(
      "--silent",
      "--show-error",
      "--location",
      "--http1.1",
      "--request",
      "POST",
      "$UpstreamBaseUrl$TranscriptionPath",
      "--header",
      "Content-Type: $contentType",
      "--header",
      "Accept: $accept",
      "--header",
      "Expect:",
      "--header",
      "User-Agent: PrivetLocalProxy/1.0",
      "--data-binary",
      "@$PayloadPath",
      "--dump-header",
      $headerPath,
      "--output",
      $bodyPath,
      "--max-time",
      "7200",
      "--connect-timeout",
      "30",
      "--write-out",
      "%{http_code}"
    )

    $curlOutput = & $curlCommand.Source @curlArgs 2>&1
    $curlExitCode = $LASTEXITCODE
    $curlText = ($curlOutput | Out-String).Trim()

    if ($curlExitCode -ne 0) {
      throw $(if ($curlText) { $curlText } else { "curl no pudo completar la solicitud." })
    }

    if ($curlText.Length -lt 3) {
      throw "curl no devolvio un codigo HTTP valido: $curlText"
    }

    $statusCode = [int]$curlText.Substring($curlText.Length - 3, 3)
    return @{
      StatusCode = $statusCode
      Reason = Get-StatusReason -StatusCode $statusCode
      Headers = Read-CurlHeaders -HeaderPath $headerPath
      Body = [System.IO.File]::ReadAllBytes($bodyPath)
    }
  }
  finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $headerPath -Force -ErrorAction SilentlyContinue
  }
}

function Proxy-Transcription {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [hashtable]$Request
  )

  if (-not $Request.Headers.ContainsKey("content-length")) {
    Write-TextResponse -Stream $Stream -StatusCode 411 -Reason "Length Required" -Text "Content-Length requerido"
    return
  }

  $contentLength = [int64]$Request.Headers["content-length"]
  $tempFile = [System.IO.Path]::GetTempFileName()
  $file = [System.IO.File]::Open($tempFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)

  try {
    $initial = [byte[]]$Request.InitialBody
    if ($initial.Length -gt 0) {
      $toWrite = [Math]::Min($initial.Length, $contentLength)
      $file.Write($initial, 0, $toWrite)
    }

    $remaining = $contentLength - $file.Length
    $buffer = [byte[]]::new(1048576)
    while ($remaining -gt 0) {
      $read = $Stream.Read($buffer, 0, [Math]::Min($buffer.Length, $remaining))
      if ($read -le 0) {
        throw "Solicitud incompleta"
      }
      $file.Write($buffer, 0, $read)
      $remaining -= $read
    }

    $file.Dispose()
    $file = $null

    $response = Invoke-UpstreamWithCurl -PayloadPath $tempFile -Headers $Request.Headers
    $body = [byte[]]$response.Body
    $savedPath = ""
    $saveError = ""

    if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
      try {
        $savedPath = Save-Transcription -Body $body -OutputFileName (Get-OutputFileName -Headers $Request.Headers)
      }
      catch {
        $saveError = [string]$_
      }
    }
    elseif ([int]$response.StatusCode -ge 400) {
      $detail = [System.Text.Encoding]::UTF8.GetString($body).Trim()
      if (-not $detail) {
        $detail = "sin detalle"
      }
      Write-Host "Backend respondio HTTP $($response.StatusCode): $($detail.Substring(0, [Math]::Min(500, $detail.Length)))"
    }

    $headers = @{
      "Access-Control-Allow-Origin" = "*"
      "Access-Control-Allow-Methods" = "POST, OPTIONS"
      "Access-Control-Allow-Headers" = "Content-Type"
      "X-Privet-Output-Dir" = [Uri]::EscapeDataString($OutputDir)
    }

    foreach ($header in $response.Headers.GetEnumerator()) {
      if ($header.Key.ToLowerInvariant() -notin @("connection", "content-length", "keep-alive", "transfer-encoding")) {
        $headers[$header.Key] = [string]$header.Value
      }
    }

    $headers["Content-Length"] = [string]$body.Length
    if ($savedPath) {
      $headers["X-Privet-Saved-Path"] = [Uri]::EscapeDataString($savedPath)
    }
    if ($saveError) {
      $headers["X-Privet-Save-Error"] = [Uri]::EscapeDataString($saveError)
    }
    Write-RawResponse -Stream $Stream -StatusCode ([int]$response.StatusCode) -Reason $response.Reason -Headers $headers -Body $body
  }
  catch {
    Write-Host "Error conectando con backend: $_"
    Write-TextResponse -Stream $Stream -StatusCode 502 -Reason "Bad Gateway" -Text "No se pudo conectar con el backend: $_"
  }
  finally {
    if ($file) {
      $file.Dispose()
    }
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  }
}

function Handle-Client {
  param([System.Net.Sockets.TcpClient]$Client)

  $stream = $Client.GetStream()

  try {
    $request = Read-Request -Stream $stream

    if ($request.Method -eq "GET" -and $request.Path -eq "/assets/js/runtime-config.js") {
      Write-RuntimeConfig -Stream $stream
    }
    elseif ($request.Method -eq "GET") {
      Write-StaticFile -Stream $stream -RequestPath $request.Path
    }
    elseif ($request.Method -eq "OPTIONS" -and $request.Path -eq $TranscriptionPath) {
      Write-RawResponse -Stream $stream -StatusCode 204 -Reason "No Content" -Headers @{
        "Access-Control-Allow-Origin" = "*"
        "Access-Control-Allow-Methods" = "POST, OPTIONS"
        "Access-Control-Allow-Headers" = "Content-Type"
      }
    }
    elseif ($request.Method -eq "POST" -and $request.Path -eq $TranscriptionPath) {
      Proxy-Transcription -Stream $stream -Request $request
    }
    else {
      Write-TextResponse -Stream $stream -StatusCode 404 -Reason "Not Found" -Text "Ruta no encontrada"
    }
  }
  catch {
    try {
      Write-TextResponse -Stream $stream -StatusCode 500 -Reason "Internal Server Error" -Text "Error local: $_"
    }
    catch {
      # El cliente ya puede haberse desconectado.
    }
  }
  finally {
    $stream.Dispose()
    $Client.Close()
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
$listener.Start()

Write-Host "Privet local: http://127.0.0.1:$Port/"
Write-Host "Backend proxy: $UpstreamBaseUrl$TranscriptionPath"
Write-Host "Carpeta de salida: $OutputDir"
Write-Host "Deja esta ventana abierta mientras uses la pagina."

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    Handle-Client -Client $client
  }
}
finally {
  $listener.Stop()
}
