/**
 * Custom signing hook for electron-builder.
 * Uses SSL.com eSigner CodeSignTool for cloud-based code signing.
 * Skips signing in local/dev builds (when env vars are missing).
 */
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function sign(configuration) {
  const filePath = configuration.path
  if (!filePath) return

  // Skip signing if credentials are not set (local dev builds)
  const { SSL_COM_USERNAME, SSL_COM_PASSWORD, SSL_COM_TOTP_SECRET, SSL_COM_CREDENTIAL_ID } = process.env
  if (!SSL_COM_USERNAME || !SSL_COM_PASSWORD || !SSL_COM_TOTP_SECRET || !SSL_COM_CREDENTIAL_ID) {
    console.log(`Skipping code signing (no SSL.com credentials): ${path.basename(filePath)}`)
    return
  }

  console.log(`Signing: ${path.basename(filePath)}`)

  const command = [
    'CodeSignTool sign',
    `-username="${SSL_COM_USERNAME}"`,
    `-password="${SSL_COM_PASSWORD}"`,
    `-totp_secret="${SSL_COM_TOTP_SECRET}"`,
    `-credential_id="${SSL_COM_CREDENTIAL_ID}"`,
    `-input_file_path="${filePath}"`,
    '-override=true',
  ].join(' ')

  try {
    execSync(command, { stdio: 'inherit', timeout: 120000 })
    console.log(`Signed: ${path.basename(filePath)}`)
  } catch (err) {
    console.error(`Signing failed for ${path.basename(filePath)}:`, err.message)
    throw err
  }
}
