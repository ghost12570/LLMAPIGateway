import process from 'node:process';

process.env.DATA_DIR = process.env.DATA_DIR || './data/demo';
process.env.DEMO_MODE = 'true';
process.env.HOST = process.env.HOST || '127.0.0.1';
process.env.PORT = process.env.PORT || '8080';

const mockPort = Number(process.env.MOCK_PORT || 9900);
const appPort = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const skipTraffic = process.argv.includes('--no-traffic');

const { startMockUpstream } = await import('./mock-upstream.js');
const mock = await startMockUpstream({ port: mockPort });
console.log(`\n[Mock Upstream] 已启动: ${mock.baseUrl}`);

const { createApp } = await import('../src/server.js');
const { seedDemo, generateDemoTraffic, seedHistoricalLogs } = await import('./demo-data.js');

const { app, server, close } = await createApp();
const seed = await seedDemo(app, { mockBaseUrl: mock.baseUrl });
const historical = seedHistoricalLogs(app);
if (historical) console.log(`[Demo] 已生成 ${historical} 条历史示例日志`);

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(appPort, host, resolve);
});
const baseUrl = `http://${host}:${appPort}`;

let traffic = { ok: 0, failed: 0 };
if (!skipTraffic) {
  console.log('[Demo] 正在生成示例调用流量...');
  traffic = await generateDemoTraffic(app, baseUrl, seed.keys);
}

const line = '─'.repeat(72);
const devKey = seed.keys.cursor.plaintext;
const prodKey = seed.keys.prod.plaintext;
console.log(`
${line}
  LLM API Gateway 演示环境已就绪
${line}
  管理后台   ${baseUrl}/admin
  自助门户   ${baseUrl}/portal
  网关地址   ${baseUrl}/v1

  超级管理员  admin@corp.local / ${seed.password}
  部门管理员  orgadmin@corp.local / ${seed.password}
  普通开发者  dev@corp.local / ${seed.password}
  财务审计员  auditor@corp.local / ${seed.password}

  示例 API Key（DEV）  ${devKey}
  示例 API Key（PROD） ${prodKey}

  已生成示例请求: 成功 ${traffic.ok} / 失败 ${traffic.failed}
  演示数据目录: ${app.config.dataDir}
  按 Ctrl+C 退出
${line}
`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[Demo] 收到 ${signal}，正在关闭...`);
  try {
    await close();
    await mock.close();
  } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
