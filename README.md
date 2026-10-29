# Remote FTP Sync

Edit FTP, explicit FTPS, and SFTP files directly in Cursor's Explorer. Saving a document uploads its contents to the server; a failed upload is reported by the editor.

## Setup

Install the packaged VSIX in Cursor, then add a profile to your user settings (`Preferences: Open User Settings (JSON)`):

```json
"remoteFtpSync.servers": [
  { "name": "my-server", "protocol": "sftp", "host": "example.com", "username": "alice", "hostKeySha256": "SHA256:replace-with-the-trusted-server-fingerprint", "remotePath": "/var/www" }
]
```

Run **FTP/SFTP: Connect to Server** from the Command Palette and select the profile. The remote directory appears as a workspace folder. Open a file and save it normally to upload. FTP and FTPS default to port 21; SFTP defaults to 22. Set `port` to override. Profile names must be unique and contain only letters, digits, underscores, or hyphens. `remotePath` must be absolute.

Passwords are requested when needed and stored in the editor's secret storage. Use **FTP/SFTP: Forget Saved Password** to remove one. For SFTP key authentication, set `privateKeyPath` to a local private key path. The extension prompts for the key passphrase; leave it empty for an unencrypted key. Set `hostKeySha256` to the server host key fingerprint obtained and verified through a trusted channel, for example from `ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub` on the server. The connection is rejected if the fingerprint differs.

Use SFTP or FTPS when possible: plain FTP sends credentials and file contents without encryption. Verify the SFTP host key fingerprint through a trusted channel before connecting. Changes made remotely by other clients are not watched; refresh the Explorer to see them. Saves write directly to the target file, so concurrent edits and interrupted transfers may overwrite or truncate remote content. Back up important files before use.

## Development

Run `npm install`, then `npm test`. To package, run `npx vsce package`. Install the resulting VSIX using Cursor's **Extensions: Install from VSIX** command. A real FTP/SFTP server is needed for end-to-end testing.
