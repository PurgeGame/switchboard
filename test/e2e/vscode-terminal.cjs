// Real VS Code extension-host / real Linux PTYs. Provider processes are throwaway stand-ins.
const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  for (let n = 0; n < 200; n++) { if (await test()) return; await delay(50); }
  throw Error('Timeout: ' + label);
}
exports.run = async function () {
  const dir = process.env.SB_VSCODE_TEST_DIR, root = process.env.SB_VSCODE_TEST_ROOT;
  assert(dir && root && dir.startsWith(root + '/.sandbox/vs-'));
  const log = [], connections = [], pending = new Map();
  let socket, hello, terminals = [], sequence = 0;
  const pass = message => { log.push(message); console.log('PASS actual VS Code: ' + message); };
  const server = net.createServer(s => {
    socket = s; connections.push(s); let buf = '';
    s.setEncoding('utf8');
    s.on('data', data => {
      buf += data;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.type === 'hello') hello = m;
        if (m.type === 'terminals') terminals = m.terminals;
        if (m.type === 'result') { pending.get(m.reqId)?.(m); pending.delete(m.reqId); }
      }
    });
  });
  const send = msg => new Promise((resolve, reject) => {
    const reqId = ++sequence;
    const timer = setTimeout(() => { pending.delete(reqId); reject(Error('bridge request timeout')); }, 10000);
    pending.set(reqId, result => { clearTimeout(timer); resolve(result); });
    socket.write(JSON.stringify({ ...msg, reqId }) + '\n');
  });
  const opened = [];
  const observer = vscode.window.onDidOpenTerminal(t => opened.push(t));
  let legacy;
  try {
    await new Promise(resolve => server.listen(path.join(process.env.SB_DATA_DIR, 'bridge.sock'), resolve));
    fs.chmodSync(path.join(process.env.SB_DATA_DIR, 'bridge.sock'), 0o600);
    const bridge = vscode.extensions.getExtension('switchboard-local.switchboard-bridge');
    assert(bridge); assert.equal(bridge.packageJSON.version, '0.1.2'); await bridge.activate();
    await until(() => hello, 'bridge hello');
    assert(hello.capabilities.includes('managed-terminal-v1'));
    pass(`bridge 0.1.2 activated in VS Code ${vscode.version}, extension host PID ${process.pid}`);
    legacy = vscode.window.createTerminal({ name: 'Legacy sb-agent (throwaway)', shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'], cwd: dir });
    await legacy.processId;
    fs.writeFileSync(path.join(dir, 'agent.py'), `import sys, pathlib\np = pathlib.Path(sys.argv[1])\np.with_suffix('.ready').write_text(str(__import__('os').getpid()))\nfor line in sys.stdin:\n if line.strip() in ('/exit', '/quit'): break\np.with_suffix('.history').write_text('preserved conversation')\n`);
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    for (const provider of ['claude', 'codex']) for (let cycle = 0; cycle < 3; cycle++) {
      const name = provider + '-' + cycle, file = path.join(dir, name), launchId = randomUUID();
      const request = { type: 'createManaged', launchId, name, cwd: dir, runtime: '/usr/bin/python3', runner: path.join(root, 'src/daemon/managed-terminal.py'), command: `/usr/bin/python3 -u ${quote(path.join(dir, 'agent.py'))} ${quote(file)}` };
      const a = await send(request); assert(a.ok, a.error);
      await until(() => fs.existsSync(file + '.ready'), 'agent ready');
      const t = opened.find(t => t.creationOptions.env?.SWITCHBOARD_TERMINAL_ID === launchId);
      assert(t); assert(vscode.window.terminals.includes(t));
      await delay(250); assert(vscode.window.terminals.includes(t));
      const duplicate = await send(request); assert.equal(duplicate.data.terminalId, a.data.terminalId);
      assert.equal(vscode.window.terminals.filter(t => t.creationOptions.env?.SWITCHBOARD_TERMINAL_ID === launchId).length, 1);
      const conflict = await send({ ...request, command: 'true' }); assert.equal(conflict.ok, false);
      // Reconnect the actual extension to this isolated socket while its PTY remains live.
      if (cycle === 1) {
        const previous = hello; socket.destroy(); hello = null;
        await until(() => hello, 'bridge reconnect');
        assert.equal(hello.extensionHostPid, previous.extensionHostPid);
        assert(vscode.window.terminals.includes(t));
        assert.equal((await send(request)).data.terminalId, a.data.terminalId);
      }
      assert((await send({ type: 'sendText', terminalId: a.data.terminalId, text: (provider === 'claude' ? '/exit' : '/quit') + '\r' })).ok);
      await until(() => !vscode.window.terminals.includes(t), 'VS Code removes exited tab');
      await until(() => !terminals.some(x => x.id === a.data.terminalId), 'bridge reports removal');
      assert.equal(fs.readFileSync(file + '.history', 'utf8'), 'preserved conversation');
      assert(vscode.window.terminals.includes(legacy));
      pass(`${name}: idle retained, duplicate attached, conflicting launch refused, exit removes real tab; history and legacy shell retained`);
    }
    // A detached child outlives the parent. The tab must remain until that child exits.
    const childFile = path.join(dir, 'detached.py'), release = path.join(dir, 'release-child'), ready = path.join(dir, 'child-ready');
    fs.writeFileSync(childFile, `import os,time,pathlib\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\npathlib.Path(${JSON.stringify(ready)}).write_text('ready')\nwhile not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.05)\n`);
    const launchId = randomUUID();
    const r = await send({ type: 'createManaged', launchId, name: 'detached child', cwd: dir, runtime: '/usr/bin/python3', runner: path.join(root, 'src/daemon/managed-terminal.py'), command: `/usr/bin/python3 ${quote(childFile)}` }); assert(r.ok, r.error);
    await until(() => fs.existsSync(ready), 'detached child ready');
    const t = opened.find(t => t.creationOptions.env?.SWITCHBOARD_TERMINAL_ID === launchId);
    await delay(500); assert(vscode.window.terminals.includes(t));
    // Keystrokes go to the runner's PTY; there is no interactive shell to run them.
    const sentinel = path.join(dir, 'MUST-NOT-EXIST');
    await send({ type: 'sendText', terminalId: r.data.terminalId, text: `touch ${quote(sentinel)}\r` });
    await delay(200); assert(!fs.existsSync(sentinel)); assert(vscode.window.terminals.includes(t));
    fs.writeFileSync(release, 'exit');
    await until(() => !vscode.window.terminals.includes(t), 'tab closes after detached child exit');
    assert(!fs.existsSync(sentinel)); assert(vscode.window.terminals.includes(legacy));
    assert.equal((await send({ type: 'dispose', terminalId: terminals.find(x => x.name === legacy.name)?.id })).ok, false);
    pass('detached child keeps actual tab alive; post-agent input cannot run shell commands; tab closes after child exit; arbitrary disposal refused');
    assert.equal(vscode.window.terminals.length, 1);
    pass('six repeated provider exit/relaunch cycles leave only the deliberate legacy shell');
  } finally {
    fs.writeFileSync(path.join(dir, 'actual-host-results.json'), JSON.stringify({ vscode: vscode.version, extensionHostPid: process.pid, checks: log, remainingTerminals: vscode.window.terminals.map(t => t.name) }, null, 2));
    // Only terminals created in this isolated throwaway instance are cleaned up.
    observer.dispose(); for (const t of opened) t.dispose();
    for (const s of connections) s.destroy(); server.close();
  }
};
