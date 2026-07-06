let currentPath = null;
let myChart = null;
let treeRoot = null;
let driveProgressTimers = {};

// -------- 工具函数 --------
function formatSize(bytes) {
    if (bytes >= 1024**4) return (bytes/1024**4).toFixed(2)+' TB';
    if (bytes >= 1024**3) return (bytes/1024**3).toFixed(2)+' GB';
    if (bytes >= 1024**2) return (bytes/1024**2).toFixed(2)+' MB';
    if (bytes >= 1024) return (bytes/1024).toFixed(2)+' KB';
    return bytes + ' B';
}

// -------- ECharts --------
function initChart() {
    if (typeof echarts === 'undefined') {
        console.error('ECharts 未加载，图表功能不可用');
        return;
    }
    myChart = echarts.init(document.getElementById('chart-container'));
    myChart.on('click', async function(params) {
        if (params.data && params.data.type === 'dir') {
            enterDir(params.data.path);
        } else {
            showDetailModal(params.data);
        }
    });
}

function updateChart(data) {
    if (!myChart) return;
    const option = {
        tooltip: {
            trigger: 'item',
            formatter: p => `${p.name}<br/>大小: ${p.data.size_str}`
        },
        series: [{
            type: 'pie',
            radius: ['25%', '65%'],
            data: data.map(item => ({
                value: item.size,
                name: item.name,
                ...item
            })),
            label: { formatter: '{b}: {d}%' },
            emphasis: {
                itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' }
            }
        }]
    };
    myChart.setOption(option, true);
}

// -------- 目录加载 --------
async function loadDirectory(path) {
    currentPath = path;
    document.getElementById('placeholder').classList.add('hidden');
    try {
        const resp = await fetch(`/api/children?path=${encodeURIComponent(path)}`);
        if (!resp.ok) throw new Error('Path not found');
        const data = await resp.json();
        updateChart(data);
    } catch (e) {
        alert('加载目录失败: ' + e.message);
    }
}

