# MSIX を試しに入れるための、自己署名の証明書を作る (→ docs/platform.md「Windows の MSIX 版」)。
# MSIX を作る PC で、管理者の PowerShell から1回だけ実行する。
# Subject は scripts/msix.mjs の IDENTITY.publisher (Store の発行元) と揃える。
# 発行元は同じ開発者アカウントのアプリで共通なので、ほかのアプリの同じスクリプトで作った証明書があれば、それを使う。
$subject = "CN=BA27F417-AAC4-43D9-9E55-3320F7F52C6F"

# 2つあると、scripts/msix.mjs が Subject で選べずに署名に失敗する。あれば作らない。
$existing = Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.Subject -eq $subject }
if ($existing) {
    Write-Host "already exists: $subject ($($existing[0].Thumbprint))"
    exit
}

# 署名に使う (scripts/msix.mjs が CurrentUser\My から Subject で選ぶ)。
$cert = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
    -Subject $subject -FriendlyName "Mawok MSIX test"

# 入れる PC に、この証明書を信頼させる。別の PC に入れるときは、そちらでも同じストアに入れる。
$cer = Join-Path $env:TEMP "mawok-msix-test.cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
Remove-Item $cer
Write-Host "created $subject ($($cert.Thumbprint))"
