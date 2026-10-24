# Windows text-to-speech for the demo recordings. Reads a JSON list of
# { file, ssml } jobs and writes each as 8 kHz 16-bit mono WAV (telephone quality).
param([Parameter(Mandatory = $true)][string]$JobFile)

Add-Type -AssemblyName System.Speech
$jobs = Get-Content $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(8000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($job in $jobs) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SetOutputToWaveFile($job.file, $format)
  $synth.SpeakSsml($job.ssml)
  $synth.Dispose()
}