function showDetailModal(item) {
    let content = `<h3>${item.name}</h3>`;
    content += `<p>类型: ${item.type}</p>`;
    content += `<p>大小: ${item.size_str} (${item.size} 字节)</p>`;
    if (item.path) content += `<p>路径: ${item.path}</p>`;
    if (item.count) content += `<p>包含 ${item.count} 项</p>`;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content"><span class="modal-close">&times;</span>${content}</div>`;
    modal.querySelector('.modal-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
}

// -------- 树组件（导航式：只显示当前文件夹路径链与直接子项） --------
let treePath = [];   // 路径链，如 ['C:/', 'C:/Users', 'C:/Users/abc']

function buildTree() {
    treePath = [];
    const container = document.getElementById('tree');
    container.innerHTML = '';
    const ul = document.createElement('ul');
    container.appendChild(ul);
    renderTree();
    loadDrives();   // 加载盘符状态
}

let treeRenderId = 0;   // 渲染令牌，防止异步加载竞态导致旧数据污染

function renderTree() {
    const container = document.getElementById('tree');
    container.innerHTML = '';
    treeRoot = container;
    const myId = ++treeRenderId;

    // 根视图：显示“我的电脑” + 盘符列表
    const crumbUl = document.createElement('ul');
    crumbUl.className = 'tree-crumbs';
    if (treePath.length === 0) {
        const rootLi = createTreeNode('我的电脑', null, true, false, () => {
            treePath = [];
            renderTree();
            document.getElementById('btn-root').click();
        });
        rootLi.querySelector('.node').classList.add('root-node');
        const rootIcon = rootLi.querySelector('.icon');
        if (rootIcon) rootIcon.textContent = '🖴';
        crumbUl.appendChild(rootLi);
    } else {
        // 已进入某目录：只显示“当前目录”一行（上级回退用顶部按钮）
        const current = treePath[treePath.length - 1];
        const li = createTreeNode(current, current, true, false, () => {
            enterDir(current);
        });
        li.querySelector('.node').classList.add('root-node');
        const icon = li.querySelector('.icon');
        if (icon) icon.textContent = '📂';
        crumbUl.appendChild(li);
    }
    container.appendChild(crumbUl);

    // 当前目录内容：直接子项列表（独立 ul，统一缩进）
    const contentUl = document.createElement('ul');
    contentUl.className = 'tree-contents';
    container.appendChild(contentUl);
    const current = treePath[treePath.length - 1];
    if (current) {
        loadSubdirs(current, contentUl, true, myId);
    }
}

function createTreeNode(name, path, isDir = true, expanded = false, onClick = null, withChildren = false) {
    const li = document.createElement('li');
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'node';
    if (path) nodeDiv.dataset.path = path;

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.innerHTML = '&#9654;';
    if (expanded) arrow.classList.add('expanded');
    arrow.style.visibility = isDir ? 'visible' : 'hidden';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = isDir ? '📁' : '📄';

    const label = document.createElement('span');
    label.innerHTML = name;   // 使用 innerHTML 以支持传入图标

    nodeDiv.appendChild(arrow);
    nodeDiv.appendChild(icon);
    nodeDiv.appendChild(label);

    li.appendChild(nodeDiv);

    let childUl = null;
    if (withChildren) {
        childUl = document.createElement('ul');
        childUl.style.display = expanded ? 'block' : 'none';
        li.appendChild(childUl);
    }

    // 文本点击：进入该目录（导航式）或执行自定义 onClick
    label.addEventListener('click', e => {
        e.stopPropagation();
        if (onClick) {
            onClick(path);
        } else if (isDir && path) {
            enterDir(path);
        } else if (isDir && !path) {
            if (onClick) onClick(path);
        }
    });

    // 箭头点击：与文本点击一致（导航式无需逐级展开）
    arrow.addEventListener('click', e => {
        e.stopPropagation();
        if (!isDir) return;
        if (onClick) onClick(path);
        else if (path) enterDir(path);
    });

    return li;
}

async function loadSubdirs(path, parentUl, isCurrent = false, renderId = 0) {
    try {
        const resp = await fetch(`/api/subdirs?path=${encodeURIComponent(path)}`);
        const dirs = await resp.json();
        // 渲染令牌校验：若期间发生了新的渲染（如切换目录），丢弃本次结果
        if (renderId !== treeRenderId) return;
        if (!resp.ok) {
            if (isCurrent) {
                const empty = document.createElement('li');
                empty.innerHTML = '<span class="tree-empty">（目录暂未扫描完成）</span>';
                parentUl.appendChild(empty);
            }
            return;
        }
        if (dirs.length === 0 && isCurrent) {
            const empty = document.createElement('li');
            empty.innerHTML = '<span class="tree-empty">（此文件夹内没有子文件夹）</span>';
            parentUl.appendChild(empty);
        }
        dirs.forEach(d => {
            const li = createTreeNode(d.name, d.path, true, false);
            parentUl.appendChild(li);
        });
    } catch (e) {
        console.error(e);
    }
}

// -------- 盘符加载（含状态与进度） --------
async function loadDrives() {
    const resp = await fetch('/api/drives');
    const drives = await resp.json();

    // 仅在“根视图”（未进入任何盘符）时显示盘符列表
    if (treePath.length === 0) {
        const contentUl = document.querySelector('.tree-contents');
        if (!contentUl) return;
        // 移除旧盘符节点
        contentUl.querySelectorAll('.drive-node').forEach(n => n.remove());
        drives.forEach(d => {
            const path = d.label.replace(/\\/g, '/');
            const baseName = `${path} (${d.total_str})`;

            let statusIcon = '🖴';
            if (d.scan_status === 'scanning') statusIcon = '⏳';
            else if (d.scan_status === 'done') statusIcon = '✅';

            let labelContent = `${statusIcon} ${baseName}`;
            if (d.scan_status === 'scanning') {
                labelContent += ` <span class="drive-progress" data-taskid="${d.task_id}">0%</span>`;
            }

            const li = createTreeNode(labelContent, path, true, false, async (p) => {
                if (d.scan_status === 'done') {
                    enterDir(p);
                } else if (d.scan_status === 'scanning') {
                    alert('该磁盘正在后台扫描中，请稍后再试...');
                } else {
                    await startScanAndLoad(p);
                }
            });
            li.classList.add('drive-node');
            contentUl.appendChild(li);

            if (d.scan_status === 'done') {
                const nodeDiv = li.querySelector('.node');
                const refreshBtn = document.createElement('span');
                refreshBtn.className = 'drive-refresh';
                refreshBtn.innerHTML = '🔄';
                refreshBtn.title = '重新扫描该磁盘';
                refreshBtn.addEventListener('click', async e => {
                    e.stopPropagation();
                    refreshBtn.style.pointerEvents = 'none';
                    refreshBtn.textContent = '⏳';
                    try {
                        const r = await fetch('/api/rescan', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path })
                        });
                        const { task_id } = await r.json();
                        startDriveProgressPolling(task_id);
                    } catch (err) {}
                    loadDrives();
                });
                nodeDiv.appendChild(refreshBtn);
            }

            if (d.scan_status === 'scanning' && d.task_id) {
                startDriveProgressPolling(d.task_id);
            }
        });
    }
}

