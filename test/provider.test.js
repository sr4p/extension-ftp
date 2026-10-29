const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
let stored; let uploaded; let exists = '-';
class FileSystemError extends Error { static Unavailable(m) { return new this(m); } static FileExists() { return new this('exists'); } static FileNotFound() { return new this('not found'); } }
const vscode = { FileSystemError, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, FileChangeType: { Changed: 1, Created: 2 }, EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, workspace: { getConfiguration: () => ({ get: () => [{ name: 'demo', protocol: 'sftp', host: 'host', username: 'user', hostKeySha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] }) }, window: { showInputBox: async () => 'secret' } };
class Sftp { async connect() {} async end() {} async exists() { return exists; } async put(data, path) { uploaded = [data.toString(), path]; } }
Module._load = function(request, ...args) { if (request === 'vscode') return vscode; if (request === 'basic-ftp') return {}; if (request === 'ssh2-sftp-client') return Sftp; return original.call(this, request, ...args); };
const { Provider } = require('../src/extension');
Module._load = original;
const context = { secrets: { get: async () => stored, store: async (_, v) => { stored = v; } } };
const uri = { authority: 'demo', scheme: 'sftp-sync', path: '/file.txt' };
test('saving uploads bytes to the selected remote path', async () => { const p = new Provider(context); await p.writeFile(uri, Buffer.from('hello'), { create: true, overwrite: true }); assert.deepEqual(uploaded, ['hello', '/file.txt']); assert.equal(stored, 'secret'); });
test('saving honors create and overwrite flags', async () => { const p = new Provider(context); exists = '-'; await assert.rejects(p.writeFile(uri, Buffer.from('x'), { create: true, overwrite: false }), /exists/); exists = false; await assert.rejects(p.writeFile(uri, Buffer.from('x'), { create: false, overwrite: true }), /not found/); });
