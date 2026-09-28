$ErrorActionPreference = 'Stop'

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.test'
if (Test-Path -LiteralPath $envFile) {
    Write-Output 'Banco de teste já configurado em .env.test.'
    exit 0
}

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 12)
$database = "ConteiTriagemTest_$suffix"
$deployLogin = "contei_triagem_deploy_$suffix"
$appLogin = "contei_triagem_app_$suffix"
function New-TestPassword {
    $bytes = New-Object byte[] 36
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return 'Aa1!' + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', 'X').Replace('/', 'Y')
}
$deployPassword = New-TestPassword
$appPassword = New-TestPassword

$commands = @(
    "CREATE LOGIN [$deployLogin] WITH PASSWORD = '$deployPassword', CHECK_POLICY = ON; CREATE LOGIN [$appLogin] WITH PASSWORD = '$appPassword', CHECK_POLICY = ON;",
    "CREATE DATABASE [$database];",
    "ALTER AUTHORIZATION ON DATABASE::[$database] TO [sa];",
    "CREATE USER [$deployLogin] FOR LOGIN [$deployLogin]; ALTER ROLE [db_owner] ADD MEMBER [$deployLogin]; CREATE USER [$appLogin] FOR LOGIN [$appLogin];"
)
foreach ($index in 0..($commands.Count - 1)) {
    $arguments = @('-b', '-S', 'tcp:localhost,1433', '-E', '-C', '-Q', $commands[$index])
    if ($index -eq 3) { $arguments += @('-d', $database) }
    & sqlcmd @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar banco e credenciais de teste.' }
}

@(
    'MSSQL_HOST=localhost',
    'MSSQL_PORT=1433',
    "MSSQL_DATABASE=$database",
    "MSSQL_DEPLOY_USER=$deployLogin",
    "MSSQL_DEPLOY_PASSWORD=$deployPassword",
    "MSSQL_APP_USER=$appLogin",
    "MSSQL_APP_PASSWORD=$appPassword",
    'MSSQL_TRUST_SERVER_CERTIFICATE=true'
) | Set-Content -LiteralPath $envFile -Encoding Ascii
Write-Output "Banco de teste isolado criado: $database"
