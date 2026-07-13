const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// GitHub 备份配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'hiSukura';
const GITHUB_REPO = 'ai-briefing-survey';
const GITHUB_PATH = 'data/submissions.json';
const GITHUB_API = 'https://api.github.com';
const GIT_SYNC_ENABLED = !!GITHUB_TOKEN;

// 解析 JSON body
app.use(express.json({ limit: '1mb' }));

// 静态文件服务 — 托管问卷 HTML
app.use(express.static(path.join(__dirname, 'public')));

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'submissions.json');

// 确保数据文件存在
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}

// ========== GitHub API 工具函数 ==========

function githubRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GITHUB_API + urlPath);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'ai-briefing-survey',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error('GitHub API ' + res.statusCode + ': ' + (json.message || data)));
          }
        } catch (e) {
          reject(new Error('Parse error: ' + data));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 从 GitHub 拉取数据（返回 { data: [], sha: '' }）
async function fetchFromGitHub() {
  const result = await githubRequest('GET', '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_PATH);
  const content = Buffer.from(result.content, 'base64').toString('utf-8');
  return { data: JSON.parse(content), sha: result.sha };
}

// 写数据到 GitHub（需要 sha）
async function pushToGitHub(data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = JSON.stringify({
    message: 'data: ' + new Date().toISOString(),
    content: content,
    sha: sha
  });
  await githubRequest('PUT', '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, body);
}

// 同步到 GitHub（带重试）
async function syncToGitHub() {
  if (!GIT_SYNC_ENABLED) return;
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remote = await fetchFromGitHub();
      await pushToGitHub(data, remote.sha);
      console.log('GitHub sync OK, ' + data.length + ' records');
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000)); // 等1秒重试
    }
  }
  console.error('GitHub sync failed after 3 attempts:', lastErr.message);
}

// 启动时从 GitHub 恢复数据
async function restoreFromGitHub() {
  if (!GIT_SYNC_ENABLED) return;
  try {
    const local = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const remote = await fetchFromGitHub();
    // 用数据较多的版本
    if (remote.data.length > local.length) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(remote.data, null, 2), 'utf-8');
      console.log('Restored ' + remote.data.length + ' records from GitHub');
    } else if (local.length > remote.data.length) {
      console.log('Local has more data, syncing to GitHub...');
      syncToGitHub();
    } else {
      console.log('Data in sync: ' + local.length + ' records');
    }
  } catch (err) {
    console.error('Restore from GitHub failed:', err.message);
  }
}

// ========== API 路由 ==========

// POST /api/submit — 接收问卷提交
app.post('/api/submit', (req, res) => {
  try {
    const submission = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      time: new Date().toISOString(),
      ip: req.ip || req.connection.remoteAddress,
      answers: req.body
    };

    // 读取现有数据
    let data = [];
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      data = JSON.parse(raw);
    } catch (e) {
      data = [];
    }

    // 追加新提交
    data.push(submission);

    // 写回文件
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');

    console.log(`[${new Date().toLocaleString()}] 收到新提交: ${submission.id}`);
    res.json({ success: true, id: submission.id });

    // 异步同步到 GitHub（不阻塞响应）
    syncToGitHub().catch(e => console.error('Async sync error:', e.message));
  } catch (err) {
    console.error('提交失败:', err);
    res.status(500).json({ success: false, error: '服务器内部错误' });
  }
});

