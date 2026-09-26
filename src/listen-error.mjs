export function listenError(error, host, port) {
  const address = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (error.code === 'EADDRINUSE') return `[启动失败] ${address} 的端口已被占用。\n如果项目已经运行，请打开原来的页面；需要重启时，在原启动终端按 Ctrl+C 后重新执行 npm run dev。\n请先确认占用者，不要直接结束不明进程。`;
  return `[启动失败] 无法监听 ${address}：${error.code || error.message}`;
}
