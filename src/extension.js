const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path').posix;
const ftp = require('basic-ftp');
const Sftp = require('ssh2-sftp-client');
const { Writable, Readable } = require('stream');

function profiles() { return vscode.workspace.getConfiguration('remoteFtpSync').get('servers', []); }
function profile(name) {
  const matches = profiles().filter(p => p.name === name);
  if (matches.length !== 1) throw new Error(`Profile '${name}' must exist exactly once in remoteFtpSync.servers.`);
  const p = matches[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(p.name) || !p.host || !p.username || !['ftp', 'ftps', 'sftp'].includes(p.protocol)) throw new Error(`Invalid server profile '${name}'.`);
  return p;
}
class Provider {
  constructor(context, protocol) { this.context = context; this.protocol = protocol; this.emitter = new vscode.EventEmitter(); this.onDidChangeFile = this.emitter.event; }
  watch() { return new vscode.Disposable(() => {}); }
  async withClient(uri, fn) {
    const p = profile(uri.authority);
    if ((p.protocol === 'sftp' ? 'sftp-sync' : 'ftp-sync') !== uri.scheme) throw new Error('Profile protocol has changed; reconnect the server.');
    let password = await this.context.secrets.get(`remoteFtpSync:${p.name}`);
    if (!password) {
      password = await vscode.window.showInputBox({ title: `${p.privateKeyPath ? 'Private key passphrase (leave empty if unencrypted)' : 'Password'} for ${p.name}`, password: true, ignoreFocusOut: true });
      if (password === undefined) throw new Error('Connection cancelled.');
      if (password) await this.context.secrets.store(`remoteFtpSync:${p.name}`, password);
    }
    const client = p.protocol === 'sftp' ? new Sftp() : new ftp.Client();
    try {
      if (p.protocol === 'sftp') {
        if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(p.hostKeySha256 || '')) throw new Error('Set hostKeySha256 to the trusted server host key fingerprint.');
        const expected = p.hostKeySha256.replace(/=+$/, '');
        const options = { host: p.host, port: p.port || 22, username: p.username, hostHash: 'sha256', hostVerifier: hash => `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}` === expected };
        if (p.privateKeyPath) {
          options.privateKey = await fs.readFile(p.privateKeyPath.replace(/^~(?=\/)/, require('os').homedir()));
          if (password) options.passphrase = password;
        } else options.password = password;
        await client.connect(options);
      } else await client.access({ host: p.host, port: p.port || 21, user: p.username, password, secure: p.protocol === 'ftps' });
      return await fn(client, p);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) throw err;
      throw vscode.FileSystemError.Unavailable(`${p.name}: ${err.message}`);
    } finally { if (p.protocol === 'sftp') await client.end().catch(() => {}); else client.close(); }
  }
  async stat(uri) {
    if (uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    return this.withClient(uri, async (c, p) => {
      if (p.protocol === 'sftp') { const s = await c.stat(uri.path); return { type: s.isDirectory ? vscode.FileType.Directory : s.isSymbolicLink ? vscode.FileType.SymbolicLink : vscode.FileType.File, ctime: s.modifyTime, mtime: s.modifyTime, size: s.size }; }
      const entries = await c.list(path.dirname(uri.path)); const e = entries.find(x => x.name === path.basename(uri.path));
      if (!e) throw vscode.FileSystemError.FileNotFound(uri);
      return { type: e.isDirectory ? vscode.FileType.Directory : e.isSymbolicLink ? vscode.FileType.SymbolicLink : vscode.FileType.File, ctime: 0, mtime: e.modifiedAt?.getTime() || 0, size: e.size || 0 };
    });
  }
  async readDirectory(uri) { return this.withClient(uri, async (c, p) => (await c.list(uri.path)).filter(e => e.name !== '.' && e.name !== '..').map(e => [e.name, p.protocol === 'sftp' ? (e.type === 'd' ? vscode.FileType.Directory : e.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File) : (e.isDirectory ? vscode.FileType.Directory : e.isSymbolicLink ? vscode.FileType.SymbolicLink : vscode.FileType.File)])); }
  async readFile(uri) { return this.withClient(uri, async (c, p) => { if (p.protocol === 'sftp') return new Uint8Array(await c.get(uri.path)); const chunks = []; const stream = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } }); await c.downloadTo(stream, uri.path); return new Uint8Array(Buffer.concat(chunks)); }); }
  async writeFile(uri, content, options) {
    return this.withClient(uri, async (c, p) => {
      let exists;
      if (p.protocol === 'sftp') exists = await c.exists(uri.path);
      else exists = (await c.list(path.dirname(uri.path))).some(e => e.name === path.basename(uri.path));
      if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (p.protocol === 'sftp') await c.put(Buffer.from(content), uri.path); else await c.uploadFrom(Readable.from(Buffer.from(content)), uri.path);
      this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    });
  }
  async createDirectory(uri) { await this.withClient(uri, async (c, p) => { if (p.protocol === 'sftp') await c.mkdir(uri.path, false); else await c.send(`MKD ${uri.path}`); }); this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]); }
  async delete(uri, options) { await this.withClient(uri, async (c, p) => { if (p.protocol === 'sftp') { const type = await c.exists(uri.path); if (!type) throw vscode.FileSystemError.FileNotFound(uri); if (type === 'd') await c.rmdir(uri.path, options.recursive); else await c.delete(uri.path); } else { const entries = await c.list(path.dirname(uri.path)); const e = entries.find(x => x.name === path.basename(uri.path)); if (!e) throw vscode.FileSystemError.FileNotFound(uri); if (e.isDirectory) { if (options.recursive) await c.removeDir(uri.path); else await c.send(`RMD ${uri.path}`); } else await c.remove(uri.path); } }); this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]); }
  async rename(oldUri, newUri, options) { if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.NoPermissions('Cannot move between servers.'); await this.withClient(oldUri, async (c, p) => { const exists = p.protocol === 'sftp' ? await c.exists(newUri.path) : (await c.list(path.dirname(newUri.path))).some(e => e.name === path.basename(newUri.path)); if (exists) { if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri); throw vscode.FileSystemError.NoPermissions('Overwriting a remote item by rename is not supported.'); } await c.rename(oldUri.path, newUri.path); }); this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]); }
}
function activate(context) {
  for (const scheme of ['ftp-sync', 'sftp-sync']) context.subscriptions.push(vscode.workspace.registerFileSystemProvider(scheme, new Provider(context, scheme), { isCaseSensitive: true }));
  context.subscriptions.push(vscode.commands.registerCommand('remoteFtpSync.connect', async () => {
    const all = profiles(); if (!all.length) { vscode.window.showInformationMessage('Add a server in Settings: Remote FTP Sync: Servers.'); return; }
    const selected = await vscode.window.showQuickPick(all.map(p => ({ label: p.name, description: `${p.protocol}://${p.host}` })), { placeHolder: 'Select a server' }); if (!selected) return;
    try { const p = profile(selected.label); const remotePath = p.remotePath || '/'; if (!remotePath.startsWith('/')) throw new Error('remotePath must be absolute.'); const uri = vscode.Uri.from({ scheme: p.protocol === 'sftp' ? 'sftp-sync' : 'ftp-sync', authority: p.name, path: path.normalize(remotePath) }); await vscode.workspace.fs.readDirectory(uri); if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri, name: p.name })) throw new Error('Could not add workspace folder.'); } catch (e) { vscode.window.showErrorMessage(`Connection failed: ${e.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remoteFtpSync.forgetPassword', async () => { const selected = await vscode.window.showQuickPick(profiles().map(p => p.name), { placeHolder: 'Select a server' }); if (selected) { await context.secrets.delete(`remoteFtpSync:${selected}`); vscode.window.showInformationMessage(`Password removed for ${selected}.`); } }));
}
module.exports = { activate, Provider };