function startDriveProgressPolling(taskId) {
    if (driveProgressTimers[taskId]) clearInterval(driveProgressTimers[taskId]);
    driveProgressTimers[taskId] = setInterval(async () => {
        const span = document.querySelector(`.drive-progress[data-taskid="${taskId}"]`);
        if (!span) {
            clearInterval(driveProgressTimers[taskId]);
            return;
        }
        try {
            const resp = await fetch(`/api/progress/${taskId}`);
            const data = await resp.json();
            if (data.done) {
                span.textContent = '100%';
                clearInterval(driveProgressTimers[taskId]);
                // 可选：自动刷新盘符列表
                loadDrives();
            } else {
                const pct = data.progress === -1 ? '...' : data.progress + '%';
                span.textContent = pct;
            }
        } catch (e) {}
    }, 500);
}

// -------- 扫描与进度 --------
async function startScanAndLoad(rootPath) {
    showProgressOverlay(true);
    const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rootPath })
    });
    const { task_id } = await resp.json();
    await pollProgress(task_id);
    showProgressOverlay(false);
    enterDir(rootPath);
}

// 将绝对路径拆分为导航链，例如 C:/a/b -> ['C:/','C:/a','C:/a/b']
function pathToChain(p) {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    const chain = [];
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
        if (i === 0 && parts[i].length === 2 && parts[i][1] === ':') {
            acc = parts[i] + '/';
        } else {
            acc = acc ? acc + '/' + parts[i] : parts[i];
        }
        chain.push(acc);
    }
    return chain;
}

// 进入某个目录：更新路径链、重绘树、右侧画图
function enterDir(path) {
    treePath = pathToChain(path);
    renderTree();
    loadDirectory(path);
    highlightTreeNode(path);
}

// 回退到上一级
function exitTo() {
    if (treePath.length === 0) return;
    treePath.pop();
    renderTree();
    const parent = treePath[treePath.length - 1];
    if (parent) {
        loadDirectory(parent);
        highlightTreeNode(parent);
    } else {
        document.getElementById('btn-root').click();
    }
}

async function pollProgress(taskId) {
    const textEl = document.getElementById('progress-text');
    const fillEl = document.getElementById('progress-fill');
    while (true) {
        const resp = await fetch(`/api/progress/${taskId}`);
        const data = await resp.json();
        if (data.done) break;
        let display = '';
        if (data.processed_files !== undefined) {
            display = `已扫描 ${data.processed_files} 项 | ${data.current}`;
        } else {
            display = data.current || '扫描中...';
        }
        textEl.textContent = display;
        if (data.progress === -1) {
            fillEl.style.width = '100%';
            fillEl.classList.add('indeterminate');
        } else {
            fillEl.classList.remove('indeterminate');
            fillEl.style.width = data.progress + '%';
        }
        await new Promise(r => setTimeout(r, 300));
    }
}

