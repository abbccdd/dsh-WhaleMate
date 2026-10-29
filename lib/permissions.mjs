import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Restrict this data directory only. This cannot isolate processes running as the same user. */
export function protectHome(directory) {
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return }
  const script = `
$ErrorActionPreference = 'Stop'
$dataDirectory = $env:POND_PERMISSION_DIRECTORY
$directoryInfo = [System.IO.DirectoryInfo]::new($dataDirectory)
$acl = $directoryInfo.GetAccessControl()
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
foreach ($sid in @($ownerSid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$directoryInfo.SetAccessControl($acl)
`
  try {
    const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000,
      env: { ...process.env, POND_PERMISSION_DIRECTORY: directory },
    })
  } catch (cause) {
    throw new Error('无法限制鱼塘目录访问权限，已停止初始化；请由目录所有者检查 NTFS 权限', { cause })
  }
}
