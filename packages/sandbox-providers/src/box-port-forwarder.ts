export const BOX_PORT_FORWARDER = `
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const port = Number(process.argv[1]);
const preview = process.argv.includes('--preview');
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
if (process.argv[2] !== 'daemon') {
  const child = spawn(process.execPath, ['-e', process._eval, String(port), 'daemon', ...(preview ? ['--preview'] : [])], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);
  child.once('error', () => process.exit(1));
  child.once('exit', code => { clearTimeout(timer); process.exit(code ?? 1); });
  child.once('message', message => {
    clearTimeout(timer);
    child.disconnect();
    child.unref();
    process.exit(message === 'ready' ? 0 : 1);
  });
} else {
  const addresses = [...new Set(Object.values(os.networkInterfaces()).flat()
    .filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address))];
  if (!addresses.length) process.exit(1);
  const upstreamAlive = () => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = alive => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  const start = async () => {
  // A preview must never reserve the port before the actual application.
  if (preview && !await upstreamAlive()) process.exit(1);
  let listeners = 0;
  await Promise.all(addresses.map(host => new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true }, incoming => {
      const upstream = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      const close = () => { incoming.destroy(); upstream.destroy(); };
      upstream.setTimeout(10000, close);
      upstream.once('connect', () => upstream.setTimeout(0));
      incoming.on('error', close);
      upstream.on('error', close);
      incoming.on('close', () => upstream.destroy());
      upstream.on('close', hadError => hadError ? incoming.destroy() : incoming.end());
      incoming.pipe(upstream).pipe(incoming);
    });
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    server.listen({ host, port }, () => { listeners += 1; resolve(); });
  })));
  process.send('ready');
  if (preview && listeners > 0) {
    // Stop holding the interface port once the localhost application exits.
    // The next preview request recreates the bridge after the app restarts.
    const watch = async () => {
      if (!await upstreamAlive()) process.exit(0);
      setTimeout(watch, 500);
    };
    setTimeout(watch, 500);
  }
  };
  start().catch(() => process.exit(1));
}
`;