function showProgressOverlay(show) {
    document.getElementById('progress-overlay').classList.toggle('hidden', !show);
}

function highlightTreeNode(path) {
    document.querySelectorAll('.node.active').forEach(n => n.classList.remove('active'));
    if (!path) return;
    const normalized = path.replace(/\\/g, '\\\\');
    const nodeDiv = document.querySelector(`.node[data-path="${normalized}"]`);
    if (nodeDiv) nodeDiv.classList.add('active');
}

// -------- 顶部按钮 --------
document.getElementById('btn-root').addEventListener('click', () => {
    treePath = [];
    renderTree();
    currentPath = null;
    document.getElementById('placeholder').classList.remove('hidden');
    if (myChart) myChart.clear();
    else document.getElementById('chart-container').innerHTML = '';
    highlightTreeNode(null);
    loadDrives();
});

document.getElementById('btn-up').addEventListener('click', () => {
    exitTo();
});

// -------- 启动阶段全盘扫描进度 --------
async function watchStartupScan() {
    const overlay = document.getElementById('startup-overlay');
    const fill = document.getElementById('startup-fill');
    const text = document.getElementById('startup-text');

    // 等待首个 drives 状态返回
    let drives = [];
    for (let i = 0; i < 20; i++) {
        try {
            const resp = await fetch('/api/drives');
            drives = await resp.json();
            if (drives.length) break;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
    }

    const scanning = drives.filter(d => d.scan_status === 'scanning' && d.task_id);
    if (scanning.length === 0) {
        overlay.classList.add('hidden');
        return;
    }

    overlay.classList.remove('hidden');
    text.textContent = `正在扫描 ${scanning.length} 个磁盘…`;
    const drivesList = document.getElementById('startup-drives');
    drivesList.innerHTML = scanning.map(d =>
        `<div class="startup-drive" data-taskid="${d.task_id}">${d.label}：已扫描 0 个文件</div>`
    ).join('');

    const results = {};
    while (true) {
        let allDone = true;
        let totalPct = 0;
        let known = 0;
        for (const d of scanning) {
            try {
                const resp = await fetch(`/api/progress/${d.task_id}`);
                const data = await resp.json();
                results[d.task_id] = data;
                if (!data.done) allDone = false;
                if (data.progress !== undefined && data.progress !== -1) {
                    totalPct += data.progress;
                    known++;
                }
                const row = drivesList.querySelector(`.startup-drive[data-taskid="${d.task_id}"]`);
                if (row) {
                    const files = data.processed_files !== undefined ? data.processed_files : 0;
                    const mark = data.done ? ' ✓' : '';
                    row.textContent = `${d.label}：已扫描 ${files} 个文件${mark}`;
                }
            } catch (e) {}
        }
        const avg = known ? Math.round(totalPct / known) : (allDone ? 100 : 0);
        fill.style.width = avg + '%';
        const doneCount = scanning.filter(d => results[d.task_id] && results[d.task_id].done).length;
        text.textContent = `正在扫描 ${scanning.length} 个磁盘… (${doneCount}/${scanning.length} 完成, ${avg}%)`;
        if (allDone) break;
        await new Promise(r => setTimeout(r, 500));
    }

    fill.style.width = '100%';
    text.textContent = '扫描完成';
    setTimeout(() => {
        overlay.classList.add('hidden');
        loadDrives();   // 刷新盘符状态为 ✅
    }, 400);
}

// -------- 清理 --------
window.addEventListener('beforeunload', () => {
    Object.values(driveProgressTimers).forEach(clearInterval);
});

// -------- 启动 --------
window.onload = function () {
    initChart();
    buildTree();
    document.getElementById('placeholder').classList.remove('hidden');
    watchStartupScan();
};