// GET /api/results — 查看结果页面（简单密码）
app.get('/api/results', (req, res) => {
  try {
    const pw = req.query.pw || '';
    const PASSWORD = 'aibrief2026';

    if (pw !== PASSWORD) {
      res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>问卷结果</title><style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;margin:0}.card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.1);text-align:center;max-width:360px;width:90%}h2{color:#333;margin-bottom:8px}p{color:#888;font-size:14px}input{border:1px solid #ddd;border-radius:8px;padding:12px;font-size:15px;width:100%;box-sizing:border-box;outline:none;text-align:center}input:focus{border-color:#2b6de8}button{background:#52c41a;color:#fff;border:none;border-radius:8px;padding:12px 32px;font-size:15px;cursor:pointer;margin-top:12px;width:100%}.error{color:#e74c3c;font-size:13px;margin-top:8px}</style></head><body><div class="card"><h2>查看问卷结果</h2><p>请输入访问密码</p><form method="get" action="/api/results"><input type="password" name="pw" placeholder="输入密码" autofocus><button type="submit">查看</button></form><div class="error">'+(pw?'密码错误':'')+'</div></div></body></html>');
      return;
    }

    let data = [];
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) {}

    const labels = ['姓名','岗位','客户数量','发简报频率','按月几号发出','活动周期','平均耗时','是否有SOP','客户清单','模板类型','模板差异','差异体现','前10个指标','常用指标','B端/C端区分','是否环比','是否同比','获取数据方式','统一取数接口','口径书面定义','最难统一部分','期望自动化','AI辅助','总结是否因客户而异','建议是否因客户而异','最希望AI帮什么','最担心AI出问题','对照验证客户','手工样例可提供','评审耗时','最大痛点','本期必须解决问题','调研方式','数据来源说明','客户详细清单','核心指标详细定义','模板详细清单','数据取数链路明细','客户满意度反馈'];

    // 倒序拷贝，不修改原数组
    const reversed = [...data].reverse();

    let html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>问卷结果</title><style>body{font-family:-apple-system,sans-serif;background:#f5f5f5;margin:0;padding:16px;color:#333}.hdr{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.06)}.hdr h2{margin:0 0 4px;font-size:18px}.hdr span{color:#888;font-size:13px}.sub{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.06)}.sub h3{font-size:15px;color:#2b6de8;margin:0 0 12px;border-bottom:1px solid #eee;padding-bottom:8px}.row{display:flex;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:14px}.row:last-child{border-bottom:none}.lbl{color:#888;min-width:140px;flex-shrink:0}.val{color:#1a1a1a;white-space:pre-wrap;word-break:break-all}.emp{color:#ccc}.btns{text-align:center;margin:16px 0 40px}.btn{border:none;border-radius:8px;padding:10px 24px;font-size:14px;cursor:pointer;margin:0 6px}.btn-b{background:#2b6de8;color:#fff}.btn-g{background:#eee;color:#666}</style></head><body><div class="hdr"><h2>问卷提交结果</h2><span>共 '+data.length+' 条 | <a href="/api/results/json?pw='+pw+'">导出JSON</a></span></div>';

    if (data.length === 0) {
      html += '<div class="sub"><p style="color:#888;text-align:center">暂无提交</p></div>';
    } else {
      reversed.forEach(function(s, idx) {
        html += '<div class="sub"><h3>#'+(data.length-idx)+' | '+new Date(s.time).toLocaleString('zh-CN')+'</h3>';
        var answers = s.answers || {};
        for (var i = 0; i < labels.length; i++) {
          var v = answers['q'+(i+1)] || '';
          html += '<div class="row"><div class="lbl">'+labels[i]+'</div><div class="val '+(v?'':'emp')+'">'+(v||'(未填写)')+'</div></div>';
        }
        html += '</div>';
      });
    }

    html += '<div class="btns"><button class="btn btn-b" onclick="location.href=\'/api/results/json?pw='+pw+'\'">导出JSON</button><button class="btn btn-g" onclick="location.reload()">刷新</button></div></body></html>';
    res.send(html);
  } catch (err) {
    console.error('results error:', err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// GET /api/results/json — 导出原始 JSON
app.get('/api/results/json', (req, res) => {
  const pw = req.query.pw || '';
  if (pw !== 'aibrief2026') {
    return res.status(403).json({ error: '密码错误' });
  }
  let data = [];
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {}
  res.json(data);
});

// GET /api/status — 健康检查
app.get('/api/status', (req, res) => {
  let count = 0;
  try {
    count = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')).length;
  } catch (e) {}
  res.json({ status: 'ok', submissions: count, uptime: process.uptime() });
});

// 启动服务
app.listen(PORT, async () => {
  console.log(`问卷后端已启动: http://localhost:${PORT}`);
  console.log(`  - 问卷页面: http://localhost:${PORT}/`);
  console.log(`  - 查看结果: http://localhost:${PORT}/api/results?pw=aibrief2026`);
  console.log(`  - 导出JSON: http://localhost:${PORT}/api/results/json?pw=aibrief2026`);
  console.log(`  - GitHub备份: ${GIT_SYNC_ENABLED ? '已启用' : '未启用（缺少GITHUB_TOKEN）'}`);
  if (GIT_SYNC_ENABLED) {
    await restoreFromGitHub();
  }
});
