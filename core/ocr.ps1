param(
  [string]$Pdf = '',
  [string]$OutDir = '',
  [string]$Image = '',
  [switch]$NoPreprocess,
  [int]$First = 0,
  [int]$Last = -1,
  [int]$Width = 1600
)
# ASCII-only on purpose: Windows PowerShell reads .ps1 as ANSI when there is no
# BOM, so any non-ASCII literal would be corrupted. All text comes from OCR.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$opGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$actionGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]
function Await($op, $type) {
  $task = $opGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function AwaitAction($action) {
  $task = $actionGeneric.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-CN'))
if (-not $engine) {
  Write-Output (ConvertTo-Json @{ error = 'no-zh-ocr-engine' } -Compress)
  exit 3
}

if ($Image) {
  # Slide pictures are small and often dark-themed. Windows OCR reads a flat,
  # light, upscaled bitmap far better than the raw screenshot, so preprocess
  # before handing it to WinRT. -NoPreprocess keeps the old behaviour for A/B.
  $target = $Image
  $tempFile = $null
  if (-not $NoPreprocess) {
    try {
      Add-Type -AssemblyName System.Drawing
      $src = [System.Drawing.Image]::FromFile($Image)
      $minSide = [Math]::Min($src.Width, $src.Height)
      $scale = 1.0
      if ($minSide -gt 0 -and $minSide -lt 500) { $scale = [Math]::Min(2.5, 800.0 / $minSide) }
      $newW = [int]([Math]::Min(2600, [Math]::Round($src.Width * $scale)))
      $newH = [int]([Math]::Min(2600, [Math]::Round($src.Height * $scale)))
      if ($newW -lt 1) { $newW = 1 }
      if ($newH -lt 1) { $newH = 1 }

      # brightness from a 32x32 thumbnail: per-pixel loops on full images are slow
      $thumb = New-Object System.Drawing.Bitmap 32, 32
      $tg = [System.Drawing.Graphics]::FromImage($thumb)
      $tg.DrawImage($src, 0, 0, 32, 32)
      $sum = 0.0
      for ($y = 0; $y -lt 32; $y++) {
        for ($x = 0; $x -lt 32; $x++) {
          $c = $thumb.GetPixel($x, $y)
          $sum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
        }
      }
      $mean = $sum / 1024.0
      $tg.Dispose()
      $thumb.Dispose()

      $cm = New-Object System.Drawing.Imaging.ColorMatrix
      $dark = ($mean -lt 100)
      if ($dark) {
        # dark slide: grayscale then invert, Windows OCR reads light-on-dark badly
        $cm.Matrix00 = -0.299
        $cm.Matrix01 = -0.299
        $cm.Matrix02 = -0.299
        $cm.Matrix10 = -0.587
        $cm.Matrix11 = -0.587
        $cm.Matrix12 = -0.587
        $cm.Matrix20 = -0.114
        $cm.Matrix21 = -0.114
        $cm.Matrix22 = -0.114
        $cm.Matrix40 = 1.0
        $cm.Matrix41 = 1.0
        $cm.Matrix42 = 1.0
      }
      $cm.Matrix33 = 1.0
      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $attrs.SetColorMatrix($cm)

      $bmp = New-Object System.Drawing.Bitmap $newW, $newH
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $rect = New-Object System.Drawing.Rectangle 0, 0, $newW, $newH
      $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
      $g.Dispose()
      $tempFile = Join-Path $env:TEMP ("ocr-pre-" + [guid]::NewGuid().ToString("N") + ".png")
      $bmp.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $src.Dispose()
      $target = $tempFile
      Write-Output (ConvertTo-Json @{ preprocess = @{ scale = $scale; mean = [int]$mean; inverted = $dark } } -Compress)
    } catch {
      $target = $Image
    }
  }

  $imgFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($target)) ([Windows.Storage.StorageFile])
  $imgStream = Await ($imgFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $imgDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($imgStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $imgBitmap = Await ($imgDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $imgResult = Await ($engine.RecognizeAsync($imgBitmap)) ([Windows.Media.Ocr.OcrResult])
  $imgText = ($imgResult.Lines | ForEach-Object { $_.Text }) -join "`n"
  Write-Output (ConvertTo-Json @{ page = 1; text = $imgText } -Compress)
  $imgStream.Dispose()
  if ($tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
  exit 0
}
if (-not $Pdf) {
  Write-Output (ConvertTo-Json @{ error = 'no-input' } -Compress)
  exit 4
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if ($Last -lt 0 -or $Last -ge $doc.PageCount) { $Last = $doc.PageCount - 1 }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutDir)) ([Windows.Storage.StorageFolder])

Write-Output (ConvertTo-Json @{ pageCount = $doc.PageCount; first = $First; last = $Last } -Compress)

for ($i = $First; $i -le $Last; $i++) {
  $page = $doc.GetPage($i)
  $name = "page-$($i + 1).png"
  $outFile = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $outStream = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  # the single-argument overload is the one PowerShell can bind reliably; the
  # render-options overload needs WinRT activation that PS 5.1 does not provide
  AwaitAction ($page.RenderToStreamAsync([Windows.Storage.Streams.IRandomAccessStream]$outStream))
  $outStream.Dispose()

  $png = Join-Path $OutDir $name
  $pngFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $readStream = Await ($pngFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($readStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
  Write-Output (ConvertTo-Json @{ page = $i + 1; text = $text } -Compress)
  $readStream.Dispose()
  Remove-Item $png -Force -ErrorAction SilentlyContinue
}
