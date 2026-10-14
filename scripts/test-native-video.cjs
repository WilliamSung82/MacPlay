// A simulated phone resource loader feeds generated MP4/HLS into the real AVPlayer.
// This does not establish physical iPhone interoperability.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { VideoResourceServer } = require('../build/engine/video-resource-server.cjs');
async function main() {
  const root = path.resolve('build/video-fixtures'), proxies = [];
  try {
    const urls = [];
    for (const name of ['clip.mp4', 'stream.m3u8']) {
      const proxy = new VideoResourceServer(async (_, url) => {
        const file = path.basename(new URL(url).pathname);
        if (!/^(clip\.mp4|stream\.m3u8|segment\d+\.ts)$/.test(file)) return { status: 404 };
        const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
        return { status: 200, contentType, data: fs.readFileSync(path.join(root, file)) };
      });
      proxies.push(proxy);
      urls.push(await proxy.start(name, `fixture://phone/${name}`, name.endsWith('.m3u8')));
    }
    const child = spawn('build/test-native-video', urls, { stdio: ['ignore', 'pipe', 'inherit'] });
    let result = '';
    child.stdout.on('data', data => { result += data; process.stdout.write(data); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw Error(`AVPlayer test exited ${code}`);
    const report = JSON.parse(result.trim());
    if (!report.passed) throw Error('AVPlayer did not report success');
    fs.writeFileSync('build/native-video-result.json', JSON.stringify(report, null, 2) + '\n');
  } finally { proxies.forEach(proxy => proxy.close()); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